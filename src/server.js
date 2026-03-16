import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Routes
import viewRoutes from './routes/view.js';
import analyzeRoutes from './routes/analyze.js';
import drawRoutes from './routes/draw.js';
import sessionRoutes from './routes/session.js';
import importExportRoutes from './routes/importExport.js';
import snapTrailsRoutes from './routes/snapTrails.js';

// Services
import { initDatabase } from './services/database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new SocketIO(server, {
  cors: { origin: '*' }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, '../public')));

// Make io available to routes
app.set('io', io);

// API Routes
app.use('/api/view', viewRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/draw', drawRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api', importExportRoutes);
app.use('/api/snap-trails', snapTrailsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || 'An unexpected error occurred',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  try {
    await initDatabase();
    console.log('✓ Database connected');
    
    server.listen(PORT, HOST, () => {
      console.log(`✓ BWCA Trail Editor running at http://${HOST}:${PORT}`);
      console.log(`  - API: http://${HOST}:${PORT}/api`);
      console.log(`  - Map: http://${HOST}:${PORT}/`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
