import { Router } from 'express';
import Machine from '../models/Machine.js';
import Telemetry from '../models/Telemetry.js';
import { isDbReady } from '../config/db.js';

const router = Router();

// All read routes need a live DB too.
router.use((req, res, next) => {
  if (!isDbReady()) {
    return res.status(503).json({ success: false, error: 'Database not configured. Set MONGO_URI in .env.' });
  }
  next();
});

/**
 * GET /api/v1/machines
 * List every auto-registered machine. Optional ?type= and ?search= filters.
 */
router.get('/machines', async (req, res) => {
  try {
    const { type, search } = req.query;
    const q = {};
    if (type) q.machineType = type;
    if (search) {
      q.$or = [
        { machineId: new RegExp(search, 'i') },
        { machineName: new RegExp(search, 'i') },
      ];
    }
    const machines = await Machine.find(q).sort({ lastSeenAt: -1 }).lean();
    return res.json({ success: true, count: machines.length, machines });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to list machines' });
  }
});

/**
 * GET /api/v1/telemetry/:machineId
 * Recent readings for a machine, newest first. ?limit= (default 50, max 500).
 */
router.get('/telemetry/:machineId', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const rows = await Telemetry.find({ machineId: req.params.machineId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    return res.json({ success: true, count: rows.length, telemetry: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch telemetry' });
  }
});

/**
 * GET /api/v1/telemetry/:machineId/latest
 * Single most-recent reading for a machine.
 */
router.get('/telemetry/:machineId/latest', async (req, res) => {
  try {
    const row = await Telemetry.findOne({ machineId: req.params.machineId })
      .sort({ timestamp: -1 })
      .lean();
    if (!row) return res.status(404).json({ success: false, error: 'No telemetry for this machine' });
    return res.json({ success: true, telemetry: row });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch latest telemetry' });
  }
});

export default router;
