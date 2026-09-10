// GET /api/content — the live map: the saved copy in Blob storage, or the content.json shipped with the deployment.
const { list } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const { blobs } = await list({ prefix: 'content.json', limit: 5 });
    const saved = blobs.find(b => b.pathname === 'content.json');
    if (saved) {
      const r = await fetch(`${saved.url}?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) return res.status(200).send(await r.text());
    }
  } catch (e) {
    console.warn('blob read failed, using shipped content.json:', e.message);
  }
  res.status(200).send(fs.readFileSync(path.join(process.cwd(), 'content.json'), 'utf8'));
}
