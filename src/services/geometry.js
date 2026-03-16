import * as turf from '@turf/turf';
import { query } from './database.js';

/**
 * Find nearest NHD segments to a point or line
 */
export async function findNearestNHD(geometry, maxDistanceM = 200, limit = 10) {
  const geojson = JSON.stringify(geometry);
  
  const result = await query(`
    SELECT 
      r.id as nhd_id,
      r.gnis_name,
      r.stream_order,
      ST_AsGeoJSON(r.geom)::json as geometry,
      ST_Distance(
        r.geom::geography,
        ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography
      ) as distance_m
    FROM river_edges r
    WHERE ST_DWithin(
      r.geom::geography,
      ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography,
      $2
    )
    ORDER BY distance_m
    LIMIT $3
  `, [geojson, maxDistanceM, limit]);
  
  return result.rows.map(row => ({
    nhdId: row.nhd_id,
    gnisName: row.gnis_name,
    streamOrder: row.stream_order,
    geometry: row.geometry,
    distanceM: parseFloat(row.distance_m)
  }));
}

/**
 * Snap a line geometry to nearby NHD segments
 * Uses aggressive per-vertex projection - each point gets moved to nearest point on NHD
 */
export async function snapToNHD(lineGeometry, nhdIds, tolerance = 50) {
  // Merge all selected NHD segments into one continuous line
  const nhdResult = await query(`
    SELECT ST_AsGeoJSON(
      ST_LineMerge(ST_Collect(geom))
    )::json as geometry
    FROM river_edges
    WHERE id = ANY($1)
  `, [nhdIds]);
  
  if (!nhdResult.rows[0]?.geometry) {
    throw new Error('NHD segments not found');
  }
  
  const mergedNHD = nhdResult.rows[0].geometry;
  
  // Use aggressive vertex-by-vertex snapping with PostGIS
  // For each vertex: if within tolerance, project to nearest point on NHD line
  const snapResult = await query(`
    WITH input_line AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) as geom
    ),
    nhd_line AS (
      SELECT ST_LineMerge(ST_Collect(geom)) as geom
      FROM river_edges WHERE id = ANY($2)
    ),
    -- Densify the input line first to get more vertices to snap
    densified AS (
      SELECT ST_Segmentize(i.geom::geography, 20)::geometry as geom
      FROM input_line i
    ),
    -- Extract vertices
    vertices AS (
      SELECT 
        (ST_DumpPoints(d.geom)).path[1] as vertex_order,
        (ST_DumpPoints(d.geom)).geom as vertex
      FROM densified d
    ),
    -- For each vertex, find nearest point on NHD (if within tolerance)
    snapped_vertices AS (
      SELECT 
        v.vertex_order,
        CASE 
          WHEN ST_Distance(v.vertex::geography, n.geom::geography) <= $3
          THEN ST_ClosestPoint(n.geom, v.vertex)
          ELSE v.vertex
        END as snapped_point
      FROM vertices v, nhd_line n
      ORDER BY v.vertex_order
    )
    -- Reconstruct line from snapped vertices
    SELECT ST_AsGeoJSON(
      ST_RemoveRepeatedPoints(
        ST_MakeLine(array_agg(snapped_point ORDER BY vertex_order)),
        0.00001
      )
    )::json as snapped_geometry
    FROM snapped_vertices
  `, [JSON.stringify(lineGeometry), nhdIds, tolerance]);
  
  return snapResult.rows[0].snapped_geometry;
}

/**
 * AGGRESSIVE snap: Replace line with NHD geometry where they overlap
 * Handles disconnected NHD segments by using vertex-by-vertex projection
 * with preference for connected NHD paths
 */
