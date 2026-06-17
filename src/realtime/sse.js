import { Router } from 'express';

/**
 * Live telemetry feed over Server-Sent Events (SSE).
 *
 * A dashboard opens ONE long-lived HTTP connection (GET /api/v1/stream) and we
 * push every new reading to it the instant it's ingested — no polling, no 404s,
 * auto-reconnect handled by the browser's EventSource. Perfect for "machine
 * sends data every 1–5s" → "screen updates in real time".
 *
 * In-memory hub => works for a single server process. If you scale to multiple
 * instances behind a load balancer, replace the Set with Redis pub/sub so a
 * reading ingested on instance A also reaches dashboards held open on instance B.
 */

const clients = new Set(); // each entry: { res, machineId|null }

/** Push one reading to every connected dashboard (filtered by machine if scoped). */
export function broadcast(reading) {
  if (clients.size === 0) return;
  const frame = `event: telemetry\ndata: ${JSON.stringify(reading)}\n\n`;
  for (const c of clients) {
    if (c.machineId && c.machineId !== reading.machineId) continue; // scoped stream
    try {
      c.res.write(frame);
    } catch {
      /* a dead socket is cleaned up by its own 'close' handler */
    }
  }
}

/** How many dashboards are currently listening (handy for /health). */
export function clientCount() {
  return clients.size;
}

/** Wire up one SSE connection and keep it alive until the client disconnects. */
function subscribe(req, res, machineId = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  // First frame so the client knows it's connected.
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, machineId })}\n\n`);

  const client = { res, machineId };
  clients.add(client);

  // Comment "ping" every 25s keeps proxies/browsers from dropping an idle stream.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {
      /* ignore */
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

const router = Router();

// GET /api/v1/stream             → live feed of ALL machines
router.get('/stream', (req, res) => subscribe(req, res, null));
// GET /api/v1/stream/:machineId  → live feed for ONE machine
router.get('/stream/:machineId', (req, res) => subscribe(req, res, req.params.machineId));

export default router;
