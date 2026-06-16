import mongoose from 'mongoose';

/**
 * Append-only time-series telemetry.
 *
 * The whole point: we DON'T know what fields a machine will send. So every
 * sensor reading lands in the flexible `data` object (Mixed type) exactly as
 * received. Only the identity + timing fields are fixed and indexed.
 */
const telemetrySchema = new mongoose.Schema(
  {
    machineId:   { type: String, required: true, index: true },
    machineName: { type: String },
    machineType: { type: String, default: 'UNKNOWN' },

    // Device/PLC-reported time. Falls back to receivedAt if the machine omits it.
    timestamp:   { type: Date },
    // Server receipt time — always set by us.
    receivedAt:  { type: Date, default: Date.now },

    // The flexible payload: whatever keys the machine sent.
    data:        { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { strict: false, versionKey: false }
);

// Core query path: readings for one machine within a time window, newest first.
telemetrySchema.index({ machineId: 1, timestamp: -1 });
// Aggregations across a machine type.
telemetrySchema.index({ machineType: 1, timestamp: -1 });
// "Most recent across everything" / dashboards.
telemetrySchema.index({ receivedAt: -1 });

export default mongoose.model('Telemetry', telemetrySchema);
