import { Router } from 'express';
import { query } from '../services/database.js';
import { analyzeTrail, findNearestNHD } from '../services/geometry.js';

const router = Router();

/**
 * GET /api/analyze/trail/:trailId
 * Deep analysis of a trail for editing decisions
 */
router.get('/trail/:trailId', async (req, res, next) => {
  try {
    const { trailId } = req.params;
    const analysis = await analyzeTrail(trailId);
    
    res.json({
      success: true,
      ...analysis
    });
    
  } catch (err) {
    if (err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: err.message }
      });
    }
    next(err);
  }
});

/**
 * GET /api/analyze/cluster
 * Find clusters of overlapping trails
 */
router.get('/cluster', async (req, res, next) => {
  try {
    const {
      bbox,
      minOverlap = 50
    } = req.query;
    
    let whereClause = "WHERE status != 'skipped'";
    let params = [];
    
    if (bbox) {
      const bounds = bbox.split(',').map(Number);
      whereClause += ` AND original_geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)`;
      params = bounds;
    }
    
    // Find trails that are near each other
    const clusterResult = await query(`
      WITH trail_pairs AS (
        SELECT 
          a.id as trail_a,
          b.id as trail_b,
          a.trail_name as name_a,
          b.trail_name as name_b,
          ST_Length(
            ST_Intersection(
              ST_Buffer(a.original_geometry, 0.001),
              b.original_geometry
            )::geography
          ) / NULLIF(ST_Length(a.original_geometry::geography), 0) * 100 as overlap_pct
        FROM trail_edits a
        JOIN trail_edits b ON a.id < b.id
          AND ST_DWithin(a.original_geometry::geography, b.original_geometry::geography, 100)
        ${whereClause}
      )
      SELECT *
      FROM trail_pairs
      WHERE overlap_pct >= $${params.length + 1}
      ORDER BY overlap_pct DESC
      LIMIT 50
    `, [...params, parseFloat(minOverlap)]);
    
    // Group into clusters
    const clusters = [];
    const seen = new Set();
    
    for (const pair of clusterResult.rows) {
      if (seen.has(pair.trail_a) && seen.has(pair.trail_b)) continue;
      
      // Find or create cluster
      let cluster = clusters.find(c => 
        c.trailIds.includes(pair.trail_a) || c.trailIds.includes(pair.trail_b)
      );
      
      if (!cluster) {
        cluster = {
          id: `cluster_${clusters.length + 1}`,
          trailIds: [],
          avgOverlap: 0
        };
        clusters.push(cluster);
      }
      
      if (!cluster.trailIds.includes(pair.trail_a)) {
        cluster.trailIds.push(pair.trail_a);
        seen.add(pair.trail_a);
      }
      if (!cluster.trailIds.includes(pair.trail_b)) {
        cluster.trailIds.push(pair.trail_b);
        seen.add(pair.trail_b);
      }
    }
    
    res.json({
      success: true,
      clusters
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/nhd/nearest
 * Find nearest NHD segments to a point or line
 */
router.get('/nhd/nearest', async (req, res, next) => {
  try {
    const {
      point,
      line,
      maxDistance = 200,
      limit = 10
    } = req.query;
    
    let geometry;
    
    if (point) {
      const [lng, lat] = point.split(',').map(Number);
      geometry = {
        type: 'Point',
        coordinates: [lng, lat]
      };
    } else if (line) {
      geometry = JSON.parse(decodeURIComponent(line));
    } else {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: 'Must provide point or line parameter' }
      });
    }
    
    const results = await findNearestNHD(geometry, parseFloat(maxDistance), parseInt(limit));
    
    res.json({
      success: true,
      results
    });
    
  } catch (err) {
    next(err);
  }
});

export default router;
