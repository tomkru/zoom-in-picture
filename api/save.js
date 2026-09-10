// POST /api/save — store the whole map (JSON body) in Blob storage as content.json.
const { put } = require('@vercel/blob');
const { authorized } = require('./_auth.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorized(req, res)) return;
  const tree = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!tree || typeof tree.id !== 'string') return res.status(400).json({ error: 'bad tree' });
  await put('content.json', JSON.stringify(tree, null, 2), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 60,
  });
  res.status(200).json({ ok: true });
}
