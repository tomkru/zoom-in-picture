// POST /api/upload?name=photo.jpg — store an image (raw body, sent as application/octet-stream) in Blob storage.
const { put } = require('@vercel/blob');
const { authorized } = require('./_auth.js');

const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authorized(req, res)) return;
  const raw = String(req.query.name || 'image').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const ext = (raw.match(/\.([a-z0-9]+)$/) || [])[1];
  if (!TYPES[ext]) return res.status(400).json({ error: 'use a jpg, png, webp or gif' });
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!body.length) return res.status(400).json({ error: 'empty upload' });
  const blob = await put('images/' + raw, body, { access: 'public', addRandomSuffix: true, contentType: TYPES[ext] });
  res.status(200).json({ path: blob.url });
}
