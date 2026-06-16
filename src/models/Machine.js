import mongoose from 'mongoose';

/**
 * Master registry of every machine the API has ever seen.
 *
 * Machines are auto-registered on their first telemetry payload — no manual
 * setup needed. strict:false lets us store any extra identity fields a machine
 * happens to send (location, serial, firmware, etc.) without a schema change.
 */
const machineSchema = new mongoose.Schema(
  {
    machineId:    { type: String, required: true, unique: true, trim: true },
    machineName:  { type: String, trim: true },
    machineType:  { type: String, default: 'UNKNOWN', trim: true, index: true },
    department:   { type: String, trim: true },

    status:       { type: String, default: 'offline' }, // running | idle | stopped | offline
    isActive:     { type: Boolean, default: true },

    registeredAt: { type: Date, default: Date.now },
    lastSeenAt:   { type: Date },
    payloadCount: { type: Number, default: 0 },

    // Anything else the machine reports about itself (free-form).
    meta:         { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, strict: false }
);

export default mongoose.model('Machine', machineSchema);
