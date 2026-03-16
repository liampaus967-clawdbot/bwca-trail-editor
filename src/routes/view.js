import { Router } from 'express';
import { query } from '../services/database.js';
import { takeScreenshot } from '../services/screenshot.js';
import { findNearestNHD, analyzeTrail } from '../services/geometry.js';

const router = Router();

/**
 * GET /api/view
 * Get map screenshot of an area
 */
router.get('/', async (req, res, next) => {
  try {
    const {
      bbox,
      width = 1200,
      height = 800,
      layers = 'nhd,original,edited',
      highlightTrail
    } = req.query;
    
    const layerList = layers.split(',');
    let bounds = null;
    
    if (bbox) {
      bounds = bbox.split(',').map(Number);
    }
    
    // Get geometries for the view
    const trailGeometries = {};
    const nhdGeometries = [];
    
    // Get NHD in bounds
    if (layerList.includes('nhd') && bounds) {
      const nhdResult = await query(`
        SELECT ST_AsGeoJSON(geom)::json as geometry
        FROM river_edges
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        LIMIT 500
      `, bounds);
      nhdGeometries.push(...nhdResult.rows.map(r => r.geometry));
    }
    
    // Get original trails
    if (layerList.includes('original')) {
      const origResult = await query(`
        SELECT ST_AsGeoJSON(original_geometry)::json as geometry
        FROM trail_edits
        ${bounds ? 'WHERE original_geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)' : ''}
      `, bounds || []);
      
      trailGeometries.original = {
        type: 'FeatureCollection',
        features: origResult.rows.map(r => ({
          type: 'Feature',
          geometry: r.geometry,
          properties: {}
        }))
      };
    }
    
    // Get edited trails
    if (layerList.includes('edited')) {
      const editedResult = await query(`
        SELECT ST_AsGeoJSON(edited_geometry)::json as geometry
        FROM trail_edits
        WHERE edited_geometry IS NOT NULL
        ${bounds ? 'AND edited_geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)' : ''}
      `, bounds || []);
      
      trailGeometries.edited = {
        type: 'FeatureCollection',
        features: editedResult.rows.map(r => ({
          type: 'Feature',
          geometry: r.geometry,
          properties: {}
        }))
      };
    }
    
    const screenshot = await takeScreenshot({
      bounds,
      layers: layerList,
      width: parseInt(width),
      height: parseInt(height),
      highlightTrailId: highlightTrail,
      trailGeometries,
      nhdGeometries
    });
    
    res.json({
      success: true,
      screenshot,
      bounds,
      visibleFeatures: {
        nhdSegments: nhdGeometries.length,
        originalTrails: trailGeometries.original?.features?.length || 0,
        editedTrails: trailGeometries.edited?.features?.length || 0
      }
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/view/trail/:trailId
 * Get focused view of a specific trail
 */
router.get('/trail/:trailId', async (req, res, next) => {
  try {
    const { trailId } = req.params;
    
    // Get trail and its bounds
    const trailResult = await query(`
      SELECT 
        id, trail_name, status,
        ST_AsGeoJSON(original_geometry)::json as original_geometry,
        ST_AsGeoJSON(edited_geometry)::json as edited_geometry,
        ST_XMin(original_geometry) as min_lng,
        ST_YMin(original_geometry) as min_lat,
        ST_XMax(original_geometry) as max_lng,
        ST_YMax(original_geometry) as max_lat,
        ST_Length(original_geometry::geography) as length_m
      FROM trail_edits
      WHERE id = $1
    `, [trailId]);
    
    if (trailResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'TRAIL_NOT_FOUND', message: `Trail ${trailId} not found` }
      });
    }
    
    const trail = trailResult.rows[0];
    const bounds = [
      trail.min_lng - 0.01,
      trail.min_lat - 0.01,
      trail.max_lng + 0.01,
      trail.max_lat + 0.01
    ];
    
    // Get nearby NHD
    const nearbyNHD = await findNearestNHD(
      trail.edited_geometry || trail.original_geometry,
      200,
      10
    );
    
    // Get NHD geometries for screenshot
    const nhdGeometries = nearbyNHD.map(n => n.geometry);
    
    // Build trail geometries
    const trailGeometries = {
      original: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: trail.original_geometry,
          properties: {}
        }]
      },
      highlight: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: trail.edited_geometry || trail.original_geometry,
          properties: {}
        }]
      }
    };
    
    if (trail.edited_geometry) {
      trailGeometries.edited = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: trail.edited_geometry,
          properties: {}
        }]
      };
    }
    
    // Screenshot is optional - may fail without Puppeteer/Chrome
    let screenshot = null;
    try {
      screenshot = await takeScreenshot({
        bounds,
        layers: ['nhd', 'original', 'edited'],
        highlightTrailId: trailId,
        trailGeometries,
        nhdGeometries
      });
    } catch (screenshotErr) {
      console.warn('Screenshot failed (Puppeteer not available?):', screenshotErr.message);
    }
    
    // Analyze trail
    const analysis = await analyzeTrail(trailId);
    
    res.json({
      success: true,
      screenshot,
      trail: {
        id: trail.id,
        name: trail.trail_name,
        status: trail.status,
        lengthM: parseFloat(trail.length_m)
      },
      nearbyNHD,
      analysis,
      bounds
    });
    
  } catch (err) {
    next(err);
  }
});

export default router;
