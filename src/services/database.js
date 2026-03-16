import pg from 'pg';
const { Pool } = pg;

let pool;

export async function initDatabase() {
  pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 10
  });
  
  // Test connection
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  
  // Ensure edit tables exist
  await ensureEditTables();
  
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('Database not initialized');
  return pool;
}

export async function query(text, params) {
  const start = Date.now();
  const result = await getPool().query(text, params);
  const duration = Date.now() - start;
  
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
  }
  
  return result;
}

async function ensureEditTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS edit_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      current_trail_id TEXT,
      view_bounds GEOMETRY(Polygon, 4326),
      metadata JSONB DEFAULT '{}'
    )
  `);
  
  await query(`
    CREATE TABLE IF NOT EXISTS trail_edits (
      id TEXT PRIMARY KEY,
      session_id UUID REFERENCES edit_sessions(id) ON DELETE CASCADE,
      original_id INTEGER,
      trail_name TEXT,
      status TEXT DEFAULT 'pending',
      original_geometry GEOMETRY(LineString, 4326),
      edited_geometry GEOMETRY(LineString, 4326),
      edit_history JSONB DEFAULT '[]',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await query(`
    CREATE TABLE IF NOT EXISTS edit_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trail_id TEXT REFERENCES trail_edits(id) ON DELETE CASCADE,
      operation_type TEXT,
      params JSONB,
      geometry_before GEOMETRY(LineString, 4326),
      geometry_after GEOMETRY(LineString, 4326),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // Create indexes if they don't exist
  await query(`
    CREATE INDEX IF NOT EXISTS idx_trail_edits_status ON trail_edits(status)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_trail_edits_geom ON trail_edits USING GIST(original_geometry)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_trail_edits_edited_geom ON trail_edits USING GIST(edited_geometry)
  `);
  
  console.log('✓ Edit tables ready');
}

export default { initDatabase, getPool, query };
