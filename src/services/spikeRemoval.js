import { query } from './database.js';

/**
 * Remove spike artifacts from a trail geometry
 * Spikes are points that deviate significantly from the line between neighbors
 */
export async function removeSpikes(trailId, maxDeviationM = 15, minBaseDistM = 5) {
  const result = await query(`
    WITH trail AS (
      SELECT COALESCE(edited_geometry, original_geometry) as geom 
      FROM trail_edits WHERE id = $1
    ),
    -- Extract vertices with indices using proper path extraction
    pts AS (
      SELECT 
        (dp).path[1] as idx,
        (dp).geom as pt
      FROM (
        SELECT ST_DumpPoints(t.geom) as dp FROM trail t
      ) sub
    ),
    total_count AS (
      SELECT MAX(idx) as cnt FROM pts
    ),
    -- Calculate deviation from line between prev and next neighbors
    with_deviation AS (
      SELECT 
        p.idx,
        p.pt,
        ST_Distance(p.pt::geography, ST_MakeLine(prev.pt, nxt.pt)::geography) as deviation_m,
        ST_Distance(prev.pt::geography, nxt.pt::geography) as base_dist_m
      FROM pts p
      JOIN pts prev ON prev.idx = p.idx - 1
      JOIN pts nxt ON nxt.idx = p.idx + 1
    ),
    -- Identify spikes: significant deviation relative to short base
    spike_detection AS (
      SELECT 
        idx,
        pt,
        deviation_m,
        base_dist_m,
        -- A spike has: high deviation AND base is reasonably short (not a real turn)
        (deviation_m > $2 AND base_dist_m < deviation_m * 3) as is_spike
      FROM with_deviation
    ),
    -- Keep only non-spike vertices (plus first and last which weren't analyzed)
    kept_vertices AS (
      -- First vertex (always keep)
      SELECT idx, pt FROM pts WHERE idx = 1
      UNION ALL
      -- Middle vertices that aren't spikes
      SELECT idx, pt FROM spike_detection WHERE NOT is_spike
      UNION ALL
      -- Last vertex (always keep)
      SELECT idx, pt FROM pts WHERE idx = (SELECT cnt FROM total_count)
    )
    SELECT 
      ST_AsGeoJSON(
        ST_MakeLine(array_agg(pt ORDER BY idx))
      )::json as cleaned_geometry,
      (SELECT COUNT(*) FROM spike_detection WHERE is_spike) as spikes_removed,
      (SELECT COUNT(*) FROM pts) as original_points,
      (SELECT COUNT(*) FROM kept_vertices) as final_points
    FROM kept_vertices
  `, [trailId, maxDeviationM]);
  
  return {
    geometry: result.rows[0].cleaned_geometry,
    spikesRemoved: parseInt(result.rows[0].spikes_removed),
    originalPoints: parseInt(result.rows[0].original_points),
    finalPoints: parseInt(result.rows[0].final_points)
  };
}

/**
 * Run spike removal iteratively until no more spikes found
 */
export async function removeSpikesIterative(trailId, maxDeviationM = 10, maxIterations = 5) {
  let totalRemoved = 0;
  let iteration = 0;
  let currentGeom = null;
  
  // Get initial geometry
  const initial = await query(`
    SELECT ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geom,
           ST_NPoints(COALESCE(edited_geometry, original_geometry)) as points
    FROM trail_edits WHERE id = $1
  `, [trailId]);
  
  let originalPoints = initial.rows[0].points;
  currentGeom = initial.rows[0].geom;
  
  while (iteration < maxIterations) {
    iteration++;
    
    const result = await removeSpikes(trailId, maxDeviationM);
    
    if (result.spikesRemoved === 0) {
      break; // No more spikes
    }
    
    totalRemoved += result.spikesRemoved;
    currentGeom = result.geometry;
    
    // Update the trail with cleaned geometry for next iteration
    await query(`
      UPDATE trail_edits 
      SET edited_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
          updated_at = NOW()
      WHERE id = $1
    `, [trailId, JSON.stringify(currentGeom)]);
  }
  
  return {
    geometry: currentGeom,
    totalSpikesRemoved: totalRemoved,
    iterations: iteration,
    originalPoints,
    finalPoints: originalPoints - totalRemoved
  };
}

export default {
  removeSpikes,
  removeSpikesIterative
};
