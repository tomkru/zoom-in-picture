// Builds dist/the-map.html: one self-contained file (content, photos, styles and script inlined)
// that runs offline, e.g. in a Notion HTML block, where no outside requests are allowed.
//   npm run export            uses content.json from this folder
//   npm run export -- --live  uses what is saved on the live site (its /api/content)
// Photos are downscaled for size (uses Pillow via python3, or macOS `sips`; otherwise the originals).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIVE = 'https://zoom-in-picture.vercel.app/api/content';
const MAX_W = { root: 2560, other: 1400 };
const JPEG_QUALITY = 72;

async function main() {
  const live = process.argv.includes('--live');
  const tree = live ? await (await fetch(LIVE)).json() : JSON.parse(fs.readFileSync(path.join(ROOT, 'content.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'map-export-'));
  let total = 0;

  async function inline(node, isRoot) {
    if (node.image && !node.cutout) {
      const buf = await load(node.image);
      const ext = (node.image.split('?')[0].match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
      const out = shrink(buf, ext, isRoot ? MAX_W.root : MAX_W.other, tmp);
      total += out.buf.length;
      node.image = `data:${out.mime};base64,${out.buf.toString('base64')}`;
      process.stdout.write(`  ${node.id.padEnd(16)} ${(out.buf.length / 1024).toFixed(0).padStart(6)} KB ${out.note}\n`);
    }
    for (const ch of node.children || []) await inline(ch, false);
  }
  await inline(tree, true);

  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  html = html.replace(/\s*<link[^>]*(fonts\.googleapis|fonts\.gstatic)[^>]*>/g, '');   // sandbox: no outside requests
  html = html.replace('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
  html = html.replace('<script src="app.js"></script>',
    `<script>window.__CONTENT__ = ${JSON.stringify(tree)};</script>\n  <script>\n${js.replace(/<\/script/g, '<\\/script')}\n</script>`);
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const file = path.join(ROOT, 'dist', 'the-map.html');
  fs.writeFileSync(file, html);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nwrote dist/the-map.html (${(fs.statSync(file).size / 1048576).toFixed(1)} MB, photos ${(total / 1048576).toFixed(1)} MB)`);
}

async function load(src) {
  if (/^https?:/.test(src)) return Buffer.from(await (await fetch(src)).arrayBuffer());
  return fs.readFileSync(path.join(ROOT, src));
}

function shrink(buf, ext, maxW, tmp) {
  const keepPng = ext === 'png' || ext === 'webp' || ext === 'gif';
  const mimeIn = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
  const src = path.join(tmp, `in.${ext}`), dst = path.join(tmp, keepPng ? 'out.png' : 'out.jpg');
  fs.writeFileSync(src, buf);
  // Pillow gives real JPEG quality control; sips is the fallback; otherwise the original is used.
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(src)}); im.thumbnail((${maxW}, 100000))
${keepPng ? `im.save(${JSON.stringify(dst)}, 'PNG', optimize=True)` : `im.convert('RGB').save(${JSON.stringify(dst)}, 'JPEG', quality=${JPEG_QUALITY}, optimize=True, progressive=True)`}
print(im.size[0])`;
  try {
    const w = execFileSync('python3', ['-c', py], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const out = fs.readFileSync(dst);
    if (out.length < buf.length) return { buf: out, mime: keepPng ? 'image/png' : 'image/jpeg', note: `${w}px` };
    return { buf, mime: mimeIn, note: 'original (already smaller)' };
  } catch (e) { /* no Pillow */ }
  try {
    execFileSync('sips', ['--resampleWidth', String(maxW), '-s', 'format', keepPng ? 'png' : 'jpeg', '-s', 'formatOptions', 'normal', src, '--out', dst], { stdio: 'ignore' });
    const out = fs.readFileSync(dst);
    if (out.length < buf.length) return { buf: out, mime: keepPng ? 'image/png' : 'image/jpeg', note: 'sips' };
  } catch (e) { /* no sips either */ }
  return { buf, mime: mimeIn, note: 'original' };
}

main().catch(e => { console.error(e); process.exit(1); });
