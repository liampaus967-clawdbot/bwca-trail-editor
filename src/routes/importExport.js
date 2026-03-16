import { Router } from 'express';
import { query } from '../services/database.js';

const router = Router();

/**
 * POST /api/import/trails
 * Import trail data
 */
router.post('/import/trails', async (req, res, next) => {
  try {
    const { source, geojson, postgisQuery, clearExisting = false } = req.body;
    
    if (clearExisting) {
      await query('DELETE FROM edit_operations');
      await query('DELETE FROM trail_edits');
    }
    
    let importCount = 0;
    
    if (source === 'geojson' && geojson) {
      // Import from GeoJSON
      const features = geojson.features || [];
      
      for (const feature of features) {
        const id = `trail_${feature.properties?.id || importCount + 1}`;
        const trailName = feature.properties?.trail_name || feature.properties?.name || 'Unknown';
        const originalId = feature.properties?.id || null;
        
        await query(`
          INSERT INTO trail_edits (id, original_id, trail_name, original_geometry, session_id)
          VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), 
            (SELECT id FROM edit_sessions ORDER BY created_at DESC LIMIT 1))
          ON CONFLICT (id) DO UPDATE SET
            original_geometry = EXCLUDED.original_geometry,
            updated_at = NOW()
        `, [id, originalId, trailName, JSON.stringify(feature.geometry)]);
        
        importCount++;
      }
    } else if (source === 'postgis') {
      // Import from PostGIS table
      const sourceQuery = postgisQuery || 'SELECT id, trail_name, geom FROM bwca_edges';
      
      const result = await query(`
        INSERT INTO trail_edits (id, original_id, trail_name, original_geometry, session_id)
        SELECT 
          'trail_' || id,
          id,
          COALESCE(trail_name, 'Trail ' || id),
          geom,
          (SELECT id FROM edit_sessions ORDER BY created_at DESC LIMIT 1)
        FROM (${sourceQuery}) source
        ON CONFLICT (id) DO UPDATE SET
          original_geometry = EXCLUDED.original_geometry,
          updated_at = NOW()
        RETURNING id
      `);
      
      importCount = result.rowCount;
    }
    
    res.json({
      success: true,
      importedCount: importCount
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/import/nhd
 * Import NHD reference data (just validates it exists)
 */
router.post('/import/nhd', async (req, res, next) => {
  try {
    const { bbox } = req.body;
    
    let countQuery = 'SELECT COUNT(*) as count FROM river_edges';
    let params = [];
    
    if (bbox) {
      countQuery += ' WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)';
      params = bbox;
    }
    
    const result = await query(countQuery, params);
    
    res.json({
      success: true,
      nhdCount: parseInt(result.rows[0].count),
      message: 'NHD data available in river_edges table'
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/export
 * Export edited trails
 */
router.get('/export', async (req, res, next) => {
  try {
    const {
      format = 'geojson',
      status = 'completed',
      includeOriginal = false
    } = req.query;
    
    let whereClause = '';
    if (status === 'completed') {
      whereClause = "WHERE status = 'completed'";
    } else if (status === 'completed+skipped') {
      whereClause = "WHERE status IN ('completed', 'skipped')";
    }
    
    const result = await query(`
      SELECT 
        id,
        original_id,
        trail_name,
        status,
        ST_AsGeoJSON(COALESCE(edited_geometry, original_geometry))::json as geometry,
        ${includeOriginal === 'true' ? "ST_AsGeoJSON(original_geometry)::json as original_geometry," : ''}
        (SELECT COUNT(*) FROM edit_operations WHERE trail_id = trail_edits.id) as edit_count,
        metadata
      FROM trail_edits
      ${whereClause}
      ORDER BY id
    `);
    
    if (format === 'geojson') {
      const geojson = {
        type: 'FeatureCollection',
        features: result.rows.map(row => ({
          type: 'Feature',
          properties: {
            id: row.id,
            originalId: row.original_id,
            trailName: row.trail_name,
            status: row.status,
            editCount: parseInt(row.edit_count),
            ...(includeOriginal === 'true' && row.original_geometry ? { originalGeometry: row.original_geometry } : {}),
            ...row.metadata
          },
          geometry: row.geometry
        })),
        metadata: {
          exportedAt: new Date().toISOString(),
          totalTrails: result.rows.length,
          format: 'geojson'
        }
      };
      
      res.json(geojson);
    } else if (format === 'postgis_sql') {
      // Generate INSERT statements
      let sql = '-- BWCA Trail Editor Export\n';
      sql += '-- Generated: ' + new Date().toISOString() + '\n\n';
      sql += 'BEGIN;\n\n';
      
      for (const row of result.rows) {
        sql += `INSERT INTO bwca_trails_edited (id, trail_name, geom, status) VALUES (\n`;
        sql += `  ${row.original_id},\n`;
        sql += `  '${row.trail_name.replace(/'/g, "''")}',\n`;
        sql += `  ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(row.geometry)}'), 4326),\n`;
        sql += `  '${row.status}'\n`;
        sql += `);\n\n`;
      }
      
      sql += 'COMMIT;\n';
      
      res.type('text/plain').send(sql);
    } else {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_FORMAT', message: 'Format must be geojson or postgis_sql' }
      });
    }
    
  } catch (err) {
    next(err);
  }
});

export default router;
