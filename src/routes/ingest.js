import { Router } from 'express';
import Machine from '../models/Machine.js';
import Telemetry from '../models/Telemetry.js';
import { machineAuth } from '../middleware/machineAuth.js';
import { isDbReady } from '../config/db.js';

const router = Router();

/* ────────────────────────────────────────────────────────────────────────────
 * The dynamic part: we don't know what the machine will send, so we only pin
 * down the few identity/timing fields and treat EVERYTHING else as sensor data.
 * ────────────────────────────────────────────────────────────────────────── */

// Top-level keys we interpret as identity/timing — never treated as sensor data.
const RESERVED = new Set([
  'machineId', 'machine_id', 'machineID', 'deviceId', 'device_id', 'id',
  'machineName', 'machine_name', 'name',
  'machineType', 'machine_type', 'type',
  'timestamp', 'time', 'ts', 'datetime',
  'data', 'payload',
  'receivedAt',
]);

const firstOf = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

/** Pull the machine identifier from any of several common key spellings. */
const getMachineId = (b) => firstOf(b, ['machineId', 'machine_id', 'machineID', 'deviceId', 'device_id', 'id']);
const getMachineName = (b) => firstOf(b, ['machineName', 'machine_name', 'name']);
const getMachineType = (b) => firstOf(b, ['machineType', 'machine_type', 'type']);

/** Parse a device timestamp if present and valid; otherwise undefined. */
const getTimestamp = (b) => {
  const raw = firstOf(b, ['timestamp', 'time', 'ts', 'datetime']);
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
};

/**
 * Build the flexible sensor object. Accepts BOTH styles:
 *   { machineId, data: { pressure: 1 } }      ← wrapped
 *   { machineId, pressure: 1, temp: 2 }        ← loose top-level keys
 * and merges them, with explicit `data`/`payload` taking precedence.
 */
const extractData = (b) => {
  const data = {};
  for (const [k, v] of Object.entries(b)) {
    if (!RESERVED.has(k)) data[k] = v;
  }
  const wrapped = b.data ?? b.payload;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    Object.assign(data, wrapped);
  }
  return data;
};

/**
 * Normalize one raw payload → { ok, error?, machineId, machineName, machineType,
 * timestamp, receivedAt, data }.
 */
export function normalize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Payload must be a JSON object' };
  }
  const machineId = getMachineId(body);
  if (!machineId) {
    return { ok: false, error: 'Missing machine identifier (machineId / deviceId / id)' };
  }

  const receivedAt = new Date();
  const timestamp = getTimestamp(body) ?? receivedAt;
  const data = extractData(body);

  return {
    ok: true,
    machineId: String(machineId),
    machineName: getMachineName(body) ? String(getMachineName(body)) : String(machineId),
    machineType: getMachineType(body) ? String(getMachineType(body)) : 'UNKNOWN',
    timestamp,
    receivedAt,
    data,
  };
}

/** Upsert the machine master record and append the telemetry document. */
export async function persist(n) {
  const set = { machineName: n.machineName, machineType: n.machineType, lastSeenAt: n.receivedAt };

  await Machine.updateOne(
    { machineId: n.machineId },
    { $setOnInsert: { machineId: n.machineId, registeredAt: n.receivedAt }, $set: set, $inc: { payloadCount: 1 } },
    { upsert: true }
  );

  const doc = await Telemetry.create({
    machineId: n.machineId,
    machineName: n.machineName,
    machineType: n.machineType,
    timestamp: n.timestamp,
    receivedAt: n.receivedAt,
    data: n.data,
  });

  return doc;
}

/* ── Routes ────────────────────────────────────────────────────────────────*/

// Guard: every ingest route needs a live DB.
router.use((req, res, next) => {
  if (!isDbReady()) {
    return res.status(503).json({
      success: false,
      error: 'Database not configured. Set MONGO_URI in .env and restart the server.',
    });
  }
  next();
});

/**
 * POST /api/v1/ingest
 * Single telemetry payload (the common case). Accepts any shape.
 */
router.post('/ingest', machineAuth, async (req, res) => {
  try {
    const n = normalize(req.body);
    if (!n.ok) return res.status(400).json({ success: false, error: n.error });

    const doc = await persist(n);

    return res.status(201).json({
      success: true,
      id: doc._id,
      machineId: n.machineId,
      storedKeys: Object.keys(n.data), // echo what we understood — useful during integration
    });
  } catch (err) {
    console.error('ingest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to ingest payload' });
  }
});

/**
 * POST /api/v1/ingest/batch
 * Array of payloads (max 1000) for bulk / catch-up ingestion after downtime.
 * Partial success is allowed — each item reports its own result.
 */
router.post('/ingest/batch', machineAuth, async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'Body must be a JSON array of payloads' });
    }
    if (items.length === 0) {
      return res.status(400).json({ success: false, error: 'Array is empty' });
    }
    if (items.length > 1000) {
      return res.status(413).json({ success: false, error: 'Batch too large (max 1000 payloads per request)' });
    }

    const results = [];
    let accepted = 0;

    for (let i = 0; i < items.length; i++) {
      const n = normalize(items[i]);
      if (!n.ok) {
        results.push({ index: i, success: false, error: n.error });
        continue;
      }
      try {
        const doc = await persist(n);
        accepted++;
        results.push({ index: i, success: true, id: doc._id, machineId: n.machineId });
      } catch (e) {
        results.push({ index: i, success: false, error: 'persist failed' });
      }
    }

    return res.status(accepted > 0 ? 201 : 400).json({
      success: accepted > 0,
      accepted,
      rejected: items.length - accepted,
      results,
    });
  } catch (err) {
    console.error('batch ingest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to ingest batch' });
  }
});

export default router;
