(() => {
  'use strict';

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: false });
  const $ = id => document.getElementById(id);
  const labelsEl = $('labels'), crumbsEl = $('crumbs'), panelEl = $('panel');
  const panelTitle = $('panel-title'), panelSub = $('panel-sub'), panelBody = $('panel-body');
  const hintEl = $('hint'), helpEl = $('help'), toastEl = $('toast'), loadingEl = $('loading');
  const loadingText = loadingEl.querySelector('span');
  const editorEl = $('editor');

  const PAPER = '#ece3d3';
  const FADE_START = 0.3, FADE_END = 0.62;   // child screen size / viewport size at which it appears
  const ACTIVE_RATIO = 0.7;
  const GRADE = 'saturate(0.72) sepia(0.28) contrast(0.92) brightness(1.06)';
  const ALPHA_IMG_FRAC = 0.7;   // transparent paintings: subject on the left, blank room for text on the right

  let ROOT = null, nodes = [];
  let vw = 0, vh = 0, dpr = 1, fullDpr = 1;
  let dirty = true, started = false, lastT = 0, lastMove = 0;
  let activeNode = null, hoverNode = null, editing = false, selected = null;
  let highlighted = null;   // a painting singled out by a click: shown alone among its siblings

  // ───────────────── tree ─────────────────
  function prepare(node, parent) {
    node.parent = parent;
    node.depth = parent ? parent.depth + 1 : 0;
    node.children = node.children || [];
    node.imgAspect = node.imgAspect || 1.6;
    node.focus = Object.assign({ x: 0.5, y: 0.5 }, node.focus);
    node.reveal = typeof node.reveal === 'number' ? node.reveal : null;   // screen fraction at which it appears
    node.hasAlpha = !!node.image && /\.(png|webp|gif)(\?|$)/i.test(node.image);   // transparent photo: shows what is behind
    node.textColor = /^#[0-9a-f]{6}$/i.test(node.textColor || '') ? node.textColor.toLowerCase() : TEXT_COLOR;
    if (parent) node.rect = Object.assign({ x: 0.4, y: 0.4, w: 0.2 }, node.rect);
    node.shape = Array.isArray(node.shape) && node.shape.length >= 3 ? node.shape.map(p => [+p[0], +p[1]]) : rectShape();
    node.children.forEach(ch => prepare(ch, node));
  }
  // A frame is a polygon; its points are fractions of the frame's own bounding box (rect).
  const rectShape = () => [[0, 0], [1, 0], [1, 1], [0, 1]];
  const isRectShape = sh => sh.length === 4 && sh.every((p, i) => Math.abs(p[0] - rectShape()[i][0]) < 1e-6 && Math.abs(p[1] - rectShape()[i][1]) < 1e-6);
  function shapeScreen(node, r = rectOf(node)) { return node.shape.map(([u, v]) => [r.x + u * r.w, r.y + v * r.h]); }
  function pointInShape(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function tracePath(pts) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  }
  // Re-derive a frame's bounding box from its points (given in parent fractions) and renormalize.
  function setShapeFromParentPoints(node, pts) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(0.01, Math.max(...xs) - x), h = Math.max(0.01, Math.max(...ys) - y);
    node.rect = { x, y, w, h };
    node.shape = pts.map(p => [(p[0] - x) / w, (p[1] - y) / h]);
  }
  const shapeParentPoints = node => node.shape.map(([u, v]) => [node.rect.x + u * node.rect.w, node.rect.y + v * node.rect.h]);
  function flatten() {
    nodes = [];
    (function walk(n) { nodes.push(n); n.children.forEach(walk); })(ROOT);
  }
  // A frame can be any shape; the photo is cropped to fill it. A frame without a stored
  // height starts out in its photo's own proportions.
  function relayout(node) {
    const p = node.world;
    for (const ch of node.children) {
      if (ch.rect.h == null) ch.rect.h = ch.rect.w * (p.w / p.h) / (ch.hasAlpha ? ch.imgAspect / ALPHA_IMG_FRAC : ch.imgAspect);
      ch.world = { x: p.x + ch.rect.x * p.w, y: p.y + ch.rect.y * p.h, w: ch.rect.w * p.w, h: ch.rect.h * p.h };
      ch.aspect = ch.world.w / ch.world.h;
      relayout(ch);
    }
  }
  function layoutAll() {
    ROOT.aspect = ROOT.imgAspect;
    ROOT.world = { x: 0, y: 0, w: 1, h: 1 / ROOT.aspect };
    relayout(ROOT);
  }
  const isInside = (n, anc) => { for (; n; n = n.parent) if (n === anc) return true; return false; };

  // ───────────────── images ─────────────────
  // Each photo is graded with one warm film look and lettered with its title. Children are not
  // painted into their parents: they stay invisible until you zoom close enough.
  const sources = {}, bitmaps = {}, smalls = {};

  function loadSource(node) {
    return new Promise(resolve => {
      if (!node.image || node.cutout) return resolve();
      const img = new Image();
      img.onload = () => {
        sources[node.id] = img;
        node.imgAspect = img.naturalWidth / img.naturalHeight;
        if (node.hasAlpha) node.hasAlpha = reallyTransparent(img);   // a PNG with no see-through pixels is just a photo
        resolve();
      };
      img.onerror = () => { console.warn(`Could not load image for "${node.id}": ${node.image}`); delete sources[node.id]; resolve(); };
      img.src = node.image;
    });
  }

  function wrapText(g, text, maxW, maxLines) {
    const lines = [];
    let cur = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const t = cur ? cur + ' ' + word : word;
      if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = word; } else cur = t;
      if (lines.length === maxLines) { lines[maxLines - 1] += ' …'; return lines; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // Where a painting's pixels come from: its own photo (cover-cropped to its frame), or for a
  // cutout, the matching region of the nearest ancestor that has a photo. Returned in source pixels.
  function sourceRegion(node) {
    let n = node, r = { x: 0, y: 0, w: 1, h: 1 };   // fractions of n's frame
    while (n.cutout && n.parent) {
      const p = n.parent, q = n.rect;
      r = { x: q.x + r.x * q.w, y: q.y + r.y * q.h, w: r.w * q.w, h: r.h * q.h };
      n = p;
    }
    const img = sources[n.id];
    if (!img) return null;
    const iw = img.naturalWidth, ih = img.naturalHeight, A = n.aspect, I = n.imgAspect;
    const fx = n.hasAlpha ? 1 : I > A ? A / I : 1, fy = n.hasAlpha ? 1 : I > A ? 1 : I / A;   // visible fraction of the photo (transparent ones are never cropped)
    const ox = (1 - fx) * n.focus.x, oy = (1 - fy) * n.focus.y;
    return { img, sx: (ox + r.x * fx) * iw, sy: (oy + r.y * fy) * ih, sw: r.w * fx * iw, sh: r.h * fy * ih };
  }

  // Formats that can carry transparency are checked for actual see-through pixels.
  function reallyTransparent(img) {
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 48, 48);
    const d = g.getImageData(0, 0, 48, 48).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }

  async function compose(node) {
    const src = sourceRegion(node);
    const W = Math.min(node === ROOT ? 3200 : 2048, src ? Math.max(1024, Math.round(src.sw)) : 2048);
    const H = Math.round(W / node.aspect);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    let place = [0, 0, W, H];   // where the photo lands in the frame
    if (src && node.hasAlpha) {
      const colW = W * ALPHA_IMG_FRAC, k = Math.min(colW / src.sw, H / src.sh);
      const iw = src.sw * k, ih = src.sh * k;
      place = [(colW - iw) / 2, (H - ih) / 2, iw, ih];
    }
    if (src) {
      g.filter = GRADE;
      g.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, ...place);
      g.filter = 'none';
    } else {
      g.fillStyle = '#e4d8c4';
      g.fillRect(0, 0, W, H);
    }
    g.globalCompositeOperation = 'soft-light';
    g.fillStyle = '#d9b98a';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    const vig = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
    vig.addColorStop(0, 'rgba(40,25,10,0)');
    vig.addColorStop(1, 'rgba(40,25,10,0.42)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);
    if (src && node.hasAlpha) {
      // keep the photo's transparency: cut the wash and vignette back to its alpha
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, ...place);
      g.globalCompositeOperation = 'source-over';
    }

    // where the lettering goes: inside the shape, clear of hidden paintings, top-right preferred;
    // for transparent paintings, the blank column beside the subject
    const pad = 0.045;
    const layout = (scale, colFrac = 0.42 * scale) => {
      const size = Math.round(H * 0.075 * scale), lineH = Math.round(H * 0.042 * scale);
      g.font = `700 ${size}px Caveat, cursive`;
      const titleLines = wrapText(g, node.title || '', W * colFrac, 2);
      const titleW = Math.max(0, ...titleLines.map(t => g.measureText(t).width)) / W;
      g.font = `500 ${Math.round(lineH * 0.78)}px 'Cormorant Garamond', Georgia, serif`;
      const lines = wrapText(g, node.body || '', W * colFrac, 8);
      const blockH = size * (0.1 + titleLines.length) + (node.subtitle ? size * 0.62 : 0) + (lines.length ? lineH * 0.6 + lines.length * lineH : 0);
      return { scale, size, lineH, lines, titleLines, titleW, bw: colFrac + 2 * pad, bh: blockH / H + 2 * pad * (W / H) };
    };
    const kids = node.children.map(ch => ch.rect);
    // Score every candidate spot: mostly inside the shape, clear of hidden paintings, as large
    // as possible, top-right preferred. A slight overhang beats hiding the text behind a card.
    const insideFrac = (bx, by, bw, bh) => {
      if (node === ROOT) return 1;
      let n = 0;
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const u = bx + (i / 4) * bw, v = by + (j / 4) * bh;
        if (u >= 0 && v >= 0 && u <= 1 && v <= 1 && pointInShape(node.shape, u, v)) n++;
      }
      return n / 25;
    };
    const kidOverlap = (bx, by, bw, bh) => kids.reduce((sum, r) => {
      const ix = Math.max(0, Math.min(bx + bw, r.x + r.w) - Math.max(bx, r.x));
      const iy = Math.max(0, Math.min(by + bh, r.y + r.h) - Math.max(by, r.y));
      return sum + ix * iy;
    }, 0) / (bw * bh);
    let L = layout(1), pos = null, best = Infinity, right = false;
    if (node.hasAlpha) {
      // text beside the subject, in the blank right part of the frame
      const colFrac = 1 - ALPHA_IMG_FRAC - 3 * pad;
      for (const scale of [1, 0.85, 0.7, 0.55, 0.45, 0.35]) {
        L = layout(scale, colFrac);
        if (L.titleW <= colFrac && L.bh <= 0.96) break;
      }
      pos = { bx: ALPHA_IMG_FRAC, by: 0 };   // top-right corner, beside the subject
    } else for (const scale of [1, 0.85, 0.7, 0.55, 0.45]) {
      const Ls = layout(scale);
      const steps = 8;
      for (let j = 0; j <= steps; j++) for (let i = steps; i >= 0; i--) {
        const bx = (i / steps) * (1 - Ls.bw), by = (j / steps) * (1 - Ls.bh);
        const inside = insideFrac(bx, by, Ls.bw, Ls.bh);
        if (inside < 0.6) continue;
        const score = 2 * kidOverlap(bx, by, Ls.bw, Ls.bh) + 1.5 * (1 - inside) + 0.3 * (1 - scale) + 0.05 * ((1 - bx) + by);
        if (score < best) { best = score; pos = { bx, by }; L = Ls; }
      }
    }
    if (!pos) { L = layout(1); pos = { bx: 1 - L.bw, by: 0 }; }
    if (!node.hasAlpha) right = pos.bx + L.bw / 2 > 0.5;
    // Lettering is drawn live (see drawLetter) so it stays readable at any zoom; only its place is decided here.
    node.letter = { bx: pos.bx, by: pos.by, bw: L.bw, bh: L.bh, right, scale: L.scale, colFrac: L.bw - 2 * pad };

    let full = c, small = null;
    try {
      if (window.createImageBitmap) {
        full = await createImageBitmap(c);
        small = await createImageBitmap(c, { resizeWidth: 640, resizeHeight: Math.max(1, Math.round(640 / node.aspect)), resizeQuality: 'high' });
      }
    } catch (e) { /* keep the canvas */ }
    bitmaps[node.id] = full;
    smalls[node.id] = small;
    dirty = true;
  }

  // ───────────────── camera ─────────────────
  const cam = { s: 1, cx: 0.5, cy: 0.3 };
  const tgt = { s: 1, cx: 0.5, cy: 0.3 };
  let anchor = null;   // world point kept under a screen point while a zoom animates
  const RATE = 12;     // camera easing per second; lower is slower
  let animRate = RATE;
  let tween = null;    // a timed flight: { from, to, t0, ms } — used for the prev/next glide

  function rectOf(node, c = cam) {
    const w = node.world;
    return { x: (w.x - c.cx) * c.s + vw / 2, y: (w.y - c.cy) * c.s + vh / 2, w: w.w * c.s, h: w.h * c.s };
  }
  function visibleFraction(r) {
    const ix = Math.max(0, Math.min(vw, r.x + r.w) - Math.max(0, r.x));
    const iy = Math.max(0, Math.min(vh, r.y + r.h) - Math.max(0, r.y));
    return (ix * iy) / (r.w * r.h);
  }
  function coverage(r) {
    const ix = Math.max(0, Math.min(vw, r.x + r.w) - Math.max(0, r.x));
    const iy = Math.max(0, Math.min(vh, r.y + r.h) - Math.max(0, r.y));
    return (ix * iy) / (vw * vh);
  }
  const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const sizeRatio = r => Math.max(r.w / vw, r.h / vh);
  function childAlpha(r, node) {
    const start = node && node.reveal != null ? node.reveal : FADE_START;
    const end = node && node.reveal != null ? Math.min(1, start * 2.1) : FADE_END;
    return smooth((sizeRatio(r) - start) / (end - start));
  }

  // Deepest node whose image fully covers the viewport (everything above it is hidden).
  function coverNode(c = cam) {
    let n = ROOT;
    outer: for (;;) {
      for (const ch of n.children) {
        if (!bitmaps[ch.id] || !isRectShape(ch.shape) || ch.hasAlpha) continue;   // shaped or transparent paintings never hide what is behind
        const r = rectOf(ch, c);
        if (r.x <= 0.5 && r.y <= 0.5 && r.x + r.w >= vw - 0.5 && r.y + r.h >= vh - 0.5) { n = ch; continue outer; }
      }
      return n;
    }
  }
  // Deepest node that dominates the view (drives captions, labels, breadcrumbs).
  function computeActive(c = cam) {
    let n = ROOT;
    outer: for (;;) {
      for (const ch of n.children) {
        const r = rectOf(ch, c);
        if (sizeRatio(r) >= ACTIVE_RATIO && (visibleFraction(r) >= 0.5 || coverage(r) >= 0.5)) { n = ch; continue outer; }
      }
      return n;
    }
  }

  function fitCam(node, margin = 0.9) {
    const w = node.world;
    return { s: margin * Math.min(vw / w.w, vh / w.h), cx: w.x + w.w / 2, cy: w.y + w.h / 2 };
  }
  // Deepest painting containing a world point: how far you may zoom depends on it.
  function nodeAt(wx, wy) {
    let n = ROOT;
    outer: for (;;) {
      for (const ch of n.children) {
        const w = ch.world;
        if (wx >= w.x && wx <= w.x + w.w && wy >= w.y && wy <= w.y + w.h) { n = ch; continue outer; }
      }
      return n;
    }
  }
  function clampTarget(wx = tgt.cx, wy = tgt.cy) {
    const rw = ROOT.world.w, rh = ROOT.world.h;
    const fit = Math.min(vw / rw, vh / rh);
    const at = nodeAt(wx, wy);
    const sMax = (at.children.length ? 8 : 2.5) * Math.max(vw / at.world.w, vh / at.world.h);
    tgt.s = Math.min(Math.max(tgt.s, fit * 0.55), Math.max(sMax, fit));
    const hw = vw / 2 / tgt.s, hh = vh / 2 / tgt.s;
    tgt.cx = rw * tgt.s <= vw ? rw / 2 : Math.min(Math.max(tgt.cx, hw), rw - hw);
    tgt.cy = rh * tgt.s <= vh ? rh / 2 : Math.min(Math.max(tgt.cy, hh), rh - hh);
    lastMove = performance.now();
    dirty = true;
  }
  function zoomAt(f, mx, my) {
    // anchor on the point the user actually sees under the cursor (the current camera)
    const wx = cam.cx + (mx - vw / 2) / cam.s, wy = cam.cy + (my - vh / 2) / cam.s;
    tgt.s *= f;
    clampTarget(wx, wy);
    tgt.cx = wx - (mx - vw / 2) / tgt.s;
    tgt.cy = wy - (my - vh / 2) / tgt.s;
    clampTarget(wx, wy);
    anchor = { wx, wy, sx: mx, sy: my };
    animRate = RATE;
    tween = null;
  }
  function panBy(dx, dy) {
    tween = null;
    tgt.cx -= dx / tgt.s; tgt.cy -= dy / tgt.s;
    cam.cx -= dx / cam.s; cam.cy -= dy / cam.s;
    if (anchor) { anchor.sx += dx; anchor.sy += dy; }
    clampTarget();
  }
  function flyTo(node, margin = 0.9, ms = 0) {
    if (!node) return;
    anchor = null;
    animRate = RATE;
    Object.assign(tgt, fitCam(node, margin));
    clampTarget();
    tween = ms ? { from: { ...cam }, to: { ...tgt }, t0: performance.now(), ms } : null;
  }

  // ───────────────── drawing ─────────────────
  // Text on the paintings, drawn each frame: sized to the frame but capped in screen pixels,
  // and re-flowed to the column width, so it stays readable when you zoom far in.
  const TITLE_MAX = 42, LINE_MAX = 24, TEXT_COLOR = '#f6efe3';
  const isDark = hex => (parseInt(hex.slice(1, 3), 16) * 0.299 + parseInt(hex.slice(3, 5), 16) * 0.587 + parseInt(hex.slice(5, 7), 16) * 0.114) < 140;
  const wrapCache = new Map();
  function wrapCached(key, text, maxW, maxLines) {
    const k = `${key}|${Math.round(maxW / 4)}|${ctx.font}`;
    let v = wrapCache.get(k);
    if (!v) {
      if (wrapCache.size > 600) wrapCache.clear();
      v = wrapText(ctx, text, maxW, maxLines);
      wrapCache.set(k, v);
    }
    return v;
  }
  function drawLetter(node, r, alpha) {
    const Lt = node.letter;
    if (!Lt) return;
    const size = Math.min(r.h * 0.075 * Lt.scale, TITLE_MAX);
    if (size < 7) return;
    const lineH = Math.min(r.h * 0.042 * Lt.scale, LINE_MAX);
    const pad = 0.045 * r.w;
    const colPx = Math.max(40, Lt.colFrac * r.w);
    const x = Lt.right ? r.x + (Lt.bx + Lt.bw) * r.w - pad : r.x + Lt.bx * r.w + pad;
    let y = r.y + Lt.by * r.h + Math.min(pad, size) + size;
    const dir = Lt.right ? -1 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = Lt.right ? 'right' : 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = isDark(node.textColor) ? 'rgba(255,250,240,0.6)' : 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.3; ctx.shadowOffsetY = size * 0.04;
    ctx.fillStyle = node.textColor;
    // the title shrinks (down to 55%) until it fits the column in at most two lines
    let tSize = size, titleLines;
    for (const f of [1, 0.9, 0.8, 0.7, 0.62, 0.55]) {
      tSize = size * f;
      ctx.font = `700 ${tSize}px Caveat, cursive`;
      titleLines = wrapCached(node.id + '|t', node.title || '', colPx, 9);
      if (titleLines.length <= 2 && titleLines.every(t => ctx.measureText(t).width <= colPx + 1)) break;
    }
    titleLines = titleLines.slice(0, 2);
    titleLines.forEach((t, i) => ctx.fillText(t, x, y + i * tSize));
    y += (titleLines.length - 1) * tSize;
    if (node.subtitle) {
      y += size * 0.62;
      ctx.font = `500 ${size * 0.55}px Caveat, cursive`;
      ctx.globalAlpha = alpha * 0.85;
      ctx.fillText(node.subtitle, x + dir * size * 0.08, y);
    }
    if (node.body && lineH >= 9) {
      ctx.font = `500 ${lineH * 0.78}px 'Cormorant Garamond', Georgia, serif`;
      ctx.shadowBlur = lineH * 0.5;
      ctx.globalAlpha = alpha * 0.95;
      const lines = wrapCached(node.id + '|b', node.body, colPx, 8);
      y += lineH * 0.6;
      for (const ln of lines) { y += lineH; ctx.fillText(ln, x + dir * size * 0.08, y); }
    }
    ctx.restore();
  }
  function drawNode(node, alpha) {
    const r = rectOf(node);
    if (r.x > vw || r.y > vh || r.x + r.w < 0 || r.y + r.h < 0 || r.w < 2) return;
    ctx.globalAlpha = alpha;
    const bmp = (r.w < 600 && smalls[node.id]) || bitmaps[node.id];
    const clip = node.parent && !isRectShape(node.shape);
    if (clip) { ctx.save(); tracePath(shapeScreen(node, r)); ctx.clip(); }
    if (bmp) ctx.drawImage(bmp, r.x, r.y, r.w, r.h);
    else { ctx.fillStyle = '#d8ccb6'; ctx.fillRect(r.x, r.y, r.w, r.h); }
    if (clip) ctx.restore();
    drawLetter(node, r, alpha);
    for (const ch of node.children) {
      let a = editing ? 1 : childAlpha(rectOf(ch), ch);
      if (!editing && highlighted && highlighted.parent === node) a = ch === highlighted ? 1 : 0;
      if (a > 0) drawNode(ch, alpha * a);
    }
  }
  function drawHighlight() {
    const r = rectOf(highlighted);
    ctx.save();
    ctx.globalAlpha = 1;
    tracePath(shapeScreen(highlighted, r));
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 12;
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#f6efe3'; ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(47,38,32,0.6)'; ctx.stroke();
    ctx.restore();
  }
  const HANDLE = 12;   // the resize square sits just outside the bottom-right corner
  function editShown() {
    const list = activeNode.children.slice();
    if (selected && selected.parent && !list.includes(selected)) list.push(selected);
    return list;
  }
  function drawEdit() {
    for (const ch of editShown()) {
      const r = rectOf(ch);
      const sel = ch === selected;
      const pts = shapeScreen(ch, r);
      ctx.globalAlpha = 1;
      ctx.setLineDash(sel ? [] : [6, 4]);
      ctx.strokeStyle = sel ? '#c0392b' : 'rgba(192,57,43,0.7)';
      ctx.lineWidth = sel ? 2 : 1.2;
      tracePath(pts); ctx.stroke();
      if (sel) {
        ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(192,57,43,0.5)';
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#c0392b';
        ctx.fillRect(r.x + r.w + HANDLE - 6, r.y + r.h + HANDLE - 6, 12, 12);
        for (const [x, y] of pts) {
          ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = '#fff6e8'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#c0392b'; ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, vw, vh);
    drawNode(coverNode(), 1);
    ctx.globalAlpha = 1;
    if (editing) drawEdit();
    else if (highlighted) drawHighlight();
    drawMinimap();
  }

  // ───────────────── minimap ─────────────────
  // Shows the painting you are in (the map, or the frame you have zoomed into), dots for the
  // paintings hidden inside it, the part on screen, and one border line per level of depth.
  const mini = $('minimap');
  const mctx = mini.getContext('2d');
  function miniSize(aspect) {
    const w = mini.clientWidth || 200, h = Math.round(w / aspect);
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (mini.width !== Math.round(w * d) || mini.height !== Math.round(h * d)) {
      mini.style.height = h + 'px';
      mini.width = Math.round(w * d); mini.height = Math.round(h * d);
    }
    return { w, h, d };
  }
  function drawMinimap() {
    if (mini.hidden || editing) return;
    const node = activeNode || ROOT;
    const { w, h, d } = miniSize(node.aspect);
    mctx.setTransform(d, 0, 0, d, 0, 0);
    const bmp = smalls[node.id] || bitmaps[node.id];
    mctx.fillStyle = PAPER; mctx.fillRect(0, 0, w, h);
    if (bmp) mctx.drawImage(bmp, 0, 0, w, h);
    mctx.fillStyle = 'rgba(236,227,211,0.35)'; mctx.fillRect(0, 0, w, h);
    // the part of this painting on screen
    const k = w / node.world.w;
    let x = (cam.cx - vw / 2 / cam.s - node.world.x) * k, y = (cam.cy - vh / 2 / cam.s - node.world.y) * k;
    let rw = vw / cam.s * k, rh = vh / cam.s * k;
    if (rw < 6 || rh < 6) { const cx = x + rw / 2, cy = y + rh / 2; rw = Math.max(rw, 6); rh = Math.max(rh, 6); x = cx - rw / 2; y = cy - rh / 2; }
    mctx.save();
    mctx.beginPath(); mctx.rect(0, 0, w, h); mctx.rect(x, y, rw, rh); mctx.clip('evenodd');
    mctx.fillStyle = 'rgba(47,38,32,0.28)'; mctx.fillRect(0, 0, w, h);
    mctx.restore();
    mctx.strokeStyle = '#f6efe3'; mctx.lineWidth = 1.5; mctx.strokeRect(x + 0.5, y + 0.5, rw, rh);
    // dots where paintings hide
    for (const ch of node.children) {
      const cx = (ch.rect.x + ch.rect.w / 2) * w, cy = (ch.rect.y + ch.rect.h / 2) * h;
      mctx.beginPath(); mctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      mctx.fillStyle = '#f6efe3'; mctx.fill();
      mctx.lineWidth = 1.2; mctx.strokeStyle = '#2f2620'; mctx.stroke();
    }
    // one border line per level you are inside
    for (let i = 0; i < node.depth; i++) {
      const o = 1.5 + i * 3;
      mctx.lineWidth = 1; mctx.strokeStyle = i ? 'rgba(47,38,32,0.55)' : 'rgba(47,38,32,0.8)';
      mctx.strokeRect(o, o, w - 2 * o, h - 2 * o);
    }
  }
  function miniPan(e) {
    const node = activeNode || ROOT;
    const r = mini.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    anchor = null;
    tgt.cx = node.world.x + u * node.world.w; tgt.cy = node.world.y + v * node.world.h;
    clampTarget();
  }
  let miniDown = false;
  mini.addEventListener('pointerdown', e => { miniDown = true; mini.setPointerCapture(e.pointerId); miniPan(e); hideHint(); });
  mini.addEventListener('pointermove', e => { if (miniDown) miniPan(e); });
  mini.addEventListener('pointerup', () => (miniDown = false));
  mini.addEventListener('pointercancel', () => (miniDown = false));
  mini.addEventListener('wheel', e => { e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.012), vw / 2, vh / 2); }, { passive: false });

  // ───────────────── UI ─────────────────
  const labelEls = {};
  function updateLabels() {
    const keep = new Set();
    for (const ch of activeNode.children) {
      const r = rectOf(ch);
      keep.add(ch.id);
      let el = labelEls[ch.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'label';
        labelsEl.appendChild(el);
        labelEls[ch.id] = el;
      }
      el.textContent = ch.title || ch.id;
      const size = Math.round(Math.max(14, Math.min(28, r.w * 0.075)));
      el.style.fontSize = size + 'px';
      el.style.transform = `translate(${(r.x + r.w / 2).toFixed(1)}px, ${(r.y + r.h + 4).toFixed(1)}px) translate(-50%, 0) rotate(-1.5deg)`;
      const show = editing ? 0.9 : ch === highlighted ? 0.9 : ch === hoverNode && !highlighted ? 0.9 * (1 - childAlpha(r, ch)) : 0;
      el.style.opacity = r.w < 24 ? 0 : show;
    }
    for (const id in labelEls) {
      if (!keep.has(id)) { labelEls[id].remove(); delete labelEls[id]; }
    }
  }

  function renderCrumbs() {
    crumbsEl.innerHTML = '';
    const path = [];
    for (let n = activeNode; n; n = n.parent) path.unshift(n);
    path.forEach((n, i) => {
      if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = ' › '; crumbsEl.appendChild(s); }
      const a = document.createElement('a');
      a.textContent = n.title || n.id;
      if (n === activeNode) a.className = 'current'; else a.onclick = () => flyTo(n);
      crumbsEl.appendChild(a);
    });
  }
  function renderPanel() {
    panelTitle.textContent = activeNode.title || '';
    panelSub.textContent = activeNode.subtitle || '';
    panelBody.textContent = activeNode.body || '';
  }
  function setActive(node) {
    if (node === activeNode) return;
    activeNode = node;
    hoverNode = null;
    if (highlighted && highlighted.parent !== node) highlighted = null;
    panelEl.classList.add('swap');
    setTimeout(() => { renderPanel(); panelEl.classList.remove('swap'); }, 200);
    renderCrumbs();
    updateNav();
    if (editing) fillEditor();   // selection stays put while zooming
  }
  function updateNav() {
    const i = nodes.indexOf(activeNode);
    $('btn-prev').disabled = i <= 0;
    $('btn-next').disabled = i >= nodes.length - 1;
    $('btn-up').disabled = !activeNode.parent;
    $('btn-home').disabled = activeNode === ROOT;
  }

  function hideHint() { hintEl.classList.add('gone'); }
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false; toastEl.style.opacity = 1;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = 0; setTimeout(() => (toastEl.hidden = true), 300); }, 1800);
  }

  // ───────────────── loop ─────────────────
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.5, (t - lastT) / 1000 || 0.016);
    lastT = t;
    const ls = Math.log(cam.s), lt = Math.log(tgt.s);
    const converged = Math.abs(lt - ls) < 1e-4 && Math.abs(tgt.cx - cam.cx) * cam.s < 0.05 && Math.abs(tgt.cy - cam.cy) * cam.s < 0.05;
    if (tween) {
      // timed glide with a gentle ease in and out
      const u = Math.min(1, (t - tween.t0) / tween.ms), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      cam.s = Math.exp(Math.log(tween.from.s) + (Math.log(tween.to.s) - Math.log(tween.from.s)) * e);
      cam.cx = tween.from.cx + (tween.to.cx - tween.from.cx) * e;
      cam.cy = tween.from.cy + (tween.to.cy - tween.from.cy) * e;
      if (u >= 1) tween = null;
      lastMove = t;
      dirty = true;
    } else if (!converged) {
      const k = 1 - Math.exp(-dt * animRate);
      cam.s = Math.exp(ls + (lt - ls) * k);
      if (anchor) {
        // Keep the point under the cursor fixed while the scale eases; the offset is whatever
        // the edge clamp moved the target by.
        const ox = tgt.cx - (anchor.wx - (anchor.sx - vw / 2) / tgt.s);
        const oy = tgt.cy - (anchor.wy - (anchor.sy - vh / 2) / tgt.s);
        cam.cx = anchor.wx - (anchor.sx - vw / 2) / cam.s + ox;
        cam.cy = anchor.wy - (anchor.sy - vh / 2) / cam.s + oy;
      } else {
        cam.cx += (tgt.cx - cam.cx) * k;
        cam.cy += (tgt.cy - cam.cy) * k;
      }
      dirty = true;
    } else if (cam.s !== tgt.s || cam.cx !== tgt.cx || cam.cy !== tgt.cy) {
      cam.s = tgt.s; cam.cx = tgt.cx; cam.cy = tgt.cy;
      anchor = null;
      animRate = RATE;
      dirty = true;
    }
    // Render at 1x while the camera moves, at full retina resolution once it settles.
    const moving = !converged || t - lastMove < 150;
    const wantDpr = moving ? 1 : fullDpr;
    if (wantDpr !== dpr) { setCanvasSize(wantDpr); dirty = true; }
    if (moving) dirty = true;
    if (!dirty) return;
    dirty = false;
    setActive(computeActive());
    draw();
    updateLabels();
    if (editing) updateZoomReadout();
  }

  function setCanvasSize(d) {
    dpr = d;
    canvas.width = Math.round(vw * d); canvas.height = Math.round(vh * d);
  }
  function resize() {
    fullDpr = Math.min(2, window.devicePixelRatio || 1);
    vw = window.innerWidth; vh = window.innerHeight;
    setCanvasSize(fullDpr);
    if (started) clampTarget();
    dirty = true;
  }
  window.addEventListener('resize', resize);

  function start() {
    if (started) return;
    started = true;
    resize();
    const fit = fitCam(ROOT, 0.9);
    Object.assign(tgt, fit);
    Object.assign(cam, { s: fit.s * 0.7, cx: fit.cx, cy: fit.cy });
    activeNode = null;
    setActive(ROOT);
    renderPanel();
    loadingEl.classList.add('gone');
    requestAnimationFrame(frame);
    window.MAP = { cam, tgt, nodes: () => nodes, active: () => activeNode, rectOf, nodeAt, flyTo };
  }

  (async () => {
    try {
      if (window.__CONTENT__) {
        // a self-contained export (see tools/export-static.js): everything is inlined, nothing can be saved
        ROOT = window.__CONTENT__;
        document.body.classList.add('static');
      } else {
        // the live map from the server (saved edits), falling back to the file next to the page
        let r = await fetch('/api/content', { cache: 'no-store' }).catch(() => null);
        if (!r || !r.ok) r = await fetch('content.json', { cache: 'no-store' });
        if (!r.ok) throw new Error(`content: ${r.status}`);
        ROOT = await r.json();
      }
    } catch (e) {
      loadingText.textContent = 'could not load content.json — run: npm run serve';
      throw e;
    }
    prepare(ROOT, null);
    flatten();
    let loaded = 0;
    await Promise.all([
      ...nodes.map(n => loadSource(n).then(() => { loadingText.textContent = `painting… ${++loaded} / ${nodes.length}`; })),
      document.fonts ? document.fonts.load('700 40px Caveat').catch(() => {}) : null,
      document.fonts ? document.fonts.load("500 20px 'Cormorant Garamond'").catch(() => {}) : null,
    ]);
    layoutAll();
    await Promise.all(nodes.map(compose));
    if (window.__CONTENT__) {
      // read-only export: the decoded photos are only needed where cutouts read from them
      const hasCutoutBelow = n => n.children.some(c => c.cutout || hasCutoutBelow(c));
      for (const n of nodes) if (!hasCutoutBelow(n)) delete sources[n.id];
    }
    start();
  })();

  // ───────────────── input ─────────────────
  const pointers = new Map();
  let drag = null, pinch = null;

  function hitChild(x, y) {
    for (const ch of activeNode.children) {
      const r = rectOf(ch);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && r.w >= 6 && pointInShape(shapeScreen(ch, r), x, y)) return ch;
    }
    return null;
  }
  function vertexAt(node, x, y) {
    const pts = shapeScreen(node);
    return pts.findIndex(p => Math.hypot(p[0] - x, p[1] - y) <= 9);
  }
  function edgeAt(node, x, y) {
    const pts = shapeScreen(node);
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      const L = Math.hypot(bx - ax, by - ay) || 1;
      const t = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (L * L)));
      if (Math.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y) <= 8) return i;
    }
    return -1;
  }
  function editHit(x, y, shift) {
    const sel = selected && selected.parent ? selected : null;
    if (sel) {
      const r = rectOf(sel);
      if (Math.abs(x - (r.x + r.w + HANDLE)) <= 9 && Math.abs(y - (r.y + r.h + HANDLE)) <= 9) return { mode: 'resize', node: sel, ratio: sel.rect.h / sel.rect.w };
      const vi = vertexAt(sel, x, y);
      if (vi >= 0) return { mode: 'vertex', node: sel, index: vi };
      const inBox = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      if (shift && inBox && !isInside(activeNode, sel)) return { mode: 'focus', node: sel };
    }
    // paintings inside the one you are in come before the selected painting's body
    const ch = hitChild(x, y) || activeNode.children.find(c => edgeAt(c, x, y) >= 0);
    if (ch) return { mode: 'move', node: ch };
    if (sel && !isInside(activeNode, sel)) {
      const r = rectOf(sel);
      const inBox = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      if (edgeAt(sel, x, y) >= 0 || (inBox && pointInShape(shapeScreen(sel, r), x, y))) return { mode: 'move', node: sel };
    }
    return null;
  }

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hideHint();
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, mode: 'pan' };
      if (editing) {
        const hit = editHit(e.clientX, e.clientY, e.shiftKey);
        if (hit) { Object.assign(drag, hit); select(hit.node); }
        else select(activeNode);
      }
      canvas.classList.add('grabbing');
    } else if (pointers.size === 2) {
      drag = null;
      pinch = null;
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinch) {
        zoomAt(dist / pinch.dist, mid.x, mid.y);
        panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
      }
      pinch = { dist, mid };
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
      if (drag.mode === 'pan') panBy(dx, dy);
      else {
        const n = drag.node, rc = n.rect;
        const pr = rectOf(n.parent);
        if (drag.mode === 'move') { rc.x += dx / pr.w; rc.y += dy / pr.h; }
        else if (drag.mode === 'resize') {
          rc.w = Math.max(0.02, rc.w + dx / pr.w);
          rc.h = e.shiftKey ? rc.w * drag.ratio : Math.max(0.02, rc.h + dy / pr.h);
        } else if (drag.mode === 'vertex') {
          const pts = shapeParentPoints(n);
          pts[drag.index] = [(e.clientX - pr.x) / pr.w, (e.clientY - pr.y) / pr.h];
          setShapeFromParentPoints(n, pts);
        } else {
          // slide the photo inside its frame
          const r = rectOf(n);
          const overX = (n.imgAspect / n.aspect - 1) * r.w, overY = (n.aspect / n.imgAspect - 1) * r.h;
          if (overX > 1) n.focus.x = Math.min(1, Math.max(0, n.focus.x - dx / overX));
          if (overY > 1) n.focus.y = Math.min(1, Math.max(0, n.focus.y - dy / overY));
          recompose(n, 120);
        }
        if (drag.mode !== 'vertex') {
          n.rect.x = Math.min(Math.max(n.rect.x, 0), Math.max(0, 1 - n.rect.w));
          n.rect.y = Math.min(Math.max(n.rect.y, 0), Math.max(0, 1 - n.rect.h));
        }
        relayout(n.parent);
        dirty = true;
      }
      return;
    }
    const h = editing ? null : hitChild(e.clientX, e.clientY);
    if (h !== hoverNode) { hoverNode = h; dirty = true; }
    canvas.classList.toggle('zoomable', !!h);
  });
  function pointerEnd(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && !editing && e.type === 'pointerup') {
      const h = hitChild(e.clientX, e.clientY);
      highlighted = h && h !== highlighted ? h : null;
      dirty = true;
    }
    if (drag && drag.mode !== 'pan' && drag.moved) {
      recompose(drag.node.parent);
      (function all(n) { recompose(n); n.children.forEach(all); })(drag.node);
      save();
    }
    drag = null;
    canvas.classList.remove('grabbing');
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('lostpointercapture', pointerEnd);

  // Miro-style: pinch (ctrl/cmd + wheel) zooms, two-finger scrolling pans.
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    hideHint();
    let dy = e.deltaY, dx = e.deltaX;
    if (e.deltaMode === 1) { dy *= 16; dx *= 16; } else if (e.deltaMode === 2) { dy *= vh; dx *= vw; }
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-dy * 0.012), e.clientX, e.clientY);
    else panBy(-dx, -dy);
  }, { passive: false });

  canvas.addEventListener('dblclick', e => {
    if (editing) {
      const near = c => vertexAt(c, e.clientX, e.clientY) >= 0 || edgeAt(c, e.clientX, e.clientY) >= 0;
      const n = selected && selected.parent && near(selected) ? selected : activeNode.children.find(near);
      if (!n) return;
      select(n);
      const vi = vertexAt(n, e.clientX, e.clientY);
      const pts = shapeParentPoints(n);
      if (vi >= 0) { if (pts.length <= 3) return; pts.splice(vi, 1); }
      else {
        const ei = edgeAt(n, e.clientX, e.clientY);
        if (ei < 0) return;
        const pr = rectOf(n.parent);
        pts.splice(ei + 1, 0, [(e.clientX - pr.x) / pr.w, (e.clientY - pr.y) / pr.h]);
      }
      setShapeFromParentPoints(n, pts);
      relayout(n.parent);
      (function all(m) { recompose(m); m.children.forEach(all); })(n);
      recompose(n.parent);
      save();
      dirty = true;
      return;
    }
    const h = hitChild(e.clientX, e.clientY);
    if (h) { highlighted = h; flyTo(h); return; }
    zoomAt(2, e.clientX, e.clientY);
  });

  function step(dir) {
    const i = nodes.indexOf(activeNode) + dir;
    if (i >= 0 && i < nodes.length) flyTo(nodes[i], 0.9, 2500);   // a slow 2.5 s glide between paintings
  }
  $('btn-prev').onclick = () => step(-1);
  $('btn-next').onclick = () => step(1);
  $('btn-up').onclick = () => flyTo(activeNode.parent);
  $('btn-home').onclick = () => flyTo(ROOT);
  $('btn-help').onclick = () => (helpEl.hidden = !helpEl.hidden);
  $('btn-edit').onclick = () => setEditing(!editing);

  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const pan = 60;
    switch (e.key) {
      case 'ArrowLeft': step(-1); break;
      case 'ArrowRight': step(1); break;
      case 'ArrowUp': case 'Escape':
        if (!helpEl.hidden) helpEl.hidden = true;
        else if (editing && e.key === 'Escape') setEditing(false);
        else if (highlighted && e.key === 'Escape') { highlighted = null; dirty = true; }
        else flyTo(activeNode.parent);
        break;
      case 'ArrowDown': flyTo(activeNode.children[0]); break;
      case 'Home': flyTo(ROOT); break;
      case '+': case '=': zoomAt(1.5, vw / 2, vh / 2); break;
      case '-': case '_': zoomAt(1 / 1.5, vw / 2, vh / 2); break;
      case 'w': panBy(0, pan); break;
      case 's': panBy(0, -pan); break;
      case 'a': panBy(pan, 0); break;
      case 'd': panBy(-pan, 0); break;
      case 'e': case 'E': setEditing(!editing); break;
      case '?': helpEl.hidden = !helpEl.hidden; break;
      default: return;
    }
    e.preventDefault();
    hideHint();
  });

  // ───────────────── editor ─────────────────
  const ed = {
    path: $('ed-path'), title: $('ed-title'), subtitle: $('ed-subtitle'), body: $('ed-body'),
    image: $('ed-image'), download: $('ed-download'), del: $('ed-delete'), parent: $('ed-parent'), list: $('ed-children'),
    add: $('ed-add'), addCut: $('ed-add-cutout'), status: $('ed-status'), file: $('ed-file'), kind: $('ed-kind'),
    reveal: $('ed-reveal'), revealVal: $('ed-reveal-val'), revealNow: $('ed-reveal-now'), revealRow: $('ed-reveal-row'),
    zoom: $('ed-zoom'), color: $('ed-color'), colorReset: $('ed-color-reset'),
    keyRow: $('ed-key-row'), key: $('ed-key'),
  };
  // Saving on the deployed site needs the admin key (set in Vercel); locally the server needs none.
  let adminKey = '';
  try { adminKey = localStorage.getItem('adminKey') || ''; } catch (e) { /* storage blocked */ }
  ed.key.value = adminKey;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  ed.keyRow.hidden = isLocal;   // the live site needs the key; the local server does not
  ed.key.oninput = () => {
    adminKey = ed.key.value.trim();
    try { localStorage.setItem('adminKey', adminKey); } catch (e) { /* ignore */ }
    if (adminKey) save();
  };
  const adminHeaders = extra => Object.assign(adminKey ? { 'x-admin-key': adminKey } : {}, extra);
  function needKey(msg) {
    ed.keyRow.hidden = false;
    ed.status.textContent = msg;
    ed.key.focus();
  }
  let zoomText = '';
  function updateZoomReadout() {
    const fit = Math.min(vw / ROOT.world.w, vh / ROOT.world.h);
    const n = selected || activeNode;
    let t = `Zoom ${(cam.s / fit).toFixed(cam.s / fit < 10 ? 1 : 0)}× the map`;
    if (n && n.parent) t += ` · "${n.title || n.id}" fills ${Math.round(sizeRatio(rectOf(n)) * 100)}% of the screen`;
    if (t !== zoomText) { zoomText = t; ed.zoom.textContent = t; }
  }
  let fileAction = null, delArmed = false, saveTimer, composeTimers = {};

  function setEditing(on) {
    editing = on;
    editorEl.hidden = !on;
    canvas.classList.toggle('editing', on);
    document.body.classList.toggle('editing', on);
    $('btn-edit').classList.toggle('on', on);
    hoverNode = null;
    if (on) select(activeNode);
    dirty = true;
  }
  function select(node) {
    selected = node;
    delArmed = false;
    fillEditor();
    dirty = true;
  }
  function fillEditor() {
    const n = selected || activeNode;
    const path = [];
    for (let p = n; p; p = p.parent) path.unshift(p.title || p.id);
    ed.path.textContent = path.join(' › ');
    ed.title.value = n.title || '';
    ed.subtitle.value = n.subtitle || '';
    ed.body.value = n.body || '';
    ed.color.value = n.textColor;
    ed.del.disabled = n === ROOT;
    ed.del.textContent = 'Delete';
    const src = sourceRegion(n);
    const res = src ? `${Math.round(src.sw)} × ${Math.round(src.sh)} px` : 'no source';
    ed.kind.textContent = (n.cutout ? `Cutout of the picture above · ${res}` : n.image ? `Photo ${n.image} · ${res}` : 'No photo')
      + (src && src.sw < 1200 ? ' · low detail: replace with a custom picture' : '');
    ed.download.disabled = !src;
    ed.revealRow.hidden = n === ROOT;
    const rv = n.reveal != null ? n.reveal : FADE_START;
    ed.reveal.value = Math.round(rv * 100);
    ed.revealVal.textContent = Math.round(rv * 100) + '%';
    ed.parent.textContent = activeNode.title || activeNode.id;
    ed.list.innerHTML = '';
    for (const ch of activeNode.children) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = ch.title || ch.id;
      b.className = ch === selected ? 'sel' : '';
      b.onclick = () => select(ch);
      li.appendChild(b);
      ed.list.appendChild(li);
    }
    if (!activeNode.children.length) ed.list.innerHTML = '<li class="ed-hint">nothing yet</li>';
  }

  function recompose(node, delay = 400) {
    clearTimeout(composeTimers[node.id]);
    composeTimers[node.id] = setTimeout(() => compose(node), delay);
  }
  function onText(field, el) {
    el.oninput = () => {
      const n = selected;
      n[field] = el.value;
      if (field === 'title') { renderCrumbs(); fillEditor(); el.focus(); }
      if (n === activeNode) renderPanel();
      wrapCache.clear();
      recompose(n);
      save();
    };
  }
  ed.color.oninput = () => { if (!selected) return; selected.textColor = ed.color.value.toLowerCase(); dirty = true; save(); };
  ed.colorReset.onclick = () => { if (!selected) return; selected.textColor = TEXT_COLOR; ed.color.value = TEXT_COLOR; dirty = true; save(); };
  onText('title', ed.title);
  onText('subtitle', ed.subtitle);
  onText('body', ed.body);

  function serialize(n) {
    const o = { id: n.id, title: n.title || '' };
    if (n.subtitle) o.subtitle = n.subtitle;
    if (n.cutout) o.cutout = true; else if (n.image) o.image = n.image;
    if (n.parent) o.rect = { x: +n.rect.x.toFixed(4), y: +n.rect.y.toFixed(4), w: +n.rect.w.toFixed(4), h: +n.rect.h.toFixed(4) };
    if (n.focus.x !== 0.5 || n.focus.y !== 0.5) o.focus = { x: +n.focus.x.toFixed(3), y: +n.focus.y.toFixed(3) };
    if (n.parent && !isRectShape(n.shape)) o.shape = n.shape.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]);
    if (n.reveal != null) o.reveal = +n.reveal.toFixed(3);
    if (n.body) o.body = n.body;
    if (n.textColor !== TEXT_COLOR) o.textColor = n.textColor;
    if (n.children.length) o.children = n.children.map(serialize);
    return o;
  }
  function save() {
    clearTimeout(saveTimer);
    ed.status.textContent = 'saving…';
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/save', { method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(serialize(ROOT)) });
        if (r.status === 401) return needKey('not saved — enter the admin key below');
        if (!r.ok) throw new Error(r.status);
        ed.status.textContent = 'saved';
      } catch (e) {
        ed.status.textContent = isLocal ? 'not saved — is the server running? (npm run serve)' : `not saved — server error ${e.message}, try reloading the page`;
      }
    }, 600);
  }
  async function upload(file) {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/octet-stream' }), body: file,
    });
    if (r.status === 401) { needKey('upload needs the admin key — enter it below and try again'); throw new Error('401'); }
    if (r.status === 413) throw new Error('too large');
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).path;
  }
  function newId(base) {
    let id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'painting';
    while (nodes.some(n => n.id === id)) id += '-' + Math.random().toString(36).slice(2, 5);
    return id;
  }
  async function addCutout() {
    const node = { id: newId('cutout'), title: 'New cutout', cutout: true, rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 * activeNode.aspect / 1.5 }, children: [] };
    activeNode.children.push(node);
    prepare(node, activeNode);
    flatten();
    layoutAll();
    await compose(node);
    await compose(activeNode);
    updateNav();
    select(node);
    save();
    toast('Cutout added — drag it over the detail you want');
  }
  async function addChild(path, filename) {
    const base = filename.replace(/\.[^.]+$/, '');
    const title = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const node = { id: newId(base), title, image: path, rect: { x: 0.4, y: 0.4, w: 0.2 }, children: [] };   // height follows the photo
    activeNode.children.push(node);
    prepare(node, activeNode);
    await loadSource(node);
    flatten();
    layoutAll();
    await compose(node);
    await compose(activeNode);
    updateNav();
    select(node);
    toast('Added — drag it into place');
  }
  async function replaceImage(node, path) {
    node.image = path;
    node.cutout = false;
    node.hasAlpha = /\.(png|webp|gif)(\?|$)/i.test(path);
    await loadSource(node);
    layoutAll();
    await Promise.all(nodes.filter(n => isInside(n, node)).map(compose));
    if (node.parent) await compose(node.parent);
    fillEditor();
  }
  // Export the selected area at full source resolution, to repaint it with more detail.
  function downloadCrop() {
    const n = selected || activeNode, src = sourceRegion(n);
    if (!src) return;
    const c = document.createElement('canvas');
    c.width = Math.round(src.sw); c.height = Math.round(src.sh);
    c.getContext('2d').drawImage(src.img, src.sx, src.sy, src.sw, src.sh, 0, 0, c.width, c.height);
    c.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${n.id}-${c.width}x${c.height}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  }
  ed.reveal.oninput = () => {
    const n = selected;
    if (!n || n === ROOT) return;
    n.reveal = ed.reveal.value / 100;
    ed.revealVal.textContent = ed.reveal.value + '%';
    save();
  };
  ed.revealNow.onclick = () => {
    const n = selected;
    if (!n || n === ROOT) return;
    n.reveal = Math.min(1, Math.max(0.03, sizeRatio(rectOf(n))));
    fillEditor();
    save();
    toast(`"${n.title}" now appears from ${Math.round(n.reveal * 100)}% of the screen`);
  };
  ed.addCut.onclick = addCutout;
  ed.download.onclick = downloadCrop;
  ed.add.onclick = () => { fileAction = 'add'; ed.file.click(); };
  ed.image.onclick = () => { fileAction = 'replace'; ed.file.click(); };
  ed.file.onchange = async () => {
    const file = ed.file.files[0];
    ed.file.value = '';
    if (!file) return;
    try {
      ed.status.textContent = 'uploading…';
      const path = await upload(file);
      if (fileAction === 'add') await addChild(path, file.name);
      else await replaceImage(selected || activeNode, path);
      save();
    } catch (e) {
      if (e.message === '401') return;
      ed.status.textContent = e.message === 'too large' ? 'upload failed — photos must be under 4.5 MB on the live site' : 'upload failed — is the server running? (npm run serve)';
    }
  };
  ed.del.onclick = async () => {
    const n = selected;
    if (!n || n === ROOT) return;
    if (!delArmed) { delArmed = true; ed.del.textContent = 'Really delete?'; return; }
    const p = n.parent;
    p.children.splice(p.children.indexOf(n), 1);
    flatten();
    layoutAll();
    if (isInside(activeNode, n)) { flyTo(p); activeNode = null; setActive(p); }
    await compose(p);
    updateNav();
    select(activeNode);
    save();
    toast(`Deleted "${n.title || n.id}"`);
  };
})();
