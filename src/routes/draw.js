import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../services/database.js';
import { snapToNHD, snapToNHDExact, traceNHD, consolidateTrails } from '../services/geometry.js';

const router = Router();

/**
 * Helper: Save operation to history
 */
async function saveOperation(trailId, operationType, params, geomBefore, geomAfter) {
  await query(`
    INSERT INTO edit_operations (trail_id, operation_type, params, geometry_before, geometry_after)
    VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))
  `, [trailId, operationType, JSON.stringify(params), JSON.stringify(geomBefore), JSON.stringify(geomAfter)]);
}

/**
 * Helper: Update trail geometry
 */
async function updateTrailGeometry(trailId, newGeometry) {
  await query(`
    UPDATE trail_edits
    SET 
      edited_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
      status = 'in_progress',
      updated_at = NOW()
    WHERE id = $1
  `, [trailId, JSON.stringify(newGeometry)]);
}

/**
 * POST /api/draw/line
 * Draw a new line geometry for a trail
 */
router.post('/line', async (req, res, next) => {
  try {
    const {
      trailId,
      coordinates,
      mode = 'replace',
      snapToNHD: shouldSnap = false,
      snapTolerance = 50
    } = req.body;
    
    if (!trailId || !coordinates || coordinates.length < 2) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailId and coordinates (min 2) required' }
      });
    }
    
    // Get current geometry
    const currentResult = await query(`
      SELECT ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry
      FROM trail_edits WHERE id = $1
    `, [trailId]);
    
    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: `Trail ${trailId} not found` }
      });
    }
    
    const currentGeometry = currentResult.rows[0].geometry;
    
    // Build new geometry
    let newGeometry = {
      type: 'LineString',
      coordinates
    };
    
    if (mode === 'append') {
      newGeometry.coordinates = [...currentGeometry.coordinates, ...coordinates];
    } else if (mode === 'prepend') {
      newGeometry.coordinates = [...coordinates, ...currentGeometry.coordinates];
    }
    
    // Snap if requested
    if (shouldSnap) {
      // Find nearby NHD
      const nhdResult = await query(`
        SELECT array_agg(id) as nhd_ids
        FROM river_edges
        WHERE ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography,
          $2
        )
      `, [JSON.stringify(newGeometry), snapTolerance * 2]);
      
      const nhdIds = nhdResult.rows[0]?.nhd_ids || [];
      if (nhdIds.length > 0) {
        newGeometry = await snapToNHD(newGeometry, nhdIds, snapTolerance);
      }
    }
    
    // Save operation
    await saveOperation(trailId, 'draw_line', { mode, snapToNHD: shouldSnap }, currentGeometry, newGeometry);
    
    // Update geometry
    await updateTrailGeometry(trailId, newGeometry);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:updated', { trailId, operation: 'draw_line' });
    
    res.json({
      success: true,
      operation: {
        id: uuidv4(),
        type: 'draw_line',
        inputVertices: coordinates.length,
        outputVertices: newGeometry.coordinates.length
      },
      trail: {
        id: trailId,
        editedGeometry: newGeometry
      }
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/snap
 * Snap trail to NHD segments
 * mode: 'vertex' (snap each vertex to nearest NHD point) or 'exact' (use NHD line directly)
 * nhdIds: optional - if not provided, auto-detects ALL nearby NHD segments
 */
router.post('/snap', async (req, res, next) => {
  try {
    let {
      trailId,
      nhdIds,
      mode = 'exact', // Default to exact mode for best results
      tolerance = 100 // Increased default tolerance
    } = req.body;
    
    if (!trailId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailId required' }
      });
    }
    
    // Auto-detect NHD if not provided
    if (!nhdIds || nhdIds.length === 0) {
      const autoResult = await query(`
        SELECT array_agg(r.id) as nhd_ids
        FROM river_edges r
        JOIN trail_edits t ON ST_DWithin(r.geom::geography, t.original_geometry::geography, $2)
        WHERE t.id = $1
      `, [trailId, tolerance * 2]);
      
      nhdIds = autoResult.rows[0]?.nhd_ids || [];
      
      if (nhdIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_NHD_NEARBY', message: `No NHD segments found within ${tolerance * 2}m of trail` }
        });
      }
    }
    
    // Get current geometry
    const currentResult = await query(`
      SELECT ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry
      FROM trail_edits WHERE id = $1
    `, [trailId]);
    
    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: `Trail ${trailId} not found` }
      });
    }
    
    const currentGeometry = currentResult.rows[0].geometry;
    
    // Use appropriate snap method
    let snappedGeometry;
    if (mode === 'exact') {
      // Use NHD line directly - follows the river exactly
      snappedGeometry = await snapToNHDExact(currentGeometry, nhdIds, tolerance);
    } else {
      // Snap each vertex to nearest point on NHD
      snappedGeometry = await snapToNHD(currentGeometry, nhdIds, tolerance);
    }
    
    // Save operation
    await saveOperation(trailId, 'snap_to_nhd', { nhdIds, tolerance, mode }, currentGeometry, snappedGeometry);
    
    // Update geometry
    await updateTrailGeometry(trailId, snappedGeometry);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:updated', { trailId, operation: 'snap_to_nhd' });
    
    res.json({
      success: true,
      operation: {
        id: uuidv4(),
        type: 'snap_to_nhd',
        mode,
        nhdIds,
        resultingGeometry: snappedGeometry
      }
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/trace
 * Trace along NHD from point A to point B
 */
router.post('/trace', async (req, res, next) => {
  try {
    const {
      trailId,
      startPoint,
      endPoint,
      nhdIds,
      appendTo = 'replace'
    } = req.body;
    
    if (!startPoint || !endPoint || !nhdIds || nhdIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'startPoint, endPoint, and nhdIds required' }
      });
    }
    
    // Get current geometry
    const currentResult = await query(`
      SELECT ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry
      FROM trail_edits WHERE id = $1
    `, [trailId]);
    
    const currentGeometry = currentResult.rows[0]?.geometry;
    
    // Trace NHD
    const tracedGeometry = await traceNHD(startPoint, endPoint, nhdIds);
    
    let finalGeometry = tracedGeometry;
    
    // Append/prepend if needed
    if (appendTo === 'end' && currentGeometry) {
      finalGeometry = {
        type: 'LineString',
        coordinates: [...currentGeometry.coordinates, ...tracedGeometry.coordinates]
      };
    } else if (appendTo === 'start' && currentGeometry) {
      finalGeometry = {
        type: 'LineString',
        coordinates: [...tracedGeometry.coordinates, ...currentGeometry.coordinates]
      };
    }
    
    if (trailId) {
      // Save operation
      await saveOperation(trailId, 'trace_nhd', { startPoint, endPoint, nhdIds }, currentGeometry, finalGeometry);
      
      // Update geometry
      await updateTrailGeometry(trailId, finalGeometry);
      
      // Notify via WebSocket
      const io = req.app.get('io');
      io.emit('trail:updated', { trailId, operation: 'trace_nhd' });
    }
    
    res.json({
      success: true,
      operation: {
        id: uuidv4(),
        type: 'trace_nhd',
        tracedNHDIds: nhdIds,
        resultingGeometry: finalGeometry
      }
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/consolidate
 * Merge multiple trails into one
 */
router.post('/consolidate', async (req, res, next) => {
  try {
    const {
      sourceTrailIds,
      targetTrailId,
      method = 'nhd_aligned',
      markOthersAs = 'skipped'
    } = req.body;
    
    if (!sourceTrailIds || sourceTrailIds.length < 2 || !targetTrailId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'sourceTrailIds (min 2) and targetTrailId required' }
      });
    }
    
    // Consolidate
    const consolidatedGeometry = await consolidateTrails(sourceTrailIds, targetTrailId, method);
    
    // Update target trail
    await updateTrailGeometry(targetTrailId, consolidatedGeometry);
    
    // Mark other trails as skipped
    const otherTrailIds = sourceTrailIds.filter(id => id !== targetTrailId);
    if (markOthersAs === 'skipped') {
      await query(`
        UPDATE trail_edits
        SET status = 'skipped', updated_at = NOW()
        WHERE id = ANY($1)
      `, [otherTrailIds]);
    }
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trails:consolidated', { targetTrailId, sourceTrailIds });
    
    res.json({
      success: true,
      consolidatedTrail: {
        id: targetTrailId,
        editedGeometry: consolidatedGeometry,
        sourceTrails: sourceTrailIds
      },
      skippedTrails: otherTrailIds
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/undo
 * Undo the last operation
 */
router.post('/undo', async (req, res, next) => {
  try {
    const { trailId } = req.body;
    
    // Get last operation
    const opResult = await query(`
      SELECT id, operation_type, ST_AsGeoJSON(geometry_before)::json as geometry_before
      FROM edit_operations
      WHERE trail_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [trailId]);
    
    if (opResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_OPERATIONS', message: 'No operations to undo' }
      });
    }
    
    const op = opResult.rows[0];
    
    // Restore geometry
    await query(`
      UPDATE trail_edits
      SET edited_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
          updated_at = NOW()
      WHERE id = $1
    `, [trailId, JSON.stringify(op.geometry_before)]);
    
    // Delete operation
    await query(`DELETE FROM edit_operations WHERE id = $1`, [op.id]);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:updated', { trailId, operation: 'undo' });
    
    res.json({
      success: true,
      undoneOperation: {
        id: op.id,
        type: op.operation_type
      },
      restoredGeometry: op.geometry_before
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/snap-portage
 * Snap trail to Mapbox basemap path features
 */
router.post('/snap-portage', async (req, res, next) => {
  try {
    const { trailId, pathGeometries, tolerance = 50 } = req.body;
    
    if (!trailId || !pathGeometries || pathGeometries.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailId and pathGeometries required' }
      });
    }
    
    // Get current trail geometry
    const currentResult = await query(`
      SELECT 
        ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry,
        ST_NPoints(COALESCE(edited_geometry, original_geometry)) as point_count
      FROM trail_edits WHERE id = $1
    `, [trailId]);
    
    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: `Trail ${trailId} not found` }
      });
    }
    
    const oldGeometry = currentResult.rows[0].geometry;
    const totalPoints = currentResult.rows[0].point_count;
    
    // Combine all path geometries into a single MultiLineString for snapping
    const pathCollection = {
      type: 'GeometryCollection',
      geometries: pathGeometries
    };
    
    // Snap using PostGIS - project each vertex to nearest point on paths
    const snapResult = await query(`
      WITH trail AS (
        SELECT COALESCE(edited_geometry, original_geometry) as geom 
        FROM trail_edits WHERE id = $1
      ),
      paths AS (
        SELECT ST_Collect(
          ST_SetSRID(ST_GeomFromGeoJSON(g::text), 4326)
        ) as geom
        FROM jsonb_array_elements($2::jsonb) as g
      ),
      -- Densify trail first
      densified AS (
        SELECT ST_Segmentize(t.geom::geography, 10)::geometry as geom
        FROM trail t
      ),
      -- Extract vertices
      vertices AS (
        SELECT 
          row_number() OVER () as idx,
          (ST_DumpPoints(d.geom)).geom as pt
        FROM densified d
      ),
      -- Snap each vertex to paths if within tolerance
      snapped AS (
        SELECT 
          v.idx,
          v.pt as original_pt,
          ST_ClosestPoint(p.geom, v.pt) as path_pt,
          ST_Distance(v.pt::geography, p.geom::geography) as dist_m
        FROM vertices v, paths p
      ),
      -- Apply snapping
      result_pts AS (
        SELECT 
          idx,
          CASE WHEN dist_m <= $3 THEN path_pt ELSE original_pt END as final_pt,
          dist_m <= $3 as was_snapped
        FROM snapped
        ORDER BY idx
      )
      SELECT 
        ST_AsGeoJSON(
          ST_RemoveRepeatedPoints(
            ST_MakeLine(array_agg(final_pt ORDER BY idx)),
            0.000005
          )
        )::json as snapped_geometry,
        SUM(CASE WHEN was_snapped THEN 1 ELSE 0 END) as points_snapped,
        COUNT(*) as total_points
      FROM result_pts
    `, [trailId, JSON.stringify(pathGeometries), tolerance]);
    
    const newGeometry = snapResult.rows[0].snapped_geometry;
    const pointsSnapped = parseInt(snapResult.rows[0].points_snapped);
    
    // Save operation history
    await saveOperation(trailId, 'snap_portage', { tolerance, pathCount: pathGeometries.length }, oldGeometry, newGeometry);
    
    // Update geometry
    await updateTrailGeometry(trailId, newGeometry);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:updated', { trailId, operation: 'snap_portage' });
    
    res.json({
      success: true,
      trailId,
      pointsSnapped,
      totalPoints: parseInt(snapResult.rows[0].total_points),
      pathsUsed: pathGeometries.length
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/create
 * Create a new trail with geometry
 */
router.post('/create', async (req, res, next) => {
  try {
    const { trailId, trailName, geometry } = req.body;
    
    if (!trailName || !geometry) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailName and geometry required' }
      });
    }
    
    // Generate ID if not provided
    const id = trailId || `trail_${Date.now()}`;
    
    // Check if ID already exists
    const existingResult = await query(`SELECT id FROM trail_edits WHERE id = $1`, [id]);
    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'ID_EXISTS', message: `Trail ID ${id} already exists` }
      });
    }
    
    // Get current session
    const sessionResult = await query(`
      SELECT id FROM edit_sessions ORDER BY created_at DESC LIMIT 1
    `);
    const sessionId = sessionResult.rows[0]?.id;
    
    // Insert new trail
    await query(`
      INSERT INTO trail_edits (id, session_id, trail_name, status, original_geometry, created_at, updated_at)
      VALUES ($1, $2, $3, 'pending', ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), NOW(), NOW())
    `, [id, sessionId, trailName, JSON.stringify(geometry)]);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:created', { trailId: id, trailName });
    
    res.json({
      success: true,
      trail: {
        id,
        name: trailName,
        vertexCount: geometry.coordinates ? geometry.coordinates.length : 0
      }
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/simplify
 * Simplify trail geometry (reduce vertices)
 */
router.post('/simplify', async (req, res, next) => {
  try {
    const { trailId, tolerance = 50 } = req.body;
    
    if (!trailId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailId required' }
      });
    }
    
    // Get current geometry and point count
    const currentResult = await query(`
      SELECT 
        ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry,
        ST_NPoints(COALESCE(edited_geometry, original_geometry)) as point_count
      FROM trail_edits WHERE id = $1
    `, [trailId]);
    
    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: `Trail ${trailId} not found` }
      });
    }
    
    const oldGeometry = currentResult.rows[0].geometry;
    const originalPoints = currentResult.rows[0].point_count;
    
    // Convert tolerance from meters to degrees (approximate)
    const toleranceDegrees = tolerance / 111000;
    
    // Simplify and get new geometry
    const simplifyResult = await query(`
      SELECT 
        ST_AsGeoJSON(ST_Simplify(
          COALESCE(edited_geometry, original_geometry),
          $2
        ))::json as geometry,
        ST_NPoints(ST_Simplify(
          COALESCE(edited_geometry, original_geometry),
          $2
        )) as point_count
      FROM trail_edits WHERE id = $1
    `, [trailId, toleranceDegrees]);
    
    const newGeometry = simplifyResult.rows[0].geometry;
    const newPoints = simplifyResult.rows[0].point_count;
    
    // Save operation history
    await saveOperation(trailId, 'simplify', { tolerance }, oldGeometry, newGeometry);
    
    // Update geometry
    await updateTrailGeometry(trailId, newGeometry);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:updated', { trailId, operation: 'simplify' });
    
    res.json({
      success: true,
      trailId,
      originalPoints,
      newPoints,
      reduction: Math.round((1 - newPoints / originalPoints) * 100) + '%'
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/draw/update-geometry
 * Update trail geometry (from manual editing)
 */
router.post('/update-geometry', async (req, res, next) => {
  try {
    const { trailId, geometry } = req.body;
    
    if (!trailId || !geometry) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailId and geometry required' }
      });
    }
    
    // Get current geometry for undo
    const currentResult = await query(`
      SELECT ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry
      FROM trail_edits WHERE id = $1
    `, [trailId]);
    
    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: `Trail ${trailId} not found` }
      });
    }
    
    const oldGeometry = currentResult.rows[0].geometry;
    
    // Save operation history
    await saveOperation(trailId, 'manual_edit', {}, oldGeometry, geometry);
    
    // Update geometry
    await updateTrailGeometry(trailId, geometry);
    
    // Notify via WebSocket
    const io = req.app.get('io');
    io.emit('trail:updated', { trailId, operation: 'manual_edit' });
    
    res.json({
      success: true,
      trailId,
      vertexCount: geometry.coordinates ? geometry.coordinates.length : 0
    });
    
  } catch (err) {
    next(err);
  }
});

export default router;
