import { query } from './database.js';

/**
 * Find trails that share paths (are within tolerance of each other)
 */
export async function findOverlappingTrails(trailId, tolerance = 30) {
  const result = await query(`
    WITH target AS (
      SELECT id, original_geometry as geom FROM trail_edits WHERE id = $1
    ),
    overlapping AS (
      SELECT 
        t.id,
        t.trail_name,
        -- Calculate what percent of target trail overlaps with this trail
        ROUND(
          (ST_Length(ST_Intersection(
            ST_Buffer(t.original_geometry::geography, $2)::geometry,
            (SELECT geom FROM target)
          )::geography) / 
          NULLIF(ST_Length((SELECT geom::geography FROM target)), 0) * 100)::numeric
        , 1) as overlap_pct,
        ST_Length(t.original_geometry::geography) as length_m
      FROM trail_edits t, target tgt
      WHERE t.id != $1
        AND ST_DWithin(t.original_geometry::geography, tgt.geom::geography, $2)
    )
    SELECT * FROM overlapping 
    WHERE overlap_pct > 5
    ORDER BY overlap_pct DESC
  `, [trailId, tolerance]);
  
  return result.rows;
}

/**
 * Snap one trail to another where they overlap
 * Simple and reliable: snap points within tolerance to closest point on reference
 */
export async function snapTrailToTrail(sourceTrailId, referenceTrailId, tolerance = 30) {
  const result = await query(`
    WITH source AS (
      SELECT COALESCE(edited_geometry, original_geometry) as geom 
      FROM trail_edits WHERE id = $1
    ),
    reference AS (
      SELECT COALESCE(edited_geometry, original_geometry) as geom 
      FROM trail_edits WHERE id = $2
    ),
    -- Densify source
    densified AS (
      SELECT ST_Segmentize(s.geom::geography, 10)::geometry as geom
      FROM source s
    ),
    -- Extract vertices
    vertices AS (
      SELECT 
        row_number() OVER () as idx,
        (ST_DumpPoints(d.geom)).geom as pt
      FROM densified d
    ),
    -- For each vertex, snap to reference if within tolerance
    snapped AS (
      SELECT 
        v.idx,
        v.pt as original_pt,
        ST_ClosestPoint(r.geom, v.pt) as ref_pt,
        ST_Distance(v.pt::geography, r.geom::geography) as dist_m
      FROM vertices v, reference r
    ),
    -- Apply snapping
    result_pts AS (
      SELECT 
        idx,
        CASE WHEN dist_m <= $3 THEN ref_pt ELSE original_pt END as final_pt,
        dist_m <= $3 as was_snapped
      FROM snapped
      ORDER BY idx
    )
    SELECT ST_AsGeoJSON(
      ST_RemoveRepeatedPoints(
        ST_MakeLine(array_agg(final_pt ORDER BY idx)),
        0.000005
      )
    )::json as snapped_geometry,
    SUM(CASE WHEN was_snapped THEN 1 ELSE 0 END) as points_snapped,
    COUNT(*) as total_points
    FROM result_pts
  `, [sourceTrailId, referenceTrailId, tolerance]);
  
  return {
    geometry: result.rows[0].snapped_geometry,
    pointsSnapped: parseInt(result.rows[0].points_snapped),
    totalPoints: parseInt(result.rows[0].total_points)
  };
}

/**
 * Create a "canonical" reference line from multiple overlapping trails
 * Uses the trail with the most vertices (most detailed) as base
 */
export async function createCanonicalLine(trailIds, tolerance = 30) {
  const result = await query(`
    WITH trails AS (
      SELECT 
        id,
        COALESCE(edited_geometry, original_geometry) as geom,
        ST_NPoints(COALESCE(edited_geometry, original_geometry)) as npts
      FROM trail_edits 
      WHERE id = ANY($1)
    ),
    -- Use most detailed trail as reference
    reference AS (
      SELECT geom FROM trails ORDER BY npts DESC LIMIT 1
    ),
    -- Collect all trails
    all_geoms AS (
      SELECT ST_Collect(geom) as geom FROM trails
    ),
    -- Create a buffer around all trails and extract centerline
    merged AS (
      SELECT ST_ApproximateMedialAxis(
        ST_Buffer(a.geom::geography, $2)::geometry
      ) as centerline
      FROM all_geoms a
    )
    SELECT 
      ST_AsGeoJSON(COALESCE(m.centerline, r.geom))::json as canonical_geometry
    FROM merged m, reference r
  `, [trailIds, tolerance]);
  
  return result.rows[0]?.canonical_geometry;
}

/**
 * Snap all trails in a cluster to a canonical reference
 */
export async function snapClusterToCanonical(trailIds, referenceTrailId, tolerance = 30) {
  const results = [];
  
  for (const trailId of trailIds) {
    if (trailId === referenceTrailId) continue;
    
    const snapped = await snapTrailToTrail(trailId, referenceTrailId, tolerance);
    
    // Update the trail geometry
    await query(`
      UPDATE trail_edits 
      SET edited_geometry = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326),
          status = 'in_progress',
          updated_at = NOW()
      WHERE id = $1
    `, [trailId, JSON.stringify(snapped.geometry)]);
    
    results.push({
      trailId,
      pointsSnapped: snapped.pointsSnapped,
      totalPoints: snapped.totalPoints,
      snapPercent: Math.round(snapped.pointsSnapped / snapped.totalPoints * 100)
    });
  }
  
  return results;
}

/**
 * Auto-detect and snap all overlapping trail clusters
 */
export async function autoSnapAllClusters(tolerance = 30, minOverlapPct = 20) {
  // Find all pairs of overlapping trails
  const pairsResult = await query(`
    WITH pairs AS (
      SELECT 
        a.id as trail_a,
        b.id as trail_b,
        ST_NPoints(COALESCE(a.edited_geometry, a.original_geometry)) as pts_a,
        ST_NPoints(COALESCE(b.edited_geometry, b.original_geometry)) as pts_b,
        ROUND(
          (ST_Length(ST_Intersection(
            ST_Buffer(a.original_geometry::geography, $1)::geometry,
            b.original_geometry
          )::geography) / 
          NULLIF(LEAST(
            ST_Length(a.original_geometry::geography),
            ST_Length(b.original_geometry::geography)
          ), 0) * 100)::numeric
        , 1) as overlap_pct
      FROM trail_edits a
      JOIN trail_edits b ON a.id < b.id
        AND ST_DWithin(a.original_geometry::geography, b.original_geometry::geography, $1)
    )
    SELECT * FROM pairs WHERE overlap_pct >= $2
    ORDER BY overlap_pct DESC
  `, [tolerance, minOverlapPct]);
  
  // Group into clusters using union-find
  const clusters = new Map();
  const parent = new Map();
  
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }
  
  function union(a, b) {
    const pa = find(a), pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  }
  
  for (const pair of pairsResult.rows) {
    union(pair.trail_a, pair.trail_b);
  }
  
  // Build clusters
  for (const pair of pairsResult.rows) {
    const root = find(pair.trail_a);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(pair.trail_a);
    clusters.get(root).add(pair.trail_b);
  }
  
  return Array.from(clusters.values()).map(set => Array.from(set));
}

export default {
  findOverlappingTrails,
  snapTrailToTrail,
  createCanonicalLine,
  snapClusterToCanonical,
  autoSnapAllClusters
};
