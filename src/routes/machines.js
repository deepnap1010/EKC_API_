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
 * GET /api/v1/overview
 * One-shot live snapshot for a dashboard: every machine + its latest reading +
 * a computed online/offline flag (based on how recently it last reported).
 * Pair this with GET /api/v1/stream — fetch /overview once to draw the grid,
 * then let the stream keep it live.
 */
router.get('/overview', async (req, res) => {
  try {
    const offlineAfter = parseInt(process.env.MACHINE_OFFLINE_AFTER_MS, 10) || 15_000;
    const now = Date.now();

    const machines = await Machine.find({}).sort({ lastSeenAt: -1 }).lean();
    const rows = await Promise.all(
      machines.map(async (m) => {
        const latest = await Telemetry.findOne({ machineId: m.machineId }).sort({ timestamp: -1 }).lean();
        const lastSeen = m.lastSeenAt ? new Date(m.lastSeenAt).getTime() : 0;
        return {
          machineId: m.machineId,
          machineName: m.machineName,
          machineType: m.machineType,
          department: m.department,
          payloadCount: m.payloadCount,
          lastSeenAt: m.lastSeenAt,
          online: lastSeen > 0 && now - lastSeen <= offlineAfter,
          latest: latest ? { timestamp: latest.timestamp, receivedAt: latest.receivedAt, data: latest.data } : null,
        };
      })
    );

    return res.json({ success: true, count: rows.length, offlineAfterMs: offlineAfter, machines: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to build overview' });
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
 *
 * Returns 200 with telemetry:null when the machine hasn't reported yet — a
 * dashboard polling this right after startup used to get an "unexpected 404".
 * null is easy to handle ("no data yet"); the 404 is reserved for wrong URLs.
 */
router.get('/telemetry/:machineId/latest', async (req, res) => {
  try {
    const row = await Telemetry.findOne({ machineId: req.params.machineId }).sort({ timestamp: -1 }).lean();
    return res.json({ success: true, machineId: req.params.machineId, telemetry: row || null });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch latest telemetry' });
  }
});

export default router;
