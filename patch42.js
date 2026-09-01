const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');
const a = s.indexOf('async function nccSearch(');
const b = s.indexOf('async function passthrough(');
if (a < 0 || b < 0 || b < a) { console.error('PATCH FAILED: apply patch41 first'); process.exit(1); }
if (s.includes('findHangingTag')) { console.log('already applied'); process.exit(0); }
s = s.slice(0, a) + String.raw`async function nccSearch(img, S, H, labelBuf, ar, fracs, region) {
  let best = { score: -2 };
  for (const f of fracs) {
    const tw = Math.round(S * f); const th = Math.round(tw / ar);
    if (tw < 6 || th < 6 || tw >= S || th >= H) continue; // too small to be meaningful at this resolution
    const { data: t } = await sharp(labelBuf).removeAlpha().resize(tw, th, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
    let tm = 0; for (let i = 0; i < t.length; i++) tm += t[i]; tm /= t.length;
    const tz = new Float32Array(t.length); let tn = 0;
    for (let i = 0; i < t.length; i++) { tz[i] = t[i] - tm; tn += tz[i] * tz[i]; }
    tn = Math.sqrt(tn) || 1;
    const x0 = region ? Math.max(0, region.x0) : 0, x1 = region ? Math.min(S - tw, region.x1) : S - tw;
    const y0 = region ? Math.max(0, region.y0) : 0, y1 = region ? Math.min(H - th, region.y1) : H - th;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (region && region.allow && !region.allow(x, y, tw, th)) continue;
        let wm = 0;
        for (let j = 0; j < th; j++) { const row = (y + j) * S + x; for (let i = 0; i < tw; i++) wm += img[row + i]; }
        wm /= (tw * th);
        if (Math.abs(wm - tm) > 70) continue; // brightness must roughly match the label (a dark label never matches white background)
        let num = 0, den = 0;
        for (let j = 0; j < th; j++) { const row = (y + j) * S + x; const trow = j * tw; for (let i = 0; i < tw; i++) { const v = img[row + i] - wm; num += v * tz[trow + i]; den += v * v; } }
        const score = num / ((Math.sqrt(den) || 1) * tn);
        if (score > best.score) best = { score, x, y, tw, th, f };
      }
    }
  }
  return best;
}

async function findLabel(outBuf, labelBuf, opts = {}) {
  const meta = await sharp(outBuf).metadata();
  const lm = await sharp(labelBuf).metadata();
  const ar = lm.width / lm.height;
  const fracsAll = opts.fracs || [0.012, 0.016, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.075, 0.09, 0.11, 0.13, 0.16];
  // stage 1: coarse full search
  const S1 = 520; const H1 = Math.round(meta.height * S1 / meta.width);
  const { data: img1 } = await sharp(outBuf).removeAlpha().resize(S1, H1, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  let reg1 = opts.region && opts.region.yFrom ? { x0: 0, x1: S1, y0: Math.round(H1 * opts.region.yFrom), y1: H1 } : null;
  if (opts.edgeOnly) {
    // garment silhouette per row (dark pixels); a hanging tag sits ON that edge, half over the background
    const leftE = new Int16Array(H1).fill(-1), rightE = new Int16Array(H1).fill(-1);
    for (let y = 0; y < H1; y++) { for (let x = 0; x < S1; x++) if (img1[y * S1 + x] < 110) { leftE[y] = x; break; } for (let x = S1 - 1; x >= 0; x--) if (img1[y * S1 + x] < 110) { rightE[y] = x; break; } }
    const yFrom = Math.round(H1 * ((opts.region && opts.region.yFrom) || 0.3));
    reg1 = { x0: 0, x1: S1, y0: yFrom, y1: H1, allow: (x, y, tw, th) => {
      const cy = Math.min(H1 - 1, y + Math.round(th / 2)); const cx = x + tw / 2;
      const r = rightE[cy], l = leftE[cy]; const tol = Math.max(3, tw * 1.2);
      return (r >= 0 && Math.abs(cx - r) <= tol) || (l >= 0 && Math.abs(cx - l) <= tol);
    } };
  }
  const b1 = await nccSearch(img1, S1, H1, labelBuf, ar, fracsAll, reg1);
  if (b1.score < 0.3) return null;
  // stage 2: refine around the coarse hit at higher resolution
  const S2 = 1040; const H2 = Math.round(meta.height * S2 / meta.width);
  const { data: img2 } = await sharp(outBuf).removeAlpha().resize(S2, H2, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const k = S2 / S1; const pad = Math.round(6 * k);
  const region = { x0: Math.round(b1.x * k) - pad, x1: Math.round(b1.x * k) + pad, y0: Math.round(b1.y * k) - pad, y1: Math.round(b1.y * k) + pad };
  const fr = [b1.f * 0.8, b1.f * 0.9, b1.f, b1.f * 1.1, b1.f * 1.2];
  const b2 = await nccSearch(img2, S2, H2, labelBuf, ar, fr, region);
  const best = b2.score >= b1.score - 0.05 ? { ...b2, S: S2 } : { ...b1, S: S1 };
  if (best.score < (opts.minScore || 0.45)) return null;
  const inv = meta.width / best.S;
  return { x: Math.round(best.x * inv), y: Math.round(best.y * inv), w: Math.round(best.tw * inv), h: Math.round(best.th * inv), score: best.score };
}

// ---- Hanging-tag detector: a flat rectangular bump on the garment silhouette (hem/side flag tags) ----
async function findHangingTag(outBuf, labelAspect) {
  const S = 520; const meta = await sharp(outBuf).metadata(); const H = Math.round(meta.height * S / meta.width);
  const { data: img } = await sharp(outBuf).removeAlpha().resize(S, H, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const edges = { right: new Int16Array(H).fill(-1), left: new Int16Array(H).fill(-1) };
  for (let y = 0; y < H; y++) { for (let x = S - 1; x >= 0; x--) if (img[y * S + x] < 110) { edges.right[y] = x; break; } for (let x = 0; x < S; x++) if (img[y * S + x] < 110) { edges.left[y] = x; break; } }
  const med = (arr, y, w) => { const v = []; for (let k = Math.max(0, y - w); k <= Math.min(H - 1, y + w); k++) if (arr[k] >= 0) v.push(arr[k]); if (!v.length) return -1; v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  let best = null;
  for (const side of ['right', 'left']) {
    const E = edges[side]; const sign = side === 'right' ? 1 : -1;
    const delta = new Float32Array(H);
    for (let y = 0; y < H; y++) { const m = med(E, y, 30); delta[y] = (E[y] >= 0 && m >= 0) ? sign * (E[y] - m) : 0; }
    let y = Math.round(H * 0.4);
    while (y < H) {
      if (delta[y] >= 3) {
        let y2 = y; while (y2 + 1 < H && delta[y2 + 1] >= 3) y2++;
        const len = y2 - y + 1;
        if (len >= 10 && len <= 80) {
          const ds = []; for (let k = y; k <= y2; k++) ds.push(delta[k]);
          const mean = ds.reduce((a, b) => a + b, 0) / ds.length; const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ds.length);
          const flat = sd / Math.max(1, mean); // rectangular bump => small relative spread
          if (mean >= 3 && mean <= 30 && flat <= 0.35) {
            const score = 1 - flat; if (!best || score > best.score) {
              // tilt from the outer edge line
              const n = len; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = y; k <= y2; k++) { const ex = E[k]; sx += ex; sy += k; sxy += ex * k; sxx += ex * ex; }
              const yy = []; for (let k = y; k <= y2; k++) yy.push(E[k]);
              const slope = (n * sxy - sx * sy) / Math.max(1e-6, (n * (yy.reduce((a, b) => a + b * b, 0)) - sx * sx)); // dy/dx
              const dxdy = slope ? 1 / slope : 0; const ang = Math.atan(dxdy) * 180 / Math.PI * (side === 'right' ? 1 : 1);
              const base = med(E, Math.round((y + y2) / 2), 30);
              const outer = side === 'right' ? Math.max(...yy) : Math.min(...yy);
              best = { side, y0: y, y1: y2, base, outer, ang: Math.max(-20, Math.min(20, ang)), score };
            }
          }
        }
        y = y2 + 1;
      } else y++;
    }
  }
  if (!best) return null;
  const inv = meta.width / S;
  const h0 = Math.round((best.y1 - best.y0 + 1) * inv);
  const h = Math.round(h0 * 1.08); // cover the rounded tag end
  const w = Math.max(8, Math.round(h * Math.max(0.5, labelAspect || 0.55)));
  const outerX = Math.round(best.outer * inv);
  const x = best.side === 'right' ? outerX - w + Math.round(w * 0.12) : outerX - Math.round(w * 0.12);
  return { x, y: Math.round(best.y0 * inv) - Math.round((h - h0) / 2), w, h, score: best.score, ang: best.ang };
}

async function overlayLabels(outBuf, labelImgs, minScore) {
  let cur = outBuf; const hits = [];
  const meta0 = await sharp(outBuf).metadata();
  for (let li = 0; li < labelImgs.length; li++) {
    const lb = Buffer.from(labelImgs[li].base64, 'base64');
    const lm = await sharp(lb).metadata();
    const tall = lm.height > lm.width; // hem/flag tags are tall and often tilted
    const angles = tall ? [0, -5, 5, -10, 10, -15, 15] : [0, -4, 4];
    let best = null;
    if (tall) { try { const t = await findHangingTag(cur, lm.width / lm.height); if (t) best = t; } catch (e) { best = null; } }
    for (const ang of (best ? [] : angles)) {
      const tpl = ang === 0 ? lb : await sharp(lb).rotate(ang, { background: { r: 20, g: 20, b: 20, alpha: 1 } }).png().toBuffer();
      let m = null;
      try { m = await findLabel(cur, tpl, { minScore: minScore || 0.45, region: tall ? { yFrom: 0.3 } : null, edgeOnly: tall }); } catch (e) { m = null; }
      if (m && (!best || m.score > best.score)) best = { ...m, ang };
      if (best && best.score >= 0.82) break;
    }
    if (!best) { hits.push(null); continue; }
    const m = best;
    // feathered alpha on the artwork, then rotate it to the matched angle and fit it to the matched box
    const feather = Math.max(2, Math.round(Math.min(lm.width, lm.height) * 0.08));
    const inner = await sharp({ create: { width: Math.max(1, lm.width - 2 * feather), height: Math.max(1, lm.height - 2 * feather), channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const mask = await sharp({ create: { width: lm.width, height: lm.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: inner, left: feather, top: feather }]).blur(feather / 1.5).ensureAlpha().extractChannel(3).toBuffer({ resolveWithObject: true });
    let art = await sharp(lb).removeAlpha().joinChannel(mask.data, { raw: { width: lm.width, height: lm.height, channels: 1 } }).png().toBuffer();
    if (m.ang) art = await sharp(art).rotate(m.ang, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const patch = await sharp(art).resize(m.w, m.h, { fit: 'fill' }).png().toBuffer();
    const left = Math.max(0, Math.min(meta0.width - m.w, m.x)), top = Math.max(0, Math.min(meta0.height - m.h, m.y));
    cur = await sharp(cur).composite([{ input: patch, left, top }]).png().toBuffer();
    hits.push(m);
  }
  return { buf: cur, hits };
}

// ---- Build label artworks (white lettering on a black label) from the logo image, no model involved ----
async function logoToWhiteLettering(logoImg) {
  const src = Buffer.from(logoImg.base64, 'base64');
  let g = await sharp(src).flatten({ background: '#ffffff' }).grayscale().toBuffer();
  let meta = await sharp(g).metadata();
  // remove stray marks that are not lettering: connected components that are very wide and very thin (e.g. a leftover line/arc)
  const rawG = await sharp(g).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  const W = rawG.info.width, H = rawG.info.height, CH = rawG.info.channels;
  const data = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) data[i] = rawG.data[i * CH];
  const ink = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) ink[i] = data[i] < 215 ? 1 : 0;
  const seen = new Uint8Array(W * H); const stack = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!ink[p0] || seen[p0]) continue;
    const comp = []; stack.push(p0); seen[p0] = 1;
    let minx = W, maxx = 0, miny = H, maxy = 0;
    while (stack.length) { const p = stack.pop(); comp.push(p); const x = p % W, y = (p - x) / W;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= W * H) continue; const qx = q % W; if (Math.abs(qx - x) > 1) continue; if (ink[q] && !seen[q]) { seen[q] = 1; stack.push(q); } } }
    const cw = maxx - minx + 1, ch = maxy - miny + 1;
    // a thin wide streak (line/arc), or anything touching the very top/bottom edge that is thin: not lettering
    if ((ch <= H * 0.12 && cw / ch >= 6) || ((miny === 0 || maxy === H - 1) && ch <= H * 0.08)) { for (const p of comp) data[p] = 255; }
  }
  g = await sharp(data, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  g = await sharp(g).trim({ threshold: 40 }).resize({ width: 1200, withoutEnlargement: false }).toBuffer();
  meta = await sharp(g).metadata();
  const alphaRaw = await sharp(g).negate().linear(1.6, -40).extractChannel(0).raw().toBuffer();
  return sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: '#ffffff' } })
    .joinChannel(alphaRaw, { raw: { width: meta.width, height: meta.height, channels: 1 } }).png().toBuffer();
}
async function buildLabelArtworks(logoImg) {
  if (!sharp || !logoImg) return [];
  const white = await logoToWhiteLettering(logoImg);
  const out = [];
  // neck label: wide black rectangle, lettering ~68% of width, centred
  { const W = 1400, H = Math.round(W / 4.4);
    const t = await sharp(white).resize({ width: Math.round(W * 0.68) }).png().toBuffer(); const tm = await sharp(t).metadata();
    const b = await sharp({ create: { width: W, height: H, channels: 4, background: '#0b0b0b' } }).composite([{ input: t, left: Math.round((W - tm.width) / 2), top: Math.round((H - tm.height) / 2) }]).png().toBuffer();
    out.push({ base64: b.toString('base64'), mime: 'image/png', name: 'auto-neck-label.png' }); }
  // hem flag tag: tall black tag, lettering rotated to run along the tag
  { const FW = 560, FH = Math.round(FW / 0.55); // same proportion as a typical woven flag tag
    const t = await sharp(white).resize({ width: Math.round(FH * 0.72) }).rotate(90).png().toBuffer(); const tm = await sharp(t).metadata();
    const b = await sharp({ create: { width: FW, height: FH, channels: 4, background: '#0b0b0b' } }).composite([{ input: t, left: Math.round((FW - tm.width) / 2), top: Math.round((FH - tm.height) / 2) }]).png().toBuffer();
    out.push({ base64: b.toString('base64'), mime: 'image/png', name: 'auto-hem-label.png' }); }
  return out;
}

` + s.slice(b);
// auto-built labels: neck via template match (>=0.68), hem via hanging-tag detector
s = s.replace("const r = await overlayLabels(outBuf, labelSet, entry.labels && entry.labels.length ? 0.45 : 0.68);", "const r = await overlayLabels(outBuf, labelSet, entry.labels && entry.labels.length ? 0.45 : 0.6);");
fs.writeFileSync('server.js', s);
console.log('patched OK');