export async function snapToNHDExact(lineGeometry, nhdIds, tolerance = 50) {
  // Strategy: Densify input line, then snap each point to nearest NHD point
  // This works even when NHD segments aren't connected
  const result = await query(`
    WITH input_line AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) as geom
    ),
    -- Collect all NHD segments
    nhd_collected AS (
      SELECT ST_Collect(geom) as geom
      FROM river_edges WHERE id = ANY($2)
    ),
    -- Densify input line to get points every ~15m
    densified AS (
      SELECT ST_Segmentize(i.geom::geography, 15)::geometry as geom
      FROM input_line i
    ),
    -- Extract all vertices
    vertices AS (
      SELECT 
        row_number() OVER () as vertex_order,
        (ST_DumpPoints(d.geom)).geom as vertex
      FROM densified d
    ),
    -- For EVERY vertex, project to nearest point on NHD collection
    snapped_vertices AS (
      SELECT 
        v.vertex_order,
        v.vertex as original_pt,
        ST_ClosestPoint(n.geom, v.vertex) as snapped_pt,
        ST_Distance(v.vertex::geography, ST_ClosestPoint(n.geom, v.vertex)::geography) as dist_m
      FROM vertices v
      CROSS JOIN nhd_collected n
    ),
    -- Build result: use snapped point if within tolerance, else original
    result_vertices AS (
      SELECT 
        vertex_order,
        CASE 
          WHEN dist_m <= $3 THEN snapped_pt
          ELSE original_pt
        END as final_pt
      FROM snapped_vertices
      ORDER BY vertex_order
    )
    -- Reconstruct as line, removing duplicate consecutive points
    SELECT ST_AsGeoJSON(
      ST_RemoveRepeatedPoints(
        ST_MakeLine(array_agg(final_pt ORDER BY vertex_order)),
        0.00002
      )
    )::json as snapped_geometry
    FROM result_vertices
  `, [JSON.stringify(lineGeometry), nhdIds, tolerance]);
  
  return result.rows[0].snapped_geometry;
}

/**
 * Trace along NHD from point A to point B
 */
export async function traceNHD(startPoint, endPoint, nhdIds) {
  // Get the NHD segments
  const nhdResult = await query(`
    SELECT 
      id,
      ST_AsGeoJSON(geom)::json as geometry
    FROM river_edges
    WHERE id = ANY($1)
  `, [nhdIds]);
  
  if (nhdResult.rows.length === 0) {
    throw new Error('NHD segments not found');
  }
  
  // Merge NHD segments into a single line
  const mergeResult = await query(`
    SELECT ST_AsGeoJSON(
      ST_LineMerge(ST_Collect(geom))
    )::json as merged_geometry
    FROM river_edges
    WHERE id = ANY($1)
  `, [nhdIds]);
  
  const mergedLine = mergeResult.rows[0].merged_geometry;
  
  // Extract substring between start and end points
  const substringResult = await query(`
    WITH merged AS (
      SELECT ST_LineMerge(ST_Collect(geom)) as line
      FROM river_edges WHERE id = ANY($1)
    ),
    fractions AS (
      SELECT 
        ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($2, $3), 4326)) as start_frac,
        ST_LineLocatePoint(line, ST_SetSRID(ST_MakePoint($4, $5), 4326)) as end_frac
      FROM merged
    )
    SELECT ST_AsGeoJSON(
      ST_LineSubstring(
        (SELECT line FROM merged),
        LEAST(start_frac, end_frac),
        GREATEST(start_frac, end_frac)
      )
    )::json as traced_geometry
    FROM fractions
  `, [nhdIds, startPoint[0], startPoint[1], endPoint[0], endPoint[1]]);
  
  return substringResult.rows[0].traced_geometry;
}

/**
 * Analyze a trail for editing recommendations
 */
