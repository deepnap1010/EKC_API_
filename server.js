import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { connectDB, isDbReady } from './src/config/db.js';
import ingestRoutes from './src/routes/ingest.js';
import machineRoutes from './src/routes/machines.js';

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiter for the API surface — generous, so legit machine bursts pass.
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 1200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/v1', limiter);

// Routes
app.use('/api/v1', ingestRoutes);
app.use('/api/v1', machineRoutes);

// Health / info
app.get('/', (req, res) => {
  res.json({
    service: 'EKC SmartFactory API',
    status: 'ok',
    db: isDbReady() ? 'connected' : 'not connected',
  });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: isDbReady() ? 'connected' : 'down' });
});

// 404 fallback
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// Boot: connect DB (non-blocking if URI empty), then listen.
await connectDB();
app.listen(PORT, () => {
  console.log(`\n🚀 EKC SmartFactory API running on http://localhost:${PORT}`);
  console.log(`   POST http://localhost:${PORT}/api/v1/ingest`);
  console.log(`   GET  http://localhost:${PORT}/api/v1/machines\n`);
});
