// Shared by the admin endpoints: the request must carry the admin key set in Vercel.
function authorized(req, res) {
  const key = process.env.ADMIN_KEY;
  if (!key) { res.status(500).json({ error: 'ADMIN_KEY is not set on the server' }); return false; }
  if (req.headers['x-admin-key'] !== key) { res.status(401).json({ error: 'admin key required' }); return false; }
  return true;
}
module.exports = { authorized };
