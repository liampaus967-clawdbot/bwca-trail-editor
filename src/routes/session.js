import { Router } from 'express';
import { query } from '../services/database.js';

const router = Router();

/**
 * GET /api/session
 * Get current session state
 */
router.get('/', async (req, res, next) => {
  try {
    // Get or create session
    let sessionResult = await query(`
      SELECT id, current_trail_id, created_at
      FROM edit_sessions
      ORDER BY created_at DESC
      LIMIT 1
    `);
    
    let session;
    if (sessionResult.rows.length === 0) {
      // Create new session
      const newSession = await query(`
        INSERT INTO edit_sessions DEFAULT VALUES
        RETURNING id, current_trail_id, created_at
      `);
      session = newSession.rows[0];
    } else {
      session = sessionResult.rows[0];
    }
    
    // Get progress
    const progressResult = await query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM trail_edits
    `);
    
    const progress = progressResult.rows[0];
    
    // Get undo stack size
    const undoResult = await query(`
      SELECT COUNT(*) as count FROM edit_operations
    `);
    
    res.json({
      success: true,
      session: {
        id: session.id,
        currentTrailId: session.current_trail_id,
        createdAt: session.created_at
      },
      progress: {
        total: parseInt(progress.total),
        completed: parseInt(progress.completed),
        inProgress: parseInt(progress.in_progress),
        skipped: parseInt(progress.skipped),
        pending: parseInt(progress.pending)
      },
      undoStackSize: parseInt(undoResult.rows[0].count)
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/queue/next
 * Get next trail to work on
 */
router.get('/queue/next', async (req, res, next) => {
  try {
    const { strategy = 'nhd_overlap_desc' } = req.query;
    
    let orderBy = 'id';
    
    switch (strategy) {
      case 'nhd_overlap_desc':
        // Prioritize trails with high NHD overlap (easier to process)
        orderBy = `(
          SELECT COUNT(*) FROM river_edges r 
          WHERE ST_DWithin(r.geom::geography, t.original_geometry::geography, 100)
        ) DESC`;
        break;
      case 'complexity_asc':
        // Simple trails first
        orderBy = 'ST_NPoints(original_geometry) ASC';
        break;
      case 'length_asc':
        orderBy = 'ST_Length(original_geometry::geography) ASC';
        break;
    }
    
    const result = await query(`
      SELECT 
        t.id,
        t.trail_name,
        t.status,
        ST_Length(t.original_geometry::geography) as length_m,
        ST_NPoints(t.original_geometry) as vertex_count,
        (
          SELECT COUNT(*) FROM river_edges r 
          WHERE ST_DWithin(r.geom::geography, t.original_geometry::geography, 100)
        ) as nearby_nhd_count
      FROM trail_edits t
      WHERE t.status = 'pending'
      ORDER BY ${orderBy}
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        trail: null,
        message: 'No pending trails'
      });
    }
    
    const trail = result.rows[0];
    
    // Determine suggested approach
    let suggestedApproach = 'manual_review';
    let estimatedComplexity = 'medium';
    
    if (trail.nearby_nhd_count > 5) {
      suggestedApproach = 'snap_to_nhd';
      estimatedComplexity = 'low';
    } else if (trail.vertex_count < 50) {
      estimatedComplexity = 'low';
    } else if (trail.vertex_count > 500) {
      estimatedComplexity = 'high';
    }
    
    // Update session
    await query(`
      UPDATE edit_sessions
      SET current_trail_id = $1
      WHERE id = (SELECT id FROM edit_sessions ORDER BY created_at DESC LIMIT 1)
    `, [trail.id]);
    
    res.json({
      success: true,
      trail: {
        id: trail.id,
        name: trail.trail_name,
        status: trail.status,
        lengthM: parseFloat(trail.length_m),
        vertexCount: parseInt(trail.vertex_count),
        nearbyNHDCount: parseInt(trail.nearby_nhd_count)
      },
      suggestedApproach,
      estimatedComplexity
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/trail/:trailId/complete
 * Mark trail as completed
 */
router.post('/trail/:trailId/complete', async (req, res, next) => {
  try {
    const { trailId } = req.params;
    const { status = 'completed', notes = '' } = req.body;
    
    if (!['completed', 'skipped'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Status must be completed or skipped' }
      });
    }
    
    await query(`
      UPDATE trail_edits
      SET 
        status = $2,
        metadata = metadata || jsonb_build_object('completionNotes', $3),
        updated_at = NOW()
      WHERE id = $1
    `, [trailId, status, notes]);
    
    // Get next trail suggestion
    const nextResult = await query(`
      SELECT id, trail_name
      FROM trail_edits
      WHERE status = 'pending'
      ORDER BY id
      LIMIT 1
    `);
    
    res.json({
      success: true,
      completedTrail: trailId,
      status,
      nextTrail: nextResult.rows[0] || null
    });
    
  } catch (err) {
    next(err);
  }
});

export default router;