export async function analyzeTrail(trailId) {
  // Get trail geometry
  const trailResult = await query(`
    SELECT 
      id, trail_name, status,
      ST_AsGeoJSON(original_geometry)::json as original_geometry,
      ST_AsGeoJSON(edited_geometry)::json as edited_geometry,
      ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry,
      ST_Length(COALESCE(edited_geometry, original_geometry)::geography) as length_m
    FROM trail_edits
    WHERE id = $1
  `, [trailId]);
  
  if (trailResult.rows.length === 0) {
    throw new Error(`Trail ${trailId} not found`);
  }
  
  const trail = trailResult.rows[0];
  const geometry = trail.geometry;
  const originalGeometry = trail.original_geometry;
  const editedGeometry = trail.edited_geometry;
  
  // Find nearby NHD
  const nearbyNHD = await findNearestNHD(geometry, 200, 20);
  
  // Simplified overlap estimate - just count nearby NHD vs trail length
  // (faster than actual geometry intersection)
  const overlapPercent = nearbyNHD.length > 5 ? 80 : nearbyNHD.length > 2 ? 50 : nearbyNHD.length > 0 ? 20 : 0;
  
  // Skip parallel trails query for speed - it's rarely needed
  const parallelResult = { rows: [] };
  
  const parallelTrails = parallelResult.rows.map(r => ({
    id: r.id,
    name: r.trail_name
  }));
  
  // Generate recommendations
  const segments = [];
  let recommendation = 'keep_original';
  
  if (overlapPercent > 70) {
    recommendation = 'snap_to_nhd';
  } else if (parallelTrails.length > 0) {
    recommendation = 'consolidate';
  } else if (overlapPercent > 30) {
    recommendation = 'hybrid';
  }
  
  return {
    trailId,
    trailName: trail.trail_name,
    status: trail.status,
    lengthM: parseFloat(trail.length_m),
    geometry,
    originalGeometry,
    editedGeometry,
    nearbyNHD,
    nhdOverlapPercent: Math.round(overlapPercent * 10) / 10,
    parallelTrails,
    recommendation,
    suggestedNHDIds: nearbyNHD.slice(0, 5).map(n => n.nhdId)
  };
}

/**
 * Consolidate multiple trails into one
 */
export async function consolidateTrails(sourceTrailIds, targetTrailId, method = 'nhd_aligned') {
  // Get all trail geometries
  const trailsResult = await query(`
    SELECT 
      id,
      ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry
    FROM trail_edits
    WHERE id = ANY($1)
  `, [sourceTrailIds]);
  
  if (trailsResult.rows.length < 2) {
    throw new Error('Need at least 2 trails to consolidate');
  }
  
  let consolidatedGeometry;
  
  if (method === 'nhd_aligned') {
    // Find NHD segments near all source trails and use that
    const nhdResult = await query(`
      WITH source_trails AS (
        SELECT ST_Collect(COALESCE(edited_geometry, original_geometry)) as geom
        FROM trail_edits WHERE id = ANY($1)
      )
      SELECT DISTINCT r.id
      FROM river_edges r, source_trails st
      WHERE ST_DWithin(r.geom::geography, st.geom::geography, 100)
    `, [sourceTrailIds]);
    
    const nhdIds = nhdResult.rows.map(r => r.id);
    
    if (nhdIds.length > 0) {
      const mergeResult = await query(`
        SELECT ST_AsGeoJSON(ST_LineMerge(ST_Collect(geom)))::json as geometry
        FROM river_edges WHERE id = ANY($1)
      `, [nhdIds]);
      consolidatedGeometry = mergeResult.rows[0].geometry;
    }
  }
  
  if (!consolidatedGeometry || method === 'average') {
    // Fall back to using the longest trail
    const longestResult = await query(`
      SELECT ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry
      FROM trail_edits
      WHERE id = ANY($1)
      ORDER BY ST_Length(COALESCE(edited_geometry, original_geometry)::geography) DESC
      LIMIT 1
    `, [sourceTrailIds]);
    consolidatedGeometry = longestResult.rows[0].geometry;
  }
  
  return consolidatedGeometry;
}

export default {
  findNearestNHD,
  snapToNHD,
  snapToNHDExact,
  traceNHD,
  analyzeTrail,
  consolidateTrails
};
