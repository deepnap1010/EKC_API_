import mongoose from 'mongoose';

/**
 * Connect to MongoDB.
 *
 * If MONGO_URI is empty the server still boots — it just runs without a DB so
 * you can verify routes are wired up. Ingest endpoints will return 503 until a
 * URI is provided (see isDbReady()).
 */
export async function connectDB() {
  const uri = process.env.MONGO_URI?.trim();

  if (!uri) {
    console.warn('⚠  MONGO_URI is empty — starting WITHOUT a database.');
    console.warn('   Add your connection string to .env, then restart. Ingest will 503 until then.');
    return;
  }

  mongoose.connection.on('connected', () => console.log('✓ MongoDB connected'));
  mongoose.connection.on('error', (err) => console.error('✗ MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('⚠  MongoDB disconnected'));

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  } catch (err) {
    console.error('✗ Initial MongoDB connection failed:', err.message);
    console.error('   Fix MONGO_URI in .env and restart. Server will keep running.');
  }
}

/** True when a live DB connection is available. Used by route guards. */
export function isDbReady() {
  return mongoose.connection.readyState === 1; // 1 = connected
}
