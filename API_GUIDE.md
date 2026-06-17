# EKC SmartFactory API — Quick Guide

Dynamic telemetry ingest for industrial machines. Machines POST live readings;
dashboards read them back (one-shot or as a live stream). The API does **not**
need to know a machine's sensors in advance — anything you put in `data` is stored.

Base URL: `http://localhost:8000/api/v1`

---

## 1. Machine → server: send live data (every 1–5s)

`POST /api/v1/ingest`  ·  `Content-Type: application/json`

Call this once per reading, as often as you like (1s, 5s, whatever).

### Accepted payload format

**Recommended (wrapped `data`):**

```json
{
  "machineId": "EKC_CNC_MACHINING_01",
  "machineName": "CNC Machine 01",
  "machineType": "CNC Machining",
  "department": "Production Floor A",
  "timestamp": "2026-06-17T10:30:01Z",
  "eventId": "EKC_CNC_MACHINING_01-1718620201000",
  "data": {
    "spindleSpeed": 1961,
    "feedRate": 204,
    "toolTemp": 44,
    "coolantFlow": 15
  }
}
```

Only `machineId` is **required**. Everything else is optional.

| Field         | Required | Notes |
|---------------|----------|-------|
| `machineId`   | ✅ yes   | Also accepted: `machine_id`, `deviceId`, `device_id`, `id` |
| `machineName` | no       | Defaults to `machineId` |
| `machineType` | no       | Defaults to `"UNKNOWN"` (used by `?type=` filter) |
| `department`  | no       | Stored on the machine record |
| `timestamp`   | no       | Device time (ISO-8601 or epoch ms). Falls back to server receive time |
| `eventId`     | no       | **Send this for safe retries** — see idempotency below. Also: `event_id`, `seq`, `sequence` |
| `data`        | no       | The sensor readings — any keys/values you want |

**Also accepted (loose — sensors at the top level):**

```json
{ "machineId": "EKC_CNC_MACHINING_01", "spindleSpeed": 1961, "toolTemp": 44 }
```

Top-level non-identity keys are folded into `data` automatically.

### Success response

```json
{ "success": true, "id": "665...", "machineId": "EKC_CNC_MACHINING_01", "duplicate": false, "storedKeys": ["spindleSpeed","feedRate","toolTemp","coolantFlow"] }
```

`201` = stored. `200` with `"duplicate": true` = idempotent retransmit (we already
had that `eventId`, nothing new stored — safe, not an error).

### Bulk / catch-up after downtime

`POST /api/v1/ingest/batch` — body is a **JSON array** of up to 1000 of the
objects above. Each item reports its own result.

---

## 2. Dashboard → server: read the data

| Endpoint | What you get |
|----------|--------------|
| `GET /api/v1/machines` | All machines. Filters: `?type=CNC Machining`, `?search=cnc` |
| `GET /api/v1/overview` | **Live snapshot**: every machine + its latest reading + `online` flag |
| `GET /api/v1/telemetry/:machineId` | Recent readings, newest first. `?limit=` (default 50, max 500) |
| `GET /api/v1/telemetry/:machineId/latest` | Single newest reading (`telemetry: null` if none yet) |
| `GET /api/v1/stream` | **Live feed (SSE)** of all machines — see below |
| `GET /api/v1/stream/:machineId` | Live feed for one machine |

---

## 3. Real-time live updates (SSE)

Open one long-lived connection and receive each reading the instant it arrives —
no polling. From a browser:

```js
const es = new EventSource("http://localhost:8000/api/v1/stream");
es.addEventListener("telemetry", (e) => {
  const reading = JSON.parse(e.data);
  console.log(reading.machineId, reading.data);  // update your UI here
});
```

Typical dashboard flow: call `GET /api/v1/overview` once to draw the grid, then
let `/stream` keep it live. Each `telemetry` event carries
`{ id, machineId, machineName, machineType, timestamp, receivedAt, eventId, data }`.

---

## Why you were seeing errors (now fixed)

- **"duplicate data" (intermittent 500):** two readings from a brand-new machine
  raced on the unique `machineId` index (MongoDB `E11000`). The upsert is now
  race-safe, and resends carrying the same `eventId` return `200 duplicate:true`.
- **"format error":** malformed/odd-content-type bodies used to get an HTML error
  page. The API now returns clean JSON `400` and accepts a wider content-type set.
- **"unexpected 404":** `/latest` returned `404` before a machine had reported.
  It now returns `200` with `telemetry: null`; real `404`s only mean a wrong URL
  (the response echoes the path so it's easy to spot).
- **429 under load:** `/ingest` and `/stream` are now exempt from the rate limiter.

## Quick test

```powershell
npm start
# in another terminal — stream live data every second:
powershell -ExecutionPolicy Bypass -File .\samples\send_live.ps1
# then watch it live:  open http://localhost:8000/api/v1/stream in a browser
```
