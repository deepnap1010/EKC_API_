import { Router } from 'express';
import Machine from '../models/Machine.js';
import Telemetry from '../models/Telemetry.js';
import { machineAuth } from '../middleware/machineAuth.js';
import { isDbReady } from '../config/db.js';
import { broadcast } from '../realtime/sse.js';

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
  'department', 'dept',
  'timestamp', 'time', 'ts', 'datetime',
  'eventId', 'event_id', 'seq', 'sequence',
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
const getDepartment = (b) => firstOf(b, ['department', 'dept']);

/**
 * Optional client-supplied id used ONLY for idempotent retransmits. If a machine
 * resends a reading it already sent (flaky network, retry-on-timeout), we drop
 * the duplicate instead of storing/announcing it twice. Omit it and nothing
 * changes — every reading is stored.
 */
const getEventId = (b) => firstOf(b, ['eventId', 'event_id', 'seq', 'sequence']);

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
 * department, eventId, timestamp, receivedAt, data }.
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
  const eventId = getEventId(body);

  return {
    ok: true,
    machineId: String(machineId),
    machineName: getMachineName(body) ? String(getMachineName(body)) : String(machineId),
    machineType: getMachineType(body) ? String(getMachineType(body)) : 'UNKNOWN',
    department: getDepartment(body) ? String(getDepartment(body)) : undefined,
    eventId: eventId !== undefined ? String(eventId) : undefined,
    timestamp,
    receivedAt,
    data: extractData(body),
  };
}

/**
 * Upsert the machine master record — race-safe.
 *
 * Two payloads for a BRAND-NEW machine (common with 1–5s live data and retries)
 * can hit the upsert at the same instant; both try to INSERT and one trips the
 * unique index on machineId → MongoDB E11000 "duplicate key error". That was the
 * intermittent "duplicate data" 500. We catch it: the record exists now, so a
 * plain update applies our changes with nothing lost.
 */
async function upsertMachine(n) {
  const set = {
    machineName: n.machineName,
    machineType: n.machineType,
    status: 'running',
    lastSeenAt: n.receivedAt,
  };
  if (n.department) set.department = n.department;

  try {
    await Machine.updateOne(
      { machineId: n.machineId },
      { $setOnInsert: { machineId: n.machineId, registeredAt: n.receivedAt }, $set: set, $inc: { payloadCount: 1 } },
      { upsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      await Machine.updateOne({ machineId: n.machineId }, { $set: set, $inc: { payloadCount: 1 } });
    } else {
      throw err;
    }
  }
}

/**
 * Persist one reading. Returns { doc, duplicate }.
 *  - duplicate=true means an identical (machineId, eventId) reading was already
 *    stored, so this is an idempotent no-op (we DON'T error or re-broadcast).
 */
export async function persist(n) {
  await upsertMachine(n);

  const fields = {
    machineId: n.machineId,
    machineName: n.machineName,
    machineType: n.machineType,
    timestamp: n.timestamp,
    receivedAt: n.receivedAt,
    data: n.data,
  };
  if (n.eventId !== undefined) fields.eventId = n.eventId;

  try {
    const doc = await Telemetry.create(fields);
    return { doc, duplicate: false };
  } catch (err) {
    // Retransmit of a reading we already have (only possible when eventId is sent).
    if (err && err.code === 11000 && n.eventId !== undefined) {
      const doc = await Telemetry.findOne({ machineId: n.machineId, eventId: n.eventId }).lean();
      return { doc, duplicate: true };
    }
    throw err;
  }
}

/** Shape pushed to live dashboards over SSE. */
const toReading = (n, doc) => ({
  id: doc?._id,
  machineId: n.machineId,
  machineName: n.machineName,
  machineType: n.machineType,
  timestamp: n.timestamp,
  receivedAt: n.receivedAt,
  eventId: n.eventId,
  data: n.data,
});

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
 * Single telemetry payload (the common case — call this every 1–5s). Any shape.
 */
router.post('/ingest', machineAuth, async (req, res) => {
  try {
    const n = normalize(req.body);
    if (!n.ok) return res.status(400).json({ success: false, error: n.error });

    const { doc, duplicate } = await persist(n);
    if (!duplicate) broadcast(toReading(n, doc)); // push to live dashboards

    return res.status(duplicate ? 200 : 201).json({
      success: true,
      id: doc?._id,
      machineId: n.machineId,
      duplicate,                          // true => idempotent retransmit, nothing new stored
      storedKeys: Object.keys(n.data),    // echo what we understood — useful during integration
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
    let duplicates = 0;

    for (let i = 0; i < items.length; i++) {
      const n = normalize(items[i]);
      if (!n.ok) {
        results.push({ index: i, success: false, error: n.error });
        continue;
      }
      try {
        const { doc, duplicate } = await persist(n);
        accepted++;
        if (duplicate) duplicates++;
        else broadcast(toReading(n, doc));
        results.push({ index: i, success: true, id: doc?._id, machineId: n.machineId, duplicate });
      } catch (e) {
        results.push({ index: i, success: false, error: 'persist failed' });
      }
    }

    return res.status(accepted > 0 ? 201 : 400).json({
      success: accepted > 0,
      accepted,
      duplicates,
      rejected: items.length - accepted,
      results,
    });
  } catch (err) {
    console.error('batch ingest error:', err);
    return res.status(500).json({ success: false, error: 'Failed to ingest batch' });
  }
});

export default router;
