/**
 * End-to-end verification of the dynamic ingest logic against a throwaway
 * in-memory MongoDB. Proves that payloads of UNKNOWN shape are stored verbatim
 * and machines auto-register. Run:  node tests/ingest.verify.mjs
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();

const { connectDB } = await import('../src/config/db.js');
await connectDB();

const Machine = (await import('../src/models/Machine.js')).default;
const Telemetry = (await import('../src/models/Telemetry.js')).default;
const { normalize, persist } = await import('../src/routes/ingest.js');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};

console.log('\n── Test 1: wrapped payload, fully unknown sensor keys ──');
{
  const n = normalize({
    machineId: 'CNC_01', machineType: 'CNC Machining',
    data: { spindleSpeed: 1961, feedRate: 204, weird_sensor_xyz: true },
  });
  await persist(n);
  const t = await Telemetry.findOne({ machineId: 'CNC_01' }).lean();
  check('telemetry stored', !!t);
  check('unknown key spindleSpeed persisted', t.data.spindleSpeed === 1961);
  check('arbitrary key weird_sensor_xyz persisted', t.data.weird_sensor_xyz === true);
  const m = await Machine.findOne({ machineId: 'CNC_01' }).lean();
  check('machine auto-registered', !!m);
  check('machineType captured', m.machineType === 'CNC Machining');
  check('payloadCount incremented', m.payloadCount === 1);
}

console.log('\n── Test 2: loose top-level keys (no data wrapper) ──');
{
  const n = normalize({
    deviceId: 'WASH_07', type: 'Textile Washing',
    waterTemp: 60, rpm: 800, chemDosage: 12.5,
  });
  await persist(n);
  const t = await Telemetry.findOne({ machineId: 'WASH_07' }).lean();
  check('loose keys folded into data', t.data.waterTemp === 60 && t.data.rpm === 800);
  check('id alias (deviceId) resolved', t.machineId === 'WASH_07');
  check('type alias resolved', t.machineType === 'Textile Washing');
}

console.log('\n── Test 3: brand-new machine type never seen before ──');
{
  const n = normalize({
    machineId: 'MYSTERY_99', machineType: 'Quantum Flux Press',
    pressure_kPa: 9999, color: 'violet', nested: { a: 1, b: [1, 2, 3] },
  });
  await persist(n);
  const t = await Telemetry.findOne({ machineId: 'MYSTERY_99' }).lean();
  check('never-seen type accepted', t.machineType === 'Quantum Flux Press');
  check('nested object persisted', t.data.nested.a === 1 && Array.isArray(t.data.nested.b));
}

console.log('\n── Test 4: second payload from same machine → no duplicate master ──');
{
  await persist(normalize({ machineId: 'CNC_01', rpm: 5 }));
  const count = await Machine.countDocuments({ machineId: 'CNC_01' });
  const tCount = await Telemetry.countDocuments({ machineId: 'CNC_01' });
  check('still exactly 1 machine master', count === 1);
  check('2 telemetry rows appended', tCount === 2);
  const m = await Machine.findOne({ machineId: 'CNC_01' }).lean();
  check('payloadCount now 2', m.payloadCount === 2);
}

console.log('\n── Test 5: rejects payload with no machine id ──');
{
  const n = normalize({ temperature: 40, humidity: 80 });
  check('rejected (ok=false)', n.ok === false);
  check('clear error message', /machine identifier/i.test(n.error));
}

console.log(`\n${'═'.repeat(40)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('═'.repeat(40));

await mongoose.disconnect();
await mongod.stop();
process.exit(fail === 0 ? 0 : 1);
