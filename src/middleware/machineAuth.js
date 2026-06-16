/**
 * Optional API-key gate for ingest endpoints.
 *
 * - If INGEST_API_KEY is NOT set in .env → all payloads are accepted (handy
 *   during early integration when you're still figuring out the machines).
 * - If it IS set → the machine must send a matching "x-api-key" header.
 */
export function machineAuth(req, res, next) {
  const expected = process.env.INGEST_API_KEY?.trim();
  if (!expected) return next(); // auth disabled

  const provided = req.get('x-api-key');
  if (provided && provided === expected) return next();

  return res.status(401).json({ success: false, error: 'Invalid or missing x-api-key' });
}
