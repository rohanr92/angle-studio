require('dotenv').config();

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const archiver = require('archiver');
const crypto = require('crypto');
const path = require('path');
let sharp = null;
try { sharp = require('sharp'); console.log('  sharp OK — angle guides will be converted to silhouettes'); } catch (e) { console.error('  !!! sharp NOT loaded — run: npm install sharp   (angle photos would be sent as-is)'); }

const app = express();
const PORT = process.env.PORT || 5050;
const FREEPIK_API_KEY = process.env.MAGNIFIC_API_KEY || process.env.FREEPIK_API_KEY;
// Magnific is the new name of the Freepik API. Both hosts still work; the docs
// (docs.magnific.com) now list api.magnific.com as the production server.
const FREEPIK_BASE = (process.env.API_BASE || 'https://api.magnific.com') + '/v1/ai/text-to-image';
// Where to host uploaded reference photos so Magnific can fetch them.
// 'tmpfiles' = free temp host, files auto-delete after ~60 min (default)
// 'base64'   = send inline data URIs (not documented as supported; try if tmpfiles is blocked)
const IMAGE_HOST = (process.env.IMAGE_HOST || 'auto').toLowerCase();

const ALLOWED_MODELS = new Set(['nano-banana-pro', 'nano-banana-pro-flash']);

// Simple password gate for deployment (set APP_PASSWORD in env; leave empty for local use)
app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return next();
  const hdr = req.headers.authorization || '';
  const ok = hdr.startsWith('Basic ') && Buffer.from(hdr.slice(6), 'base64').toString().split(':').slice(1).join(':') === pw;
  if (ok) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Angle Studio"');
  res.status(401).send('Login required');
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 40 },
});

// In-memory store, keyed by a session id: { product: [...], angles: [...] }
const referenceStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, entry] of referenceStore) {
    if (entry.createdAt < cutoff) referenceStore.delete(id);
  }
}, 10 * 60 * 1000);

function freepikHeaders() {
  return {
    'x-magnific-api-key': FREEPIK_API_KEY,
    'x-freepik-api-key': FREEPIK_API_KEY,
    'Content-Type': 'application/json',
  };
}

function friendlyError(err) {
  if (err.response) {
    const status = err.response.status;
    const body = err.response.data;
    const msg = (body && (body.message || body.error || JSON.stringify(body))) || 'Unknown error';
    if (status === 401) return 'Magnific rejected the API key (401). Check MAGNIFIC_API_KEY in your .env file.';
    if (status === 402) return 'Magnific says this API key has no credits (402). Check the balance at magnific.com/developers/dashboard.';
    if (status === 429) return 'Rate limited by Magnific (429) even after retries. Lower MAX_CONCURRENT in .env or wait a minute.';
    return `Magnific API error (${status}): ${msg}`;
  }
  return err.message || 'Unknown error';
}

const SUPPORTED_ASPECTS = [[1,1],[2,3],[3,2],[3,4],[4,3],[4,5],[5,4],[9,16],[16,9],[21,9]];
function nearestAspect(w, h) {
  if (!w || !h) return '4:5';
  const r = w / h; let best = '4:5', d = 1e9;
  for (const [a, b] of SUPPORTED_ASPECTS) { const dd = Math.abs(r - a / b); if (dd < d) { d = dd; best = a + ':' + b; } }
  return best;
}

// ---- Rate limiting (docs.magnific.com/ratelimits: 50 req/min per key + per-second burst) ----
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3); // tasks generating at once
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 700);        // min gap between ANY Magnific call
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCallAt = 0;
let paceChain = Promise.resolve();
function paced(fn) {
  const run = async () => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  };
  const p = paceChain.then(run, run);
  paceChain = p.catch(() => {});
  return p;
}

