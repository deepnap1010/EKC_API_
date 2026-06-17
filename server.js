import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { connectDB, isDbReady } from './src/config/db.js';
import streamRoutes, { clientCount } from './src/realtime/sse.js';
import ingestRoutes from './src/routes/ingest.js';
import machineRoutes from './src/routes/machines.js';

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());

// Parse JSON bodies. Machines don't always set a textbook content-type, so we
// accept a broad set rather than ONLY application/json — fewer "format" errors.
app.use(
  express.json({
    limit: '1mb',
    type: ['application/json', 'application/*+json', 'text/plain', 'text/json'],
  })
);

// Body-parser error handler. WITHOUT this, malformed JSON makes Express reply
// with an HTML stack-trace page that machines/dashboards can't parse — which is
// exactly what showed up as the intermittent "format error". Now it's clean JSON.
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Malformed JSON body. Send valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ success: false, error: 'Payload too large (limit 1mb). Post fewer readings or use /api/v1/ingest/batch.' });
  }
  return res.status(400).json({ success: false, error: 'Invalid request body' });
});

// Rate limiter — applies to READ/query routes only. /ingest and /stream are
// exempt so machines posting every 1–5s and live dashboards are NEVER throttled.
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 1200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith('/api/v1/ingest') || req.originalUrl.startsWith('/api/v1/stream'),
});
app.use('/api/v1', limiter);

// Routes
app.use('/api/v1', streamRoutes);   // live SSE feed — no DB needed, so mounted first
app.use('/api/v1', ingestRoutes);   // machine → server (write live readings)
app.use('/api/v1', machineRoutes);  // dashboard → server (read)

// Health / info
app.get('/', (req, res) => {
  res.json({
    service: 'EKC SmartFactory API',
    status: 'ok',
    db: isDbReady() ? 'connected' : 'not connected',
    liveClients: clientCount(),
  });
});
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    db: isDbReady() ? 'connected' : 'down',
    liveClients: clientCount(),
  });
});

// 404 fallback — JSON, and it echoes the path so wrong URLs are obvious.
app.use((req, res) => res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.originalUrl}` }));

// Last-resort error handler — anything thrown downstream returns JSON, not HTML.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Boot: connect DB (non-blocking if URI empty), then listen.
await connectDB();
app.listen(PORT, () => {
  console.log(`\n🚀 EKC SmartFactory API running on http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/v1/ingest      (machine → live readings, every 1–5s)`);
  console.log(`   GET  http://localhost:${PORT}/api/v1/machines     (list machines)`);
  console.log(`   GET  http://localhost:${PORT}/api/v1/overview     (live snapshot + online flag)`);
  console.log(`   GET  http://localhost:${PORT}/api/v1/stream       (live SSE feed)\n`);
});
