import { Router } from 'express';
import { query } from '../services/database.js';
import { 
  findOverlappingTrails, 
  snapTrailToTrail, 
  snapClusterToCanonical,
  autoSnapAllClusters 
} from '../services/trailSnapping.js';
import { removeSpikes, removeSpikesIterative } from '../services/spikeRemoval.js';

const router = Router();

/**
 * GET /api/snap-trails/overlapping/:trailId
 * Find trails that overlap with the given trail
 */
router.get('/overlapping/:trailId', async (req, res, next) => {
  try {
    const { trailId } = req.params;
    const { tolerance = 30 } = req.query;
    
    const overlapping = await findOverlappingTrails(trailId, parseFloat(tolerance));
    
    res.json({
      success: true,
      trailId,
      overlappingTrails: overlapping
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/snap-trails/to-trail
 * Snap one trail to another (reference) trail
 */
router.post('/to-trail', async (req, res, next) => {
  try {
    const { sourceTrailId, referenceTrailId, tolerance = 30 } = req.body;
    
    if (!sourceTrailId || !referenceTrailId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'sourceTrailId and referenceTrailId required' }
      });
    }
    
    const result = await snapTrailToTrail(sourceTrailId, referenceTrailId, tolerance);
    
    // Save the snapped geometry
    await query(`
      UPDATE trail_edits 
      SET edited_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
          status = 'in_progress',
          updated_at = NOW()
      WHERE id = $1
    `, [sourceTrailId, JSON.stringify(result.geometry)]);
    
    res.json({
      success: true,
      sourceTrailId,
      referenceTrailId,
      pointsSnapped: result.pointsSnapped,
      totalPoints: result.totalPoints,
      snapPercent: Math.round(result.pointsSnapped / result.totalPoints * 100)
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/snap-trails/cluster
 * Snap all trails in a cluster to a reference trail
 */
router.post('/cluster', async (req, res, next) => {
  try {
    const { trailIds, referenceTrailId, tolerance = 30 } = req.body;
    
    if (!trailIds || trailIds.length < 2) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailIds (min 2) required' }
      });
    }
    
    // If no reference provided, use the trail with most vertices
    let refId = referenceTrailId;
    if (!refId) {
      const refResult = await query(`
        SELECT id FROM trail_edits 
        WHERE id = ANY($1)
        ORDER BY ST_NPoints(COALESCE(edited_geometry, original_geometry)) DESC
        LIMIT 1
      `, [trailIds]);
      refId = refResult.rows[0]?.id;
    }
    
    const results = await snapClusterToCanonical(trailIds, refId, tolerance);
    
    res.json({
      success: true,
      referenceTrailId: refId,
      snappedTrails: results
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/snap-trails/clusters
 * Auto-detect all overlapping trail clusters
 */
router.get('/clusters', async (req, res, next) => {
  try {
    const { tolerance = 30, minOverlap = 20 } = req.query;
    
    const clusters = await autoSnapAllClusters(
      parseFloat(tolerance), 
      parseFloat(minOverlap)
    );
    
    // Get trail names for each cluster
    const enrichedClusters = await Promise.all(clusters.map(async (trailIds, idx) => {
      const namesResult = await query(`
        SELECT id, trail_name, ST_NPoints(original_geometry) as vertex_count
        FROM trail_edits WHERE id = ANY($1)
        ORDER BY vertex_count DESC
      `, [trailIds]);
      
      return {
        clusterId: idx + 1,
        trailCount: trailIds.length,
        trails: namesResult.rows,
        suggestedReference: namesResult.rows[0]?.id // Most detailed
      };
    }));
    
    res.json({
      success: true,
      clusterCount: clusters.length,
      clusters: enrichedClusters
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/snap-trails/auto-all
 * Automatically snap all detected clusters
 */
router.post('/auto-all', async (req, res, next) => {
  try {
    const { tolerance = 30, minOverlap = 20 } = req.body;
    
    const clusters = await autoSnapAllClusters(
      parseFloat(tolerance), 
      parseFloat(minOverlap)
    );
    
    const allResults = [];
    
    for (const trailIds of clusters) {
      // Find most detailed trail as reference
      const refResult = await query(`
        SELECT id FROM trail_edits 
        WHERE id = ANY($1)
        ORDER BY ST_NPoints(COALESCE(edited_geometry, original_geometry)) DESC
        LIMIT 1
      `, [trailIds]);
      
      const refId = refResult.rows[0]?.id;
      const results = await snapClusterToCanonical(trailIds, refId, tolerance);
      
      allResults.push({
        referenceTrailId: refId,
        clusterSize: trailIds.length,
        snappedTrails: results
      });
    }
    
    res.json({
      success: true,
      clustersProcessed: clusters.length,
      results: allResults
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/snap-trails/remove-spikes
 * Remove spike artifacts from a trail (second pass cleanup)
 */
router.post('/remove-spikes', async (req, res, next) => {
  try {
    const { 
      trailId, 
      maxDeviation = 10,  // Max deviation in meters from line between neighbors
      iterative = true  // Run multiple passes until no spikes found
    } = req.body;
    
    if (!trailId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'trailId required' }
      });
    }
    
    let result;
    if (iterative) {
      result = await removeSpikesIterative(trailId, maxDeviation);
    } else {
      result = await removeSpikes(trailId, maxDeviation);
      
      // Save the result
      await query(`
        UPDATE trail_edits 
        SET edited_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
            updated_at = NOW()
        WHERE id = $1
      `, [trailId, JSON.stringify(result.geometry)]);
    }
    
    res.json({
      success: true,
      trailId,
      ...result
    });
  } catch (err) {
    next(err);
  }
});

export default router;