async function withRetry(fn, { tries = 6, base = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await paced(fn);
    } catch (err) {
      lastErr = err;
      const st = err.response && err.response.status;
      if (st === 429 || st === 503 || st === 502) {
        const retryAfter = Number(err.response.headers && err.response.headers['retry-after']);
        const delay = retryAfter ? retryAfter * 1000 : base * Math.pow(1.7, i) + Math.random() * 500;
        console.warn(`  Magnific ${st} — retrying in ${Math.round(delay / 1000)}s (attempt ${i + 1}/${tries})`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

let activeTasks = 0;
const slotQueue = [];
async function acquireSlot() {
  if (activeTasks < MAX_CONCURRENT) { activeTasks++; return; }
  await new Promise((resolve) => slotQueue.push(resolve));
  activeTasks++;
}
function releaseSlot() {
  activeTasks--;
  const next = slotQueue.shift();
  if (next) next();
}

async function createTask(model, payload) {
  const url = `${FREEPIK_BASE}/${model}`;
  const res = await withRetry(() => axios.post(url, payload, { headers: freepikHeaders() }));
  return res.data && res.data.data ? res.data.data : res.data;
}

async function getTask(model, taskId) {
  const url = `${FREEPIK_BASE}/${model}/${taskId}`;
  const res = await withRetry(() => axios.get(url, { headers: freepikHeaders() }));
  return res.data && res.data.data ? res.data.data : res.data;
}

async function pollTask(model, taskId, { intervalMs = 4000, maxTries = 60 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    const task = await getTask(model, taskId);
    const status = (task.status || '').toUpperCase();
    if (status === 'COMPLETED') return task;
    if (status === 'FAILED' || status === 'ERROR') {
      const err = new Error("Generation failed on Freepik's side.");
      err.taskDetail = task;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for Freepik to finish this image.');
}

function fileToImg(f) {
  return { base64: f.buffer.toString('base64'), mime: f.mimetype, name: f.originalname || 'image.jpg' };
}
async function fileToImgResized(f, maxPx) {
  if (!sharp) return fileToImg(f);
  try {
    const buf = await sharp(f.buffer).rotate().resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    return { base64: buf.toString('base64'), mime: 'image/jpeg', name: f.originalname || 'image.jpg' };
  } catch (e) { return fileToImg(f); }
}

// Magnific's reference_images field needs an image it can fetch. Different
// hosts work differently well with their fetcher, so we try a chain:
//   base64  -> inline data URI (no hosting at all)
//   0x0     -> 0x0.st, direct link, auto-expires
//   catbox  -> catbox.moe, direct link (permanent — used last)
//   tmpfiles-> tmpfiles.org (kept for completeness)
// Set IMAGE_HOST in .env to force a single one, or leave it to use the chain.
const HOST_CHAIN = IMAGE_HOST === 'auto' || !IMAGE_HOST
  ? ['base64', '0x0', 'catbox', 'tmpfiles']
  : [IMAGE_HOST];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AngleStudio/1.0';

async function hostImage(img, host) {
  img.hosted = img.hosted || {};
  if (img.hosted[host]) return img.hosted[host];
  const ext = img.mime === 'image/png' ? 'png' : img.mime === 'image/webp' ? 'webp' : 'jpg';
  const buf = Buffer.from(img.base64, 'base64');
  let url;
  if (host === 'base64') {
    url = `data:${img.mime};base64,${img.base64}`;
  } else {
    const FormData = require('form-data');
    const fd = new FormData();
    if (host === '0x0') {
      fd.append('file', buf, { filename: `ref.${ext}`, contentType: img.mime });
      fd.append('expires', '2'); // hours
      const r = await axios.post('https://0x0.st', fd, { headers: { ...fd.getHeaders(), 'User-Agent': UA }, maxBodyLength: Infinity });
      url = String(r.data).trim();
    } else if (host === 'catbox') {
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', buf, { filename: `ref.${ext}`, contentType: img.mime });
      const r = await axios.post('https://catbox.moe/user/api.php', fd, { headers: { ...fd.getHeaders(), 'User-Agent': UA }, maxBodyLength: Infinity });
      url = String(r.data).trim();
    } else if (host === 'tmpfiles') {
      fd.append('file', buf, { filename: `ref.${ext}`, contentType: img.mime });
      const r = await axios.post('https://tmpfiles.org/api/v1/upload', fd, { headers: { ...fd.getHeaders(), 'User-Agent': UA }, maxBodyLength: Infinity });
      url = r.data && r.data.data && r.data.data.url;
      if (url) url = url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
    } else {
      throw new Error(`Unknown IMAGE_HOST "${host}"`);
    }
    if (!url || !/^https?:\/\//.test(url)) throw new Error(`${host} did not return a URL (${url})`);
  }
  img.hosted[host] = url;
  return url;
}

// Convert an angle reference photo into a neutral grayscale "pose guide" so
// the model copies the camera angle/pose but NOT the product, colour or print.
async function angleGuide(img, mode) {
  if (mode === 'photo' || !sharp) return img;
  img.guides = img.guides || {};
  if (img.guides[mode]) return img.guides[mode];
  const buf = Buffer.from(img.base64, 'base64');
  let pipeline = sharp(buf).resize(1024, 1024, { fit: 'inside' }).flatten({ background: '#ffffff' }).grayscale();
  if (mode === 'silhouette') {
    pipeline = pipeline.blur(1).threshold(225).linear(0.45, 140).blur(0.6);
  } else {
    pipeline = pipeline.blur(1.5).linear(0.7, 60);
  }
  const out = await pipeline.png().toBuffer();
  const g = { base64: out.toString('base64'), mime: 'image/png', name: 'guide.png' };
  img.guides[mode] = g;
  return g;
}

// ---- Post-process: force near-white background to pure #FFFFFF, keep the soft shadow ----
const WHITE_T = Number(process.env.BG_WHITE_THRESHOLD || 236);
const SHADOW_LIFT = Math.min(0.9, Math.max(0, Number(process.env.SHADOW_LIFT || 0.5))); // 0 = keep shadow as generated, 0.9 = almost remove
const generatedStore = new Map();
setInterval(() => { for (const [id, g] of generatedStore) if (g.createdAt < Date.now() - 6 * 3600e3) generatedStore.delete(id); }, 600e3);

const NORDSTROM_BG = (process.env.NORDSTROM_BG || '#F8F8F8').replace('#', '');
const BG_BY_VARIANT = { 1: [255, 255, 255], 2: [parseInt(NORDSTROM_BG.slice(0, 2), 16), parseInt(NORDSTROM_BG.slice(2, 4), 16), parseInt(NORDSTROM_BG.slice(4, 6), 16)] };

async function cleanBackground(remoteUrl, variant = 1, liftOverride) {
  const r = await axios.get(remoteUrl, { responseType: 'arraybuffer' });
  return cleanBuffer(Buffer.from(r.data), variant, r.headers['content-type'] || 'image/jpeg', liftOverride);
}

async function cleanBuffer(src, variant = 1, srcMime = 'image/png', liftOverride) {
  const LIFT = (liftOverride === undefined || liftOverride === null) ? SHADOW_LIFT : Number(liftOverride);
  const bg = BG_BY_VARIANT[Number(variant)] || BG_BY_VARIANT[1];
  if (!sharp) return { buf: src, mime: srcMime, width: 0, height: 0 };
  const meta = await sharp(src).metadata();
  const W = meta.width, H = meta.height;

  // 1) Work on a small copy to find the background as a CONNECTED region from the borders
  const mw = 1024, mh = Math.max(1, Math.round(H * mw / W));
  const { data: sm } = await sharp(src).removeAlpha().resize(mw, mh, { fit: 'fill' }).blur(0.8).raw().toBuffer({ resolveWithObject: true });
  const N = mw * mh;
  let br = 0, bgc = 0, bb = 0, cnt = 0;
  for (let x = 0; x < mw; x += 8) { for (const p of [x, x + (mh - 1) * mw]) { br += sm[p*3]; bgc += sm[p*3+1]; bb += sm[p*3+2]; cnt++; } }
  for (let y = 0; y < mh; y += 8) { for (const p of [y * mw, y * mw + mw - 1]) { br += sm[p*3]; bgc += sm[p*3+1]; bb += sm[p*3+2]; cnt++; } }
  br /= cnt; bgc /= cnt; bb /= cnt;
  const bgL = (br + bgc + bb) / 3;
  function floodMask(tol, minL) {
    const mask = new Uint8Array(N); const stack = [];
    const push = (p) => {
      if (mask[p]) return;
      const r = sm[p*3], g = sm[p*3+1], b = sm[p*3+2];
      const L = (r + g + b) / 3, d = Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb);
      if (d <= tol && L >= minL && Math.max(r, g, b) - Math.min(r, g, b) <= 40) { mask[p] = 1; stack.push(p); }
    };
    for (let x = 0; x < mw; x++) { push(x); push(x + (mh - 1) * mw); }
    for (let y = 0; y < mh; y++) { push(y * mw); push(y * mw + mw - 1); }
    while (stack.length) { const p = stack.pop(); const x = p % mw, y = (p - x) / mw; if (x > 0) push(p - 1); if (x < mw - 1) push(p + 1); if (y > 0) push(p - mw); if (y < mh - 1) push(p + mw); }
    return mask;
  }
  const tight = floodMask(34, Math.max(150, bgL - 45));   // real background
  const loose = floodMask(105, 120);                      // background + shadow
  const tightM = new Uint8Array(N), shadowM = new Uint8Array(N);
  for (let i = 0; i < N; i++) { tightM[i] = tight[i] ? 255 : 0; shadowM[i] = loose[i] && !tight[i] ? 255 : 0; }

  // 2) Soften + upscale masks to full resolution (force single channel)
  const up = async (m, blur) => {
    const r = await sharp(Buffer.from(m), { raw: { width: mw, height: mh, channels: 1 } }).blur(blur).resize(W, H, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    const c = r.info.channels; if (c === 1) return r.data;
    const o = new Uint8Array(W * H); for (let p = 0; p < W * H; p++) o[p] = r.data[p * c]; return o;
  };
  const bgMask = await up(tightM, 1.2);
  const shMask = await up(shadowM, 2.5);

  // 3) Apply: background -> exact bg colour; shadow zone -> lifted toward bg by SHADOW_LIFT; product untouched
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0, p = 0; p < W * H; p++, i += ch) {
    const a = bgMask[p] / 255, sA = (shMask[p] / 255) * LIFT;
    const r = data[i], g = data[i+1], b = data[i+2];
    if (a > 0.003) { data[i] = Math.round(r + (bg[0] - r) * a); data[i+1] = Math.round(g + (bg[1] - g) * a); data[i+2] = Math.round(b + (bg[2] - b) * a); }
    else if (sA > 0.003) { data[i] = Math.round(r + (bg[0] - r) * sA); data[i+1] = Math.round(g + (bg[1] - g) * sA); data[i+2] = Math.round(b + (bg[2] - b) * sA); }
  }
  const base = sharp(data, { raw: { width: W, height: H, channels: ch } });
  const out = await base.clone().png({ compressionLevel: 6 }).toBuffer();
  const thumb = await base.clone().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { buf: out, thumb, mime: 'image/png', width: W, height: H };
}

// ---- STYLE guide: keep the reference photo's background + shadow + framing, blank out the product ----
async function makeStyleGuide(img) {
  img.guides = img.guides || {};
  if (img.guides.style) return img.guides.style;
  const src = Buffer.from(img.base64, 'base64');
  const meta = await sharp(src).metadata();
  const W = Math.min(meta.width, 1280), H = Math.round(meta.height * W / meta.width);
  const { data: sm } = await sharp(src).removeAlpha().resize(W, H, { fit: 'fill' }).blur(0.8).raw().toBuffer({ resolveWithObject: true });
  const N = W * H;
  let br = 0, bgc = 0, bb = 0, cnt = 0;
  for (let x = 0; x < W; x += 8) { for (const p of [x, x + (H - 1) * W]) { br += sm[p*3]; bgc += sm[p*3+1]; bb += sm[p*3+2]; cnt++; } }
  for (let y = 0; y < H; y += 8) { for (const p of [y * W, y * W + W - 1]) { br += sm[p*3]; bgc += sm[p*3+1]; bb += sm[p*3+2]; cnt++; } }
  br /= cnt; bgc /= cnt; bb /= cnt;
  // loose flood = background + shadow; everything NOT reached = the product
  const reached = new Uint8Array(N); const stack = [];
  const push = (p) => { if (reached[p]) return; const r = sm[p*3], g = sm[p*3+1], b = sm[p*3+2]; const L = (r+g+b)/3, d = Math.abs(r-br)+Math.abs(g-bgc)+Math.abs(b-bb); if (d <= 105 && L >= 120 && Math.max(r,g,b)-Math.min(r,g,b) <= 40) { reached[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x); push(x + (H-1)*W); }
  for (let y = 0; y < H; y++) { push(y*W); push(y*W + W-1); }
  while (stack.length) { const p = stack.pop(); const x = p % W, y = (p - x) / W; if (x > 0) push(p-1); if (x < W-1) push(p+1); if (y > 0) push(p-W); if (y < H-1) push(p+W); }
  // product mask, dilated slightly
  const prod = new Uint8Array(N); for (let i = 0; i < N; i++) prod[i] = reached[i] ? 0 : 255;
  const pm = await sharp(Buffer.from(prod), { raw: { width: W, height: H, channels: 1 } }).blur(2).threshold(60).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  const c = pm.info.channels;
  const { data } = await sharp(src).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  for (let p = 0, i = 0; p < N; p++, i += 3) { if (pm.data[p * c] > 127) { data[i] = 128; data[i+1] = 128; data[i+2] = 128; } }
  const out = await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const g = { base64: out.toString('base64'), mime: 'image/png', name: 'style-guide.png' };
  img.guides.style = g;
  return g;
}

async function googleFromParts({ apiKey, model, parts, aspectRatio, resolution }) {
  const imageConfig = { aspectRatio };
  if (model === 'gemini-3-pro-image-preview') imageConfig.imageSize = String(resolution).toUpperCase();
  const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig } };
  let res;
  try {
    res = await withRetry(() => axios.post(`${GOOGLE_BASE}/${model}:generateContent`, body, {
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, maxBodyLength: Infinity, timeout: 300000,
    }));
  } catch (err) {
    const e = err.response && err.response.data && err.response.data.error;
    const st = err.response && err.response.status;
    if (st === 429) throw new Error('Google quota / rate limit hit (429): ' + (e ? e.message : 'too many requests'));
    throw new Error('Google API error' + (st ? ' (' + st + ')' : '') + ': ' + (e ? e.message : err.message));
  }
  const cand = res.data && res.data.candidates && res.data.candidates[0];
  const outParts = (cand && cand.content && cand.content.parts) || [];
  const imgPart = outParts.find((p) => p.inlineData || p.inline_data);
  if (!imgPart) {
    const block = (res.data && res.data.promptFeedback && res.data.promptFeedback.blockReason) || (cand && cand.finishReason);
    const txt = outParts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
    throw new Error('Google returned no image' + (block ? ' (' + block + ')' : '') + (txt ? ': ' + txt : ''));
  }
  const d = imgPart.inlineData || imgPart.inline_data;
  return { buf: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || 'image/png' };
}

// Extend the canvas to an exact target ratio (e.g. 4:5) with the image's own background colour, never cropping the product
async function padToAspect(buf, targetAspect) {
  if (!sharp || !targetAspect) return buf;
  const [aw, ah] = String(targetAspect).split(':').map(Number);
  if (!aw || !ah) return buf;
  const img = sharp(buf);
  const meta = await img.metadata();
  const W = meta.width, H = meta.height;
  const cur = W / H, tgt = aw / ah;
  if (Math.abs(cur - tgt) < 0.005) return buf;
  // background colour = average of the four corners
  const { data } = await img.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * W + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
  const cs = [px(2, 2), px(W - 3, 2), px(2, H - 3), px(W - 3, H - 3)];
  const bg = { r: Math.round(cs.reduce((a, c) => a + c[0], 0) / 4), g: Math.round(cs.reduce((a, c) => a + c[1], 0) / 4), b: Math.round(cs.reduce((a, c) => a + c[2], 0) / 4) };
  let newW = W, newH = H;
  if (cur > tgt) newH = Math.round(W / tgt); else newW = Math.round(H * tgt);
  const left = Math.floor((newW - W) / 2), top = Math.floor((newH - H) / 2);
  return sharp(buf).extend({ top, bottom: newH - H - top, left, right: newW - W - left, background: bg }).png().toBuffer();
}

// ---- Label overlay: find where each real label crop landed in the generated image and paste the sharp crop over it ----
async function nccSearch(img, S, H, labelBuf, ar, fracs, region) {
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
  const b1 = await nccSearch(img1, S1, H1, labelBuf, ar, fracsAll, null);
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

async function overlayLabels(outBuf, labelImgs, minScore) {
  let cur = outBuf; const hits = [];
  for (const li of labelImgs) {
    const lb = Buffer.from(li.base64, 'base64');
    let m = null;
    try { m = await findLabel(cur, lb, { minScore: minScore || 0.45 }); } catch (e) { m = null; }
    if (!m) { hits.push(null); continue; }
    const feather = Math.max(2, Math.round(Math.min(m.w, m.h) * 0.08));
    const inner = await sharp({ create: { width: Math.max(1, m.w - 2 * feather), height: Math.max(1, m.h - 2 * feather), channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
    const mask = await sharp({ create: { width: m.w, height: m.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: inner, left: feather, top: feather }]).blur(feather / 1.5).ensureAlpha().extractChannel(3).toBuffer({ resolveWithObject: true });
    const patch = await sharp(lb).resize(m.w, m.h, { fit: 'fill' }).removeAlpha()
      .joinChannel(mask.data, { raw: { width: m.w, height: m.h, channels: 1 } }).png().toBuffer();
    cur = await sharp(cur).composite([{ input: patch, left: m.x, top: m.y }]).png().toBuffer();
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
  { const FW = 420, FH = Math.round(FW * 3.3);
    const t = await sharp(white).resize({ width: Math.round(FH * 0.72) }).rotate(90).png().toBuffer(); const tm = await sharp(t).metadata();
    const b = await sharp({ create: { width: FW, height: FH, channels: 4, background: '#0b0b0b' } }).composite([{ input: t, left: Math.round((FW - tm.width) / 2), top: Math.round((FH - tm.height) / 2) }]).png().toBuffer();
    out.push({ base64: b.toString('base64'), mime: 'image/png', name: 'auto-hem-label.png' }); }
  return out;
}

async function passthrough(buf, mime) {
  if (!sharp) return { buf, mime, width: 0, height: 0 };
  const meta = await sharp(buf).metadata();
  const thumb = await sharp(buf).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { buf, thumb, mime: mime || 'image/png', width: meta.width, height: meta.height };
}

// ---- Describe an angle reference photo in words (so no guide IMAGE is ever sent) ----
async function describeAngle(img, apiKey, label) {
  if (img.desc) return img.desc;
  if (!apiKey) return null;
  const body = {
    contents: [{ role: 'user', parts: [
      { text: 'You are describing a camera setup for a product photographer. Look at this footwear product photo and describe ONLY the camera angle and composition, never the shoe itself (no colour, material, brand, print). Cover: camera elevation (eye-level / slightly above / top-down), rotation (straight front, back, left or right side profile, three-quarter from which side), how many shoes are in frame and how they are arranged (single, pair side by side, pair stacked/overlapping, one upright one lying), which part of the shoe is nearest the camera, toe direction (pointing left/right/toward/away from camera), crop and framing (full shoe with margin, close-up of heel/toe etc.), and whether the shoe stands on the ground or is shot from above lying flat. Never mention background, lighting, shadows, colours, materials or brand. Answer in one dense paragraph of at most 80 words, no preamble.' },
      { inline_data: { mime_type: img.mime, data: img.base64 } },
    ] }],
    generationConfig: { temperature: 0.2 },
  };
  try {
    const r = await withRetry(() => axios.post(`${GOOGLE_BASE}/gemini-2.5-flash:generateContent`, body, {
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, maxBodyLength: Infinity, timeout: 120000,
    }));
    const parts = (r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || [];
    const txt = parts.map((p) => p.text).filter(Boolean).join(' ').trim();
    if (txt) { img.desc = txt; console.log(`  angle "${label}": described -> ${txt.slice(0, 110)}…`); return txt; }
  } catch (e) {
    console.warn(`  angle "${label}": could not describe via Gemini (${e.response ? e.response.status : e.message}); falling back to label text`);
  }
  return null;
}

// ---- Google Gemini (official Nano Banana API) ----
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_MODELS = new Set(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']);

async function googleGenerate({ apiKey, model, prompt, productImgs, guideImg, logoImg, heelImg, productText, angleText, aspectRatio, resolution, styleFirst }) {
  const parts = [];
  let nextIdx = 1;
  if (styleFirst && guideImg) {
    parts.push({ text: `Image 1: ${angleText}` });
    parts.push({ inline_data: { mime_type: guideImg.mime, data: guideImg.base64 } });
    nextIdx = 2;
  }
  productImgs.forEach((img, i) => {
    parts.push({ text: `Image ${nextIdx + i}: ${productText}` });
    parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
  });
  nextIdx += productImgs.length;
  if (heelImg) {
    parts.push({ text: `Image ${nextIdx}: HEEL REFERENCE — shows only the exact heel and back shape of my product (its height, thickness and profile). Use it for the heel/back of the shoe; it is not a separate product and nothing else from it may be copied.` });
    parts.push({ inline_data: { mime_type: heelImg.mime, data: heelImg.base64 } });
    nextIdx++;
  }
  if (logoImg) {
    parts.push({ text: `Image ${nextIdx}: LOGO — the exact brand logo artwork of this product. Use it only to reproduce the logo correctly where it belongs on the product.` });
    parts.push({ inline_data: { mime_type: logoImg.mime, data: logoImg.base64 } });
    nextIdx++;
  }
  if (guideImg && !styleFirst) {
    parts.push({ text: `Image ${nextIdx}: ${angleText}` });
    parts.push({ inline_data: { mime_type: guideImg.mime, data: guideImg.base64 } });
  }
  parts.push({ text: prompt }); // instruction LAST, after all images (as in Google's multi-image examples)
  const imageConfig = { aspectRatio };
  if (model === 'gemini-3-pro-image-preview') imageConfig.imageSize = String(resolution).toUpperCase();
  const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig } };
  let res;
  try {
    res = await withRetry(() => axios.post(`${GOOGLE_BASE}/${model}:generateContent`, body, {
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, maxBodyLength: Infinity, timeout: 300000,
    }));
  } catch (err) {
    const e = err.response && err.response.data && err.response.data.error;
    const st = err.response && err.response.status;
    if (st === 400 && e && /API key/i.test(e.message)) throw new Error('Google rejected the API key: ' + e.message);
    if (st === 429) throw new Error('Google quota / rate limit hit (429): ' + (e ? e.message : 'too many requests'));
    throw new Error('Google API error' + (st ? ' (' + st + ')' : '') + ': ' + (e ? e.message : err.message));
  }
  const cand = res.data && res.data.candidates && res.data.candidates[0];
  const outParts = (cand && cand.content && cand.content.parts) || [];
  const imgPart = outParts.find((p) => p.inlineData || p.inline_data);
  if (!imgPart) {
    const block = (res.data && res.data.promptFeedback && res.data.promptFeedback.blockReason) || (cand && cand.finishReason);
    const txt = outParts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
    throw new Error('Google returned no image' + (block ? ' (' + block + ')' : '') + (txt ? ': ' + txt : ''));
  }
  const d = imgPart.inlineData || imgPart.inline_data;
  return { buf: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || 'image/png' };
}

function isImageResolveError(err) {
  const body = err.response && err.response.data;
  const msg = (body && (body.message || JSON.stringify(body))) || err.message || '';
  const st = err.response && err.response.status;
  if (st === 413) return true; // payload too large (base64) -> try a hosted URL
  return st === 400 && /resolve image|reference_images|image url|fetch image|invalid image|data:|base64|url/i.test(msg);
}

// ---- Routes ----------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: !!FREEPIK_API_KEY });
});

// Upload BOTH the angle reference photos and the product reference photos
// in one call. Returns a referenceId used by every /api/generate-angle call.
app.post(
  '/api/reference',
  upload.fields([
    { name: 'product', maxCount: 6 },
    { name: 'angles', maxCount: 8 },
    { name: 'logo', maxCount: 1 },
    { name: 'heel', maxCount: 1 },
    { name: 'bases', maxCount: 30 },
    { name: 'bg', maxCount: 1 },
    { name: 'labels', maxCount: 4 },
  ]),
  async (req, res) => {
    const productFiles = (req.files && req.files.product) || [];
    const angleFiles = (req.files && req.files.angles) || [];
    const logoFiles = (req.files && req.files.logo) || [];
    const heelFiles = (req.files && req.files.heel) || [];
    const baseFiles = (req.files && req.files.bases) || [];
    const bgFiles = (req.files && req.files.bg) || [];
    const labelFiles = (req.files && req.files.labels) || [];

    if (!productFiles.length && !baseFiles.length) {
      return res.status(400).json({ error: 'Upload at least one reference product photo.' });
    }
    if (!angleFiles.length && !baseFiles.length && !productFiles.length) {
      return res.status(400).json({ error: 'Upload at least one angle reference photo (or sample/lifestyle photos).' });
    }

    const referenceId = crypto.randomUUID();
    referenceStore.set(referenceId, {
      product: await Promise.all(productFiles.map(async (f) => { const img = await fileToImgResized(f, 1536); if (sharp) { try { const m = await sharp(f.buffer).metadata(); img.w = m.width; img.h = m.height; } catch (e) {} } return img; })),
      angles: await Promise.all(angleFiles.map((f) => fileToImgResized(f, 1024))),
      logo: logoFiles.length ? await fileToImgResized(logoFiles[0], 1024) : null,
      heel: heelFiles.length ? await fileToImgResized(heelFiles[0], 1280) : null,
      bg: bgFiles.length ? await fileToImgResized(bgFiles[0], 1536) : null,
      labels: await Promise.all(labelFiles.map((f) => fileToImgResized(f, 900))),
      bases: await Promise.all(baseFiles.map(async (f) => { const img = await fileToImgResized(f, 1536); if (sharp) { try { const m = await sharp(f.buffer).metadata(); img.w = m.width; img.h = m.height; } catch (e) {} } return img; })),
      createdAt: Date.now(),
    });

    res.json({ referenceId, productCount: productFiles.length, angleCount: angleFiles.length });
  }
);

// Generate ONE angle frame, using that angle's reference photo + the
// product reference photo(s) together. The frontend calls this once per
// angle, in order, awaiting each before starting the next.
app.post('/api/generate-angle', async (req, res) => {
  let slotHeld = false;
  try {
    if ((req.body || {}).provider !== 'google' && !FREEPIK_API_KEY) {
      return res.status(500).json({ error: 'MAGNIFIC_API_KEY is not set on the server (.env file).' });
    }

    const {
      referenceId,
      prompt,
      angleIndex,
      angleLabel,
      aspectRatio = '4:5',
      resolution = '2k',
      model = 'nano-banana-pro',
      guideMode = 'silhouette',
      variant = 1,
      provider = 'freepik',
      googleApiKey = '',
      postProcess = 'off',
    } = req.body || {};
    const PP = String(postProcess) === 'on';

    if (provider !== 'google' && !ALLOWED_MODELS.has(model)) {
      return res.status(400).json({ error: `Unsupported model "${model}".` });
    }
    if (angleIndex === undefined || angleIndex === null) {
      return res.status(400).json({ error: 'Missing angleIndex.' });
    }

    const entry = referenceStore.get(referenceId);
    if (!entry) {
      return res.status(400).json({ error: 'Reference photos expired or not found — re-upload and try again.' });
    }
    const angleImg = entry.angles[angleIndex];
    if (!angleImg) {
      return res.status(400).json({ error: `No angle reference photo at index ${angleIndex}.` });
    }

    await acquireSlot();
    slotHeld = true;
    const gKeyForDesc = (googleApiKey || process.env.GOOGLE_API_KEY || '').trim();
    let angleDesc = null;
    if (guideMode === 'describe' || guideMode === 'none') {
      angleDesc = guideMode === 'describe' ? await describeAngle(angleImg, gKeyForDesc, angleLabel) : null;
    }
    if (guideMode === 'style') angleDesc = await describeAngle(angleImg, gKeyForDesc, angleLabel);
    const guideImg = guideMode === 'style' ? angleImg
      : (guideMode === 'none' || guideMode === 'describe') ? null : await angleGuide(angleImg, guideMode);
    const logoImg = entry.logo || null;
    const heelImg = entry.heel || null;
    console.log(`  frame "${angleLabel}" v${variant}: guide=${guideMode}${guideImg ? ' (' + guideImg.mime + ', ' + Math.round(guideImg.base64.length * 0.75 / 1024) + 'KB)' : ' (no angle image sent' + (angleDesc ? ', described in text' : '') + ')'} | logo: ${logoImg ? 'yes' : 'none'} | heel: ${heelImg ? 'yes' : 'none'} | product photos: ${entry.product.map((p) => p.name).join(', ')}`);

    const N = entry.product.length;
    const productText = 'the product to photograph (it is the same shoe in every product image)';
    const angleText = guideMode === 'style'
      ? 'the photo to edit. Keep its background, lighting, shadow, camera angle and framing. The shoe in it will be replaced by my product.'
      : guideMode === 'photo'
      ? 'camera-angle reference only: copy the viewpoint, framing and pose. The item in it is NOT the product.'
      : 'grey camera-angle guide: match its viewpoint, framing and pose. It has no colour or material information.';

    let brief = (prompt || '').trim();
    if (/ballet flat in cognac tan/i.test(brief)) { console.warn('  brief looks like the example placeholder text — ignoring it'); brief = ''; }

    const lines = [];
    if (guideMode === 'style') {
      const pr = N > 1 ? `images 2 to ${N + 1}` : 'image 2';
      lines.push(`Edit image 1. Keep image 1 exactly as it is: same background, same background colour, same lighting, same shadow, same camera angle, same framing and same position of the shoe. Replace ONLY the shoe in image 1 with the shoe shown in ${pr} (${pr} all show the same shoe, my product). The new shoe must be reproduced exactly from ${pr}: identical shape, last, colour, leather, sole, stitching, hardware and proportions, even if it is very different from the shoe currently in image 1. Nothing of the original shoe in image 1 may remain.`);
      if (angleDesc) lines.push(`For reference, the camera angle of image 1 in words: ${angleDesc}`);
      if (brief) lines.push(`Product notes: ${brief}. If these notes ever conflict with the product images, the product images are correct.`);
      lines.push('The whole shoe must be fully inside the frame with an even margin, nothing cropped, no second object, no text.');
      lines.push(logoImg
        ? 'The logo image shows the brand\'s exact logo; reproduce it precisely, only where it appears on the shoe in the product images.'
        : 'Do not add any logo, text, monogram or embossing that is not clearly visible in the product images.');
      lines.push(`Output one photorealistic image only, ${aspectRatio} aspect ratio, sharp focus, true-to-life colour.`);
    }
    if (guideMode !== 'style') lines.push(`Create one professional e-commerce product photograph of the shoe shown in ${N > 1 ? 'product images 1 to ' + N : 'product image 1'}. It is the same shoe in every product image. Reproduce it exactly: identical shape, last, colour, leather, sole, stitching, hardware and proportions. Do not redesign, recolour, lighten or simplify it.`);
    if (guideMode !== 'style' && brief) lines.push(`Product notes: ${brief}. If these notes ever conflict with the product images, the product images are correct.`);
    if (guideMode === 'style') {
      // handled above
      void 0; if (false) lines.push(`The final image is a style reference: a different shoe photographed in a studio. From it take ONLY the camera angle, framing, background colour and the shadow (same shape, softness, direction and strength). Place my shoe in exactly the same position and pose. Do not copy the shape, colour, material, sole or any detail of that other shoe.`);
      if (angleDesc) lines.push(`Camera angle in words: ${angleDesc}`);
    } else if (guideImg) {
      lines.push(`The final image is a grey camera-angle guide: match its viewpoint, framing and pose. It contains no colour or material information.`);
    } else {
      lines.push(`Camera angle and composition: ${angleDesc || angleLabel || 'front three-quarter view at eye level'}.`);
    }
    if (guideMode !== 'style') lines.push('Background: seamless pure white (#FFFFFF) with even, soft studio lighting, and only a faint, soft contact shadow directly under the sole. No other shadows, no props, no text.');
    if (guideMode !== 'style') lines.push('The whole shoe must be fully inside the frame, centred, with an even margin on every side. Nothing cropped, no second object, no sketch or silhouette.');
    if (guideMode !== 'style') lines.push(logoImg
      ? 'The logo image shows the brand\'s exact logo; reproduce it precisely, only where it appears on the shoe in the product images.'
      : 'Do not add any logo, text, monogram or embossing that is not clearly visible in the product images.');
    if (guideMode !== 'style') lines.push(`Output one photorealistic image only, ${aspectRatio} aspect ratio, sharp focus, true-to-life colour.`);
    if (heelImg && guideMode !== 'manual') lines.push('A heel reference image is included: the heel and back of the shoe must match it exactly — same height, thickness and profile.');
    const fullPrompt = lines.join(' ');
    console.log('  prompt -> ' + fullPrompt.slice(0, 220) + '…');


    if (provider === 'google') {
      const key = (googleApiKey || process.env.GOOGLE_API_KEY || '').trim();
      if (!key) throw new Error('No Google API key. Paste it in the Google Nano Banana tab.');
      const gModel = GOOGLE_MODELS.has(model) ? model : 'gemini-3-pro-image-preview';
      const g = await googleGenerate({ apiKey: key, model: gModel, prompt: fullPrompt, productImgs: entry.product, guideImg, logoImg, heelImg, productText, angleText, aspectRatio, resolution, styleFirst: guideMode === 'style' });
      let cleaned;
      try { cleaned = PP ? await cleanBuffer(g.buf, variant, g.mime, guideMode === 'style' ? 0 : undefined) : await passthrough(g.buf, g.mime); } catch (e) { cleaned = { buf: g.buf, mime: g.mime, width: 0, height: 0 }; }
      const id = crypto.randomUUID();
      generatedStore.set(id, { ...cleaned, createdAt: Date.now() });
      console.log(`  [google/${gModel}] frame "${angleLabel}" v${variant}: ${PP ? 'post-processed' : 'RAW (untouched)'} done ${cleaned.width}x${cleaned.height} (requested ${String(resolution).toUpperCase()})`);
      return res.json({ angleLabel, angleIndex, variant, status: 'COMPLETED', provider: 'google', imageUrl: `/api/image/${id}.png`, width: cleaned.width, height: cleaned.height });
    }

    let created = null;
    let lastErr = null;
    for (const host of HOST_CHAIN) {
      try {
        const referenceImages = [];
        if (guideMode === 'style' && guideImg) referenceImages.push({ image: await hostImage(guideImg, host), mime_type: guideImg.mime, text: angleText });
        for (const img of entry.product) {
          referenceImages.push({ image: await hostImage(img, host), mime_type: img.mime, text: productText });
        }
        if (heelImg) referenceImages.push({ image: await hostImage(heelImg, host), mime_type: heelImg.mime, text: 'HEEL REFERENCE — shows only the exact heel and back shape of my product (height, thickness, profile). Use it for the heel/back; it is not a separate product.' });
        if (logoImg) referenceImages.push({ image: await hostImage(logoImg, host), mime_type: logoImg.mime, text: 'LOGO — the exact brand logo artwork of this product. Use it only to reproduce the logo correctly where it belongs on the product.' });
        if (guideImg && guideMode !== 'style') referenceImages.push({ image: await hostImage(guideImg, host), mime_type: guideImg.mime, text: angleText });

        created = await createTask(model, {
          prompt: fullPrompt,
          reference_images: referenceImages,
          aspect_ratio: aspectRatio,
          resolution: String(resolution).toUpperCase(),
          use_google_search_tool: false,
        });
        console.log(`  angle "${angleLabel}": accepted using image host "${host}"`);
        break;
      } catch (err) {
        lastErr = err;
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        console.warn(`  angle "${angleLabel}": host "${host}" failed -> ${detail}`);
        if (err.response && !isImageResolveError(err)) throw err; // not an image-hosting problem, don't keep trying
      }
    }
    if (!created) throw lastErr || new Error('All image hosts failed.');

    let finalTask = created;
    const initialStatus = (created.status || '').toUpperCase();
    if (initialStatus !== 'COMPLETED') {
      finalTask = await pollTask(model, created.task_id);
    }

    const generated = finalTask.generated || [];
    if (!generated.length) {
      throw new Error('Freepik finished but returned no image.');
    }

    let imageUrl = generated[0];
    let width = 0, height = 0;
    try {
      const cleaned = PP
        ? await cleanBackground(generated[0], variant, guideMode === 'style' ? 0 : undefined)
        : await passthrough(Buffer.from((await axios.get(generated[0], { responseType: 'arraybuffer' })).data), 'image/png');
      const id = crypto.randomUUID();
      generatedStore.set(id, { ...cleaned, createdAt: Date.now() });
      imageUrl = `/api/image/${id}.png`;
      width = cleaned.width; height = cleaned.height;
      console.log(`  frame "${angleLabel}" v${variant}: done ${width}x${height} (requested ${String(resolution).toUpperCase()})`);
    } catch (e) {
      console.warn('  background clean failed, serving original:', e.message);
    }

    res.json({
      angleLabel,
      angleIndex,
      variant,
      status: 'COMPLETED',
      taskId: finalTask.task_id || created.task_id,
      imageUrl,
      originalUrl: generated[0],
      width,
      height,
    });
  } catch (err) {
    console.error('generate-angle error:', err.response ? err.response.data : err.message);
    res.status(200).json({
      angleLabel: req.body ? req.body.angleLabel : undefined,
      angleIndex: req.body ? req.body.angleIndex : undefined,
      variant: req.body ? req.body.variant : undefined,
      status: 'FAILED',
      error: friendlyError(err),
    });
  } finally {
    if (slotHeld) releaseSlot();
  }
});

// Preview what the angle guide looks like for a given uploaded angle
app.get('/api/guide/:referenceId/:idx', async (req, res) => {
  const entry = referenceStore.get(req.params.referenceId);
  const img = entry && entry.angles[Number(req.params.idx)];
  if (!img) return res.status(404).end();
  const mode = req.query.mode || 'silhouette';
  try {
    const g = mode === 'style' ? await makeStyleGuide(img) : await angleGuide(img, mode);
    res.setHeader('Content-Type', g.mime);
    res.send(Buffer.from(g.base64, 'base64'));
  } catch (e) { res.status(500).end(); }
});

app.get('/api/image/:id', (req, res) => {
  const g = generatedStore.get(String(req.params.id).replace(/\.(jpg|png)$/, ''));
  if (!g) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (req.query.thumb && g.thumb) { res.setHeader('Content-Type', 'image/jpeg'); return res.send(g.thumb); }
  res.setHeader('Content-Type', g.mime);
  res.send(g.buf);
});

// Swap / free-prompt editing on lifestyle & sample photos
app.post('/api/edit', async (req, res) => {
  let slotHeld = false;
  try {
    const {
      referenceId, baseIndex, mode = 'swap', category = 'shoes', categoryLabel = '',
      prompt = '', variant = 1, resolution = '2k', logoColor = 'white', aspectRatio = 'auto', // PATCH34
      brandText = '', labelOverlay = 'on', logoMode = 'replace',
      part = 'buckle', partLabel = '', color = 'gold', colorLabel = '',
      fit = 'product', fitLabel = '', bottomsStyle = 'product', bottomsLabel = '', logosOpt = 'keep',
      bgChoice = 'white', bgCustom = '', shadowSrc = 'auto',
      copyAngle = 'on', copyShape = 'on', copyShadow = 'on', copyBg = 'on',
      provider = 'google', model = 'gemini-3-pro-image-preview', googleApiKey = '',
    } = req.body || {};
    const entry = referenceStore.get(referenceId);
    if (!entry) return res.status(400).json({ error: 'Photos expired or not found — re-upload and try again.' });
    // APPAREL_EDIT_V2: in apparel mode each PRODUCT photo is the base image being edited (shape + labels preserved)
    const isApparel = mode === 'apparel';
    const base = isApparel ? (entry.product && entry.product[Number(baseIndex)]) : (entry.bases && entry.bases[Number(baseIndex)]);
    if (!base) return res.status(400).json({ error: 'No ' + (isApparel ? 'product' : 'sample') + ' photo at index ' + baseIndex });
    const styleRef = isApparel ? (entry.bases && entry.bases[0]) : null;
    if (mode !== 'logo' && mode !== 'recolor' && mode !== 'bg' && mode !== 'pose' && !entry.product.length) return res.status(400).json({ error: 'Upload product photos too.' });

    await acquireSlot(); slotHeld = true;
    const P = entry.product.length;
    const catNames = { shoes: 'shoes/footwear', top: 'top (shirt/blouse/jacket)', bottoms: 'bottoms (trousers/skirt)', dress: 'dress', bag: 'bag', other: categoryLabel || 'item' };
    const cat = catNames[category] || catNames.shoes;

    let instruction;
    if (mode === 'pose') {
      if (!entry.bg) throw new Error('Add the reference image (angle / shape / shadow / background).');
      const copies = [];
      if (String(copyAngle) !== 'off') copies.push('the exact CAMERA ANGLE and viewpoint');
      if (String(copyShape) !== 'off') copies.push('the SHAPE AND PRESENTATION — how the shoe is posed, how it stands or rests, its stance and silhouette on the ground');
      if (String(copyShadow) !== 'off') copies.push('the SHADOW — same shape, softness, direction and strength');
      if (String(copyBg) !== 'off') copies.push('the BACKGROUND — same colour, tone and lighting');
      const keeps = [];
      if (String(copyAngle) === 'off') keeps.push('keep my photo\'s own camera angle');
      if (String(copyShape) === 'off') keeps.push('keep my product\'s own pose');
      if (String(copyShadow) === 'off') keeps.push('keep my photo\'s own shadow');
      if (String(copyBg) === 'off') keeps.push('keep my photo\'s own background');
      instruction = [
        'Image 1 is my product photo. The reference image shows a DIFFERENT product photographed professionally.',
        'Re-photograph MY product copying from the reference image ONLY: ' + (copies.length ? copies.join('; ') : 'nothing') + '.' + (keeps.length ? ' Also: ' + keeps.join('; ') + '.' : ''),
        'THE PRODUCT STAYS MINE, IDENTICAL: same design, same colours, same materials and textures, same bow/straps/details, same stitching, same sole, same proportions and true size, same labels and logos — exactly as in image 1. Copy NOTHING of the reference product\'s design, colour or material. Do not redesign, slim, stretch or restyle my product; it is my product, simply photographed like the reference.',
        'Premium e-commerce quality, sharp focus, true-to-life colour. Output one photorealistic image only.',
      ].join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'bg') {
      const hasRef = !!entry.bg;
      const BGS = {
        white: 'a clean, seamless, pure WHITE (#FFFFFF) studio background, perfectly uniform edge to edge',
        grey: 'a clean, seamless, light grey (#F8F8F8) studio background, perfectly uniform edge to edge',
        custom: bgCustom ? 'a clean, seamless, uniform studio background in this colour: ' + bgCustom : 'a clean, seamless, uniform studio background',
        ref: hasRef ? 'the exact background shown in the background reference image (same colour, tone and gradient)' : 'a clean, seamless, pure WHITE (#FFFFFF) studio background',
      };
      const bgText = BGS[String(bgChoice)] || BGS.white;
      const shText = String(shadowSrc) === 'ref' && hasRef
        ? 'SHADOW: copy the shadow style from the background reference image — same shape, softness, direction and strength, applied naturally under my product.'
        : 'SHADOW: add a soft, professional, natural contact shadow directly under the product where it touches the ground, like premium Nordstrom studio product photography — subtle and tight, no long cast shadow, no floating look.';
      instruction = [
        'Edit sample photo 1 (my product photo). This is a background replacement only, NOT a re-creation.',
        'KEEP THE PRODUCT PIXEL-IDENTICAL: same shape, colours, materials, texture, stitching, logos, labels and every detail, same position, same angle, same size in frame. Do not redraw or restyle the product in any way.',
        'BACKGROUND: remove the current background completely — including any old background problems, uneven colour, marks, cut-out halos, props, hands or surfaces — and replace it with ' + bgText + '.',
        shText,
        'Lighting on the product stays as photographed, just cleanly separated from the new background. Output one photorealistic image only.',
      ].join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'recolor') {
      const PARTS = {
        buckle: 'the buckle and all small metal hardware (buckles, rings, studs, eyelets)',
        shoe: 'the entire shoe/upper (every panel of the shoe body)',
        sole: 'the sole only (outsole and midsole edge)',
        strap: 'the strap(s) only',
        laces: 'the laces only',
        heel: 'the heel only',
        other: partLabel || 'the selected part',
      };
      const COLORS = {
        gold: 'metallic GOLD with a realistic polished gold finish and natural reflections',
        silver: 'metallic SILVER with a realistic polished finish and natural reflections',
        black: 'BLACK, matching a natural factory finish for that material',
        white: 'WHITE, matching a natural factory finish for that material',
        red: 'RED, matching a natural factory finish for that material',
        other: colorLabel ? colorLabel + ', rendered as a natural factory finish for that material' : 'the requested colour',
        ref: entry.bg ? 'the EXACT colour, tone and finish shown in the colour reference image — match that colour precisely, as a natural factory finish for the material' : 'the requested colour',
      };
      const partText = PARTS[String(part)] || PARTS.buckle;
      const colorText = COLORS[String(color)] || COLORS.gold;
      instruction = 'Edit sample photo 1. Keep absolutely everything in the photo identical — the product, its shape, material, texture, stitching, the background, lighting, shadows and reflections. ' + (String(color) === 'ref' && entry.bg ? 'The colour reference image is included ONLY for its colour — copy nothing else from it. ' : '') + 'Change ONLY the colour of ' + partText + ': recolour it to ' + colorText + '. The part keeps its exact shape, size, texture and position; every other part of the product and the image stays untouched, with no colour bleeding onto neighbouring parts. IMPORTANT: if the product does not have the selected part (for example no buckle exists on this shoe), then change NOTHING and return the photo unmodified — never invent or add a new part, strap, buckle or detail that is not already on the product. If the photo shows a pair, recolour that part on BOTH items identically. Output one photorealistic image only.';
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'apparel') {
      instruction = [
        'Edit image 1 (my product photo). This is a professional retouching job, NOT a re-creation.',
        String(logoMode) === 'replace'
          ? 'Image roles: use Image 1 for the garment, its shape and the position, size and orientation of every label; use the additional product photos for the label positions and the garment details; the logo image is the COMPLETE new artwork for every label; use the style reference only for background, lighting and finish.'
          : 'Image roles: use Image 1 for the garment, its shape and the position of every label; use the additional product photos for the exact look of each label up close; use the logo image only for the exact icon and lettering; use the style reference only for background, lighting and finish.',
        String(logoMode) === 'replace'
          ? 'LABEL ARTWORK — REPLACE THE PRINT, KEEP THE LABEL. My garment has sewn-in black woven brand labels: one at the inside back neck and one flag tag at the right hem/side seam (see the additional product photos). Both labels MUST STAY exactly where they are: same black label rectangle, same size, same stitching, same position, same orientation. Do NOT remove either label and do NOT print anything directly onto the shirt fabric. Change ONLY the design printed/woven on the face of each label: erase the old design (the doll/figure icon and the old lettering) and put ' + (entry.logo ? (String(brandText).trim() ? 'the text "' + String(brandText).trim().replace(/"/g, '') + '" in that exact script font' : 'the text of the logo image in that exact script font') : /* NO_LOGO_IMAGE_MODE */ (String(brandText).trim() ? 'the text "' + String(brandText).trim().replace(/"/g, '') + '" in the SAME script lettering that is already on the labels in the product photos (keep that existing lettering exactly, just without the icon)' : 'the existing lettering that is already on the labels in the product photos, kept exactly as it is, just without the icon')) + ', white on the black label, centred, sized to fit inside the label with a small margin — text only, NO icon, NO figure, NO symbol. The neck label keeps the text horizontal; the hem flag tag keeps the text running along the tag as before. The hem tag must be updated exactly the same way as the neck label — its doll icon must also be gone. SIZE LABEL: the separate small white size label next to the neck label (it reads the size, e.g. "M") is NOT a brand label — keep it exactly as photographed, same place, same size, same text, untouched. Any care label stays too. Only the brand labels get the new print; nothing else is removed.'
          : (String(brandText).trim() ? 'Every brand label on the garment reads exactly "' + String(brandText).trim().replace(/"/g, '') + '" in the script lettering of the logo image, spelled exactly like that, at the label\'s existing size and arrangement.' : ''),
        'KEEP EXACTLY, PIXEL FOR PIXEL WHERE POSSIBLE: the garment itself — its shape, silhouette, cut, proportions, sleeve length and width, neckline, hem, the way it lies, its colour and fabric — and every sewn-in label and tag exactly as photographed (same label, same place, same size), the size label, the hem/side tag' + (String(logoMode) === 'replace' ? ' — only the ARTWORK on the brand labels changes, as instructed below.' : ': the neck label with its icon and lettering in the same arrangement.') + ' Do not redraw, restyle, move, resize, rearrange or remove any label. Do not change the garment\'s shape in any way; do not make it boxier, slimmer, longer or wider.',
        (entry.bg
          ? 'CHANGE ONLY THE PHOTOGRAPHY: replace the background with the background shown in the background reference image; '
          : (styleRef
            ? 'CHANGE ONLY THE PHOTOGRAPHY: replace the background with the same clean background as the style reference image; '
            : 'CHANGE ONLY THE PHOTOGRAPHY: replace the background with a clean seamless pure white studio background; '))
          + 'add a soft, professional, natural drop shadow under the garment; remove the hanging tag string, hangtag, price tag, sticker, pin or clip if any is present (these are not part of the garment); smooth away every wrinkle, crease, fold line and fabric ripple (including small ones on the body, sleeves and hem) so the fabric looks freshly steamed and perfectly flat, without changing the garment\'s outline; correct the lighting and white balance to premium, even, soft studio lighting with rich true-to-life colour and clean sharp edges'
          + (styleRef ? ', matching the professional finish, lighting quality and presentation of the style reference image.' : '.'),
        entry.logo ? (String(logoMode) === 'replace'
          ? 'The logo image is the only artwork allowed on the brand labels. Render it crisp and fully legible, same letterforms as the logo image. Never add a logo anywhere the garment has no label.'
          : 'The logo image shows the exact artwork used on my labels. Use it ONLY to keep the label artwork crisp and accurate at its existing size, position and arrangement on the garment — never to add, enlarge or rearrange anything.') : '',
        'Framing: keep the garment centred with a comfortable even margin, the whole garment visible, nothing cropped.',
        'Output one photorealistic image only, sharp focus, true-to-life colour.',
      ].filter(Boolean).join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'logo') {
      if (!entry.logo) throw new Error('Upload your logo image first (Brand logo upload).');
      const LOGO_COLORS = {
        white: 'WHITE (clean opaque white print)',
        silver: 'SILVER — metallic silver foil print with a subtle realistic metallic sheen that catches the light',
        black: 'BLACK (clean opaque black print)',
        red: 'RED (clean opaque brand red print)',
        gold: 'GOLD — metallic gold foil print with a subtle realistic metallic sheen',
      };
      const colorText = LOGO_COLORS[String(logoColor).toLowerCase()] || LOGO_COLORS.white;
      instruction = `Edit sample photo 1. Keep absolutely everything in the photo identical — the product, its shape, colour, material, the background, lighting and shadows. Only change the brand logo: remove every existing logo, brand text or marking, then print the logo from the logo image on the sock lining (the heel area of the insole/footbed where a brand logo is normally printed on footwear) — once per sandal: if two or more sandals/shoes are visible in the photo, every one whose footbed is visible gets the identical logo in the identical position and size, in ` + colorText + `, oriented along the length of the shoe — the text runs from the heel toward the toe, so in a top-down photo it reads vertically. Standard small footwear branding size: subtle, clearly smaller than the width of the footbed, never more than about 15 percent of the shoe\'s length. Keep the logo\'s own letterforms and proportions from the logo image, do not stretch, stack, distort or repeat it, and follow the surface curve and perspective of the footbed naturally, like a real screen print. If a sandal's footbed/sock lining is not clearly visible (for example a pure side profile or a very low camera angle), do NOT paint any logo on that sandal at all — leave it unbranded, exactly like a real photo where the insole print cannot be seen. Do not change anything else. Output one photorealistic image only.`;
      instruction = instruction.replace(/\\'/g, "'");
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'free') {
      if (!String(prompt).trim()) throw new Error('Write your prompt — it is sent exactly as written.');
      instruction = String(prompt).trim();
    } else {
      const FITS = {
        product: 'CRITICAL — FIT COMES FROM MY PRODUCT, NOT FROM THE ORIGINAL GARMENT: reproduce the exact fit, cut and silhouette of my product as shown in the product photos. If my product is relaxed or loose, it must look relaxed and loose on the model with natural drape and ease — do NOT make it slim or body-hugging just because the original garment in the photo was fitted. If my product is slim, keep it slim.',
        notrelaxed: 'FIT: NOT RELAXED — a clean regular fit with minimal ease, following the body without hugging it.',
        slight: 'FIT: SLIGHTLY RELAXED — just a little ease, gently skimming the body with a soft drape.',
        relaxed: 'FIT: RELAXED — clearly loose with comfortable ease and natural drape, not clinging to the body anywhere.',
        toorelaxed: 'FIT: TOO RELAXED / OVERSIZED — very loose and roomy, generous volume, heavy drape, sleeves and body clearly wider than the person.',
        slim: 'FIT: SLIM — close to the body but not skin-tight.',
        fitted: 'FIT: BODY-FITTED — hugging the body closely, following its shape.',
        layered: 'FIT: LAYER RELAXED — relaxed with a layered look, worn naturally with soft volume over the other clothing.',
        oversized: 'FIT: OVERSIZED — clearly loose and roomy with heavy drape.',
        other: fitLabel ? 'FIT: ' + fitLabel : '',
      };
      const BSTYLES = {
        product: '',
        high: 'BOTTOMS STYLE: HIGH-WAISTED — the waistband sits high on the waist.',
        straight: 'BOTTOMS STYLE: STRAIGHT LEG from hip to hem.',
        flare: 'BOTTOMS STYLE: FLARE — fitted through the thigh, widening from the knee.',
        bootcut: 'BOTTOMS STYLE: BOOTCUT — slight flare from the knee over the shoe.',
        wide: 'BOTTOMS STYLE: WIDE LEG — loose and wide from hip to hem.',
        skinny: 'BOTTOMS STYLE: SKINNY — tight through the whole leg.',
        other: bottomsLabel ? 'BOTTOMS STYLE: ' + bottomsLabel : '',
      };
      const fitText = FITS[String(fit)] !== undefined ? FITS[String(fit)] : FITS.product;
      const bText = BSTYLES[String(bottomsStyle)] !== undefined ? BSTYLES[String(bottomsStyle)] : '';
      const logosText = String(logosOpt) === 'remove'
        ? 'LOGOS: remove every visible brand logo, brand label, hem tag, side tag, patch, button logo, embroidery or brand text from the garment — it must look completely plain and unbranded.'
        : 'LOGOS AND LABELS: keep every logo, label, hem tag and marking exactly as it appears on my product in the product photos — do not remove or invent any.';
      instruction = [
        `Edit sample photo 1. Keep absolutely everything the same — the person, face, pose, skin, hair, all other clothing, the background, lighting, colours and shadows. Replace ONLY the ${cat} worn in the photo with my product shown in product photo${P > 1 ? 's 1 to ' + P : ' 1'}. My product must be reproduced exactly: same shape, colour, material, texture and details as in the product photos, with correct perspective, size and lighting for the scene.`,
        fitText, bText, logosText,
        'Output one photorealistic image only.',
      ].filter(Boolean).join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    }

    const aspect = nearestAspect(base.w, base.h); // generate at the photo's own ratio so it stays an in-place edit
    const targetAspect = (aspectRatio && aspectRatio !== 'auto') ? String(aspectRatio) : null; // applied by padding after generation
    const parts = [];
    if (isApparel) {
      parts.push({ text: 'Image 1: my product photo — the photo to edit.' });
      parts.push({ inline_data: { mime_type: base.mime, data: base.base64 } });
      if (styleRef) { parts.push({ text: 'Style reference image: shows the professional finish, background and lighting quality to match (a different garment — copy nothing from that garment).' }); parts.push({ inline_data: { mime_type: styleRef.mime, data: styleRef.base64 } }); }
      entry.product.forEach((img, i) => {
        if (i === Number(baseIndex)) return;
        parts.push({ text: `Additional product photo ${i + 1}: the same garment, for reference on details and labels.` });
        parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
      });
    } else {
      parts.push({ text: 'Sample photo 1: the photo to edit.' });
      parts.push({ inline_data: { mime_type: base.mime, data: base.base64 } });
      entry.product.forEach((img, i) => {
        parts.push({ text: `Product photo ${i + 1}: my product.` });
        parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
      });
    }
    if (entry.heel) { parts.push({ text: 'Heel reference: only the heel/back shape of my product.' }); parts.push({ inline_data: { mime_type: entry.heel.mime, data: entry.heel.base64 } }); }
    if (entry.logo) { parts.push({ text: 'Logo image: the exact brand logo of my product.' }); parts.push({ inline_data: { mime_type: entry.logo.mime, data: entry.logo.base64 } }); }
    if (entry.bg) { parts.push({ text: 'Background reference image: use this background.' }); parts.push({ inline_data: { mime_type: entry.bg.mime, data: entry.bg.base64 } }); }
    parts.push({ text: instruction });
    console.log(`  [edit/${mode}] photo ${Number(baseIndex) + 1} v${variant} (${aspect}) prompt -> ` + instruction.slice(0, 180) + '…');

    let g;
    if (provider === 'google') {
      const key = (googleApiKey || process.env.GOOGLE_API_KEY || '').trim();
      if (!key) throw new Error('No Google API key.');
      const gModel = GOOGLE_MODELS.has(model) ? model : 'gemini-3-pro-image-preview';
      g = await googleFromParts({ apiKey: key, model: gModel, parts, aspectRatio: aspect, resolution });
    } else {
      const refImgs = [
        { image: await hostImage(base, 'base64'), mime_type: base.mime, text: isApparel ? 'Image 1: my product photo — the photo to edit.' : 'Sample photo 1: the photo to edit.' },
        ...(isApparel && styleRef ? [{ image: await hostImage(styleRef, 'base64'), mime_type: styleRef.mime, text: 'Style reference image: professional finish, background and lighting to match.' }] : []),
        ...(await Promise.all(entry.product.map(async (img, i) => ({ image: await hostImage(img, 'base64'), mime_type: img.mime, text: `Product photo ${i + 1}: my product.` })))),
      ];
      if (entry.logo) refImgs.push({ image: await hostImage(entry.logo, 'base64'), mime_type: entry.logo.mime, text: 'Logo image: the exact brand logo of my product.' });
      if (entry.bg) refImgs.push({ image: await hostImage(entry.bg, 'base64'), mime_type: entry.bg.mime, text: 'Background reference image: use this background.' });
      const created = await createTask(ALLOWED_MODELS.has(model) ? model : 'nano-banana-pro', {
        prompt: instruction, reference_images: refImgs, aspect_ratio: aspect, resolution: String(resolution).toUpperCase(), use_google_search_tool: false,
      });
      const finalTask = (created.status || '').toUpperCase() === 'COMPLETED' ? created : await pollTask(ALLOWED_MODELS.has(model) ? model : 'nano-banana-pro', created.task_id);
      const gen = finalTask.generated || [];
      if (!gen.length) throw new Error('No image returned.');
      const r = await axios.get(gen[0], { responseType: 'arraybuffer' });
      g = { buf: Buffer.from(r.data), mime: 'image/png' };
    }
    let outBuf = g.buf;
    if (mode === 'apparel' && String(labelOverlay) !== 'off' && ((entry.labels && entry.labels.length) || (String(logoMode) === 'replace' && entry.logo))) {
      try {
        let labelSet = entry.labels && entry.labels.length ? entry.labels : null;
        if (!labelSet) {
          if (!entry.autoLabels) { entry.autoLabels = await buildLabelArtworks(entry.logo); console.log('  built ' + entry.autoLabels.length + ' label artworks from the logo image'); }
          labelSet = entry.autoLabels;
        }
        const r = await overlayLabels(outBuf, labelSet, entry.labels && entry.labels.length ? 0.45 : 0.68); // auto-built labels need a confident match
        outBuf = r.buf;
        console.log('  label overlay: ' + r.hits.map((h, i) => 'label ' + (i + 1) + (h ? ' pasted at ' + h.x + ',' + h.y + ' ' + h.w + 'x' + h.h + ' (match ' + h.score.toFixed(2) + ')' : ' not pasted — no confident match, left as generated')).join('; '));
      } catch (e) { console.warn('  label overlay failed: ' + e.message); }
    }
    if (targetAspect) { try { outBuf = await padToAspect(g.buf, targetAspect); } catch (e) { console.warn('  pad to ' + targetAspect + ' failed: ' + e.message); } }
    const cleaned = await passthrough(outBuf, targetAspect ? 'image/png' : g.mime);
    console.log(`  [edit/${mode}] photo ${Number(baseIndex) + 1} v${variant}: done ${cleaned.width}x${cleaned.height} (requested ${String(resolution).toUpperCase()}, generated ${aspect}${targetAspect ? ', padded to ' + targetAspect : ''}) via ${provider}/${model}`);
    const id = crypto.randomUUID();
    generatedStore.set(id, { ...cleaned, createdAt: Date.now() });
    res.json({ status: 'COMPLETED', imageUrl: `/api/image/${id}.png`, width: cleaned.width, height: cleaned.height, variant, baseIndex });
  } catch (err) {
    console.error('edit error:', err.message);
    res.status(200).json({ status: 'FAILED', error: err.message, variant: req.body && req.body.variant, baseIndex: req.body && req.body.baseIndex });
  } finally {
    if (slotHeld) releaseSlot();
  }
});

// Bundle every finished frame into a single downloadable zip
app.post('/api/zip', async (req, res) => {
  try {
    const { images } = req.body || {};
    if (!images || !images.length) {
      return res.status(400).json({ error: 'No images to zip.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="product-angle-set.zip"');

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', (err) => {
      console.error('archive error:', err);
      res.status(500).end();
    });
    archive.pipe(res);

    let index = 1;
    for (const img of images) {
      try {
        let bytes;
        if (String(img.url).startsWith('/api/image/')) {
          const g = generatedStore.get(img.url.replace('/api/image/', '').replace(/\.(jpg|png)$/, ''));
          if (!g) throw new Error('cleaned image expired');
          bytes = g.buf;
        } else {
          const response = await axios.get(img.url, { responseType: 'arraybuffer' });
          bytes = Buffer.from(response.data);
        }
        const safeLabel = (img.label || `angle-${index}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        archive.append(bytes, { name: `${String(index).padStart(2, '0')}-${safeLabel}.png` });
      } catch (e) {
        console.error(`Failed to fetch ${img.url} for zip:`, e.message);
      }
      index++;
    }

    await archive.finalize();
  } catch (err) {
    console.error('zip error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build zip.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Freepik Angle Studio running → http://localhost:${PORT}\n`);
  if (!FREEPIK_API_KEY) {
    console.warn('  ⚠️  MAGNIFIC_API_KEY is missing — set it in .env before generating images.\n');
  }
});
