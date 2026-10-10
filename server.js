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
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, maxBodyLength: Infinity, timeout: 600000,
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
// Fill the frame: centre-crop to the target ratio instead of adding padding bands (used for model photos)
async function cropToAspect(buf, targetAspect) {
  let t = targetAspect;
  if (typeof t === 'string' && t.includes(':')) { const [w, h] = t.split(':').map(Number); t = w / h; } else t = Number(t);
  if (!t || !isFinite(t)) return buf;
  const m = await sharp(buf).metadata();
  const W = m.width, H = m.height, cur = W / H;
  if (Math.abs(cur - t) < 0.005) return buf;
  let cw = W, ch = H;
  if (cur > t) cw = Math.round(H * t); else ch = Math.round(W / t);
  const left = Math.round((W - cw) / 2), top = Math.round((H - ch) / 2);
  return sharp(buf).extract({ left, top, width: cw, height: ch }).png().toBuffer();
}

// Background tab: force the backdrop to pure white/#F8F8F8, keep the product and its shadow (pixel math, no AI)
async function softenShadow(buf, t, factor) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const SW = Math.min(700, W), SH = Math.max(8, Math.round(H * SW / W)), N = SW * SH;
  const sm = await sharp(buf).removeAlpha().resize(SW, SH, { fit: 'fill' }).blur(0.6).raw().toBuffer();
  const cand = new Uint8Array(N);
  for (let p = 0; p < N; p++) { const r = sm[p * 3], g = sm[p * 3 + 1], b = sm[p * 3 + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); cand[p] = (mx - mn <= 14 && mx >= 95) ? 1 : 0; }
  const mask = new Uint8Array(N), q = new Int32Array(N); let h = 0, tl = 0;
  const push = (p) => { if (cand[p] && !mask[p]) { mask[p] = 1; q[tl++] = p; } };
  for (let x = 0; x < SW; x++) { push(x); push(x + (SH - 1) * SW); }
  for (let y = 0; y < SH; y++) { push(y * SW); push(y * SW + SW - 1); }
  while (h < tl) { const p = q[h++], x = p % SW, y = (p - x) / SW; if (x > 0) push(p - 1); if (x < SW - 1) push(p + 1); if (y > 0) push(p - SW); if (y < SH - 1) push(p + SW); }
  const m8 = Buffer.alloc(N); for (let p = 0; p < N; p++) m8[p] = mask[p] ? 255 : 0;
  const mE = await sharp(m8, { raw: { width: SW, height: SH, channels: 1 } }).blur(1).threshold(200).extractChannel(0).raw().toBuffer();
  for (let p = 0; p < N; p++) { const x = p % SW, y = (p - x) / SW; if (m8[p] && (x < 3 || y < 3 || x >= SW - 3 || y >= SH - 3)) mE[p] = 255; }
  const mF = await sharp(mE, { raw: { width: SW, height: SH, channels: 1 } }).resize(W, H, { fit: 'fill' }).blur(Math.max(1.2, W / 1600)).extractChannel(0).raw().toBuffer();
  for (let p = 0; p < W * H; p++) {
    if ((p & 0xFFFFF) === 0) await new Promise((r) => setImmediate(r));
    const m = mF[p] / 255; if (m <= 0.004) continue;
    const i = p * 3;
    for (let c = 0; c < 3; c++) { const v = data[i + c]; if (v >= t[c]) continue; const nv = t[c] - (t[c] - v) * factor; data[i + c] = Math.round(v + (nv - v) * m); }
  }
  console.log('  shadow softened to ' + Math.round(factor * 100) + '% strength');
  return sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function liftToBackdrop(buf, t) {
  if ((t[0] + t[1] + t[2]) / 3 < 200) return buf;
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const SW = 256, SH = Math.max(8, Math.round(H * SW / W));
  const sm = await sharp(buf).removeAlpha().resize(SW, SH, { fit: 'fill' }).raw().toBuffer();
  const lum = (x, y) => { const i = (y * SW + x) * 3; return Math.max(sm[i], sm[i + 1], sm[i + 2]); };
  const smooth = (arr) => arr.map((_, i) => { let a = 0, n = 0; for (let k = -8; k <= 8; k++) { const j = i + k; if (j >= 0 && j < arr.length) { a += arr[j]; n++; } } return a / n; });
  const T = smooth([...Array(SW)].map((_, x) => (lum(x, 0) + lum(x, 1) + lum(x, 2)) / 3));
  const Bt = smooth([...Array(SW)].map((_, x) => (lum(x, SH - 1) + lum(x, SH - 2) + lum(x, SH - 3)) / 3));
  const Lf = smooth([...Array(SH)].map((_, y) => (lum(0, y) + lum(1, y) + lum(2, y)) / 3));
  const Rt = smooth([...Array(SH)].map((_, y) => (lum(SW - 1, y) + lum(SW - 2, y) + lum(SW - 3, y)) / 3));
  const map = Buffer.alloc(SW * SH);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const u = x / (SW - 1), v = y / (SH - 1);
    const val = (1 - v) * T[x] + v * Bt[x] + (1 - u) * Lf[y] + u * Rt[y]
      - ((1 - u) * (1 - v) * T[0] + u * (1 - v) * T[SW - 1] + (1 - u) * v * Bt[0] + u * v * Bt[SW - 1]);
    map[y * SW + x] = Math.max(150, Math.min(255, Math.round(val)));
  }
  const mapF = await sharp(map, { raw: { width: SW, height: SH, channels: 1 } }).resize(W, H, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
  for (let p = 0; p < W * H; p++) {
    if ((p & 0xFFFFF) === 0) await new Promise((r) => setImmediate(r));
    const B = mapF[p], lo = B - 30, i = p * 3, y = Math.max(data[i], data[i + 1], data[i + 2]);
    if (y <= lo) continue;
    const sat = y - Math.min(data[i], data[i + 1], data[i + 2]);
    const neutral = Math.max(0, Math.min(1, (16 - sat) / 8));
    if (neutral <= 0) continue;
    let k = Math.min(1, (y - lo) / (B - lo)); k = k * k * (3 - 2 * k) * neutral;
    data[i] = Math.round(data[i] + (t[0] - data[i]) * k); data[i + 1] = Math.round(data[i + 1] + (t[1] - data[i + 1]) * k); data[i + 2] = Math.round(data[i + 2] + (t[2] - data[i + 2]) * k);
  }
  return sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function borderMatches(buf, t) {
  const { data, info } = await sharp(buf).removeAlpha().resize(200, null).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height; let bad = 0, n = 0;
  const chk = (x, y) => { const i = (y * W + x) * 3; n++; if (Math.max(Math.abs(data[i] - t[0]), Math.abs(data[i + 1] - t[1]), Math.abs(data[i + 2] - t[2])) > 6) bad++; };
  for (let x = 0; x < W; x += 2) { chk(x, 0); chk(x, H - 1); }
  for (let y = 0; y < H; y += 2) { chk(0, y); chk(W - 1, y); }
  return bad / n < 0.03;
}

function parseColourText(txt) {
  const t = String(txt || '').trim().toLowerCase();
  let m = t.match(/#?([0-9a-f]{6})\b/); if (m) return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16));
  m = t.match(/#([0-9a-f]{3})\b/); if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = t.match(/(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/); if (m) return [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)));
  const NAMES = [['off white', [248, 247, 244]], ['off-white', [248, 247, 244]], ['light grey', [240, 240, 240]], ['light gray', [240, 240, 240]], ['white', [255, 255, 255]], ['ivory', [255, 252, 240]], ['cream', [250, 246, 236]], ['beige', [240, 232, 218]], ['grey', [200, 200, 200]], ['gray', [200, 200, 200]], ['black', [12, 12, 12]], ['pink', [248, 226, 230]], ['blue', [220, 232, 245]]];
  for (const [k, v] of NAMES) if (t.includes(k)) return v;
  return null;
}

async function refBackdropColor(b64) {
  const { data, info } = await sharp(Buffer.from(b64, 'base64')).removeAlpha().resize(200, null).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, rs = [], gs = [], bs = [];
  const take = (x, y) => { const i = (y * W + x) * 3; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); };
  for (let x = 0; x < W; x += 2) { take(x, 0); take(x, 1); take(x, H - 1); take(x, H - 2); }
  for (let y = 0; y < H; y += 2) { take(0, y); take(1, y); take(W - 1, y); take(W - 2, y); }
  const med = (a) => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  return [med(rs), med(gs), med(bs)];
}

async function whitenBackground(buf, target) {
  const TT = Array.isArray(target) ? target : [target || 255, target || 255, target || 255];
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  const full = await sharp(buf).removeAlpha().raw().toBuffer();
  const SW = Math.min(1200, W), SH = Math.max(1, Math.round(H * SW / W));
  const sm = await sharp(buf).removeAlpha().resize(SW, SH, { fit: 'fill' }).blur(0.8).raw().toBuffer();
  const N = SW * SH;
  const lum = new Uint8Array(N), cand = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const r = sm[p * 3], g = sm[p * 3 + 1], b = sm[p * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    lum[p] = mx;
    cand[p] = (mx - mn <= 20 && mx >= 90) ? 1 : 0;
  }
  const mask = new Uint8Array(N), q = new Int32Array(N); let qh = 0, qt = 0;
  const push = (p) => { if (cand[p] && !mask[p]) { mask[p] = 1; q[qt++] = p; } };
  for (let x = 0; x < SW; x++) { push(x); push(x + (SH - 1) * SW); }
  for (let y = 0; y < SH; y++) { push(y * SW); push(y * SW + SW - 1); }
  while (qh < qt) { const p = q[qh++], x = p % SW, y = (p - x) / SW; if (x > 0) push(p - 1); if (x < SW - 1) push(p + 1); if (y > 0) push(p - SW); if (y < SH - 1) push(p + SW); }
  const lab = new Int32Array(N); let nl = 0; const sizes = [0];
  for (let s0 = 0; s0 < N; s0++) {
    if (mask[s0] || lab[s0]) continue;
    nl++; let h = 0, t = 0; q[t++] = s0; lab[s0] = nl;
    while (h < t) { const p = q[h++], x = p % SW, y = (p - x) / SW;
      const nb = [x > 0 ? p - 1 : -1, x < SW - 1 ? p + 1 : -1, y > 0 ? p - SW : -1, y < SH - 1 ? p + SW : -1];
      for (const n of nb) if (n >= 0 && !mask[n] && !lab[n]) { lab[n] = nl; q[t++] = n; } }
    sizes.push(t);
  }
  const minKeep = N * 0.004;
  for (let p = 0; p < N; p++) if (!mask[p] && sizes[lab[p]] < minKeep) mask[p] = 1;
  const R = Math.max(8, Math.round(SW / 10));
  async function nblur(val, wgt, rad) {
    const vb = await sharp(val, { raw: { width: SW, height: SH, channels: 1 } }).blur(rad).extractChannel(0).raw().toBuffer();
    const wb = await sharp(wgt, { raw: { width: SW, height: SH, channels: 1 } }).blur(rad).extractChannel(0).raw().toBuffer();
    const out = new Float32Array(N); for (let p = 0; p < N; p++) out[p] = wb[p] > 6 ? vb[p] / wb[p] : -1; return out;
  }
  let v = Buffer.alloc(N), w = Buffer.alloc(N);
  for (let p = 0; p < N; p++) if (mask[p]) { v[p] = lum[p]; w[p] = 255; }
  const L0 = await nblur(v, w, R);
  v = Buffer.alloc(N); w = Buffer.alloc(N);
  for (let p = 0; p < N; p++) if (mask[p] && L0[p] > 0 && lum[p] >= L0[p] * 255 - 14) { v[p] = lum[p]; w[p] = 255; }
  const Lr = await nblur(v, w, R);
  const L = new Float32Array(N);
  let med = 230; { const b = []; for (let x = 0; x < SW; x += 3) b.push(lum[x], lum[x + (SH - 1) * SW]); b.sort((a, c) => a - c); med = b[b.length >> 1] || 230; }
  for (let p = 0; p < N; p++) L[p] = Lr[p] > 0 ? Math.max(80, Lr[p] * 255) : med;
  const sv = Buffer.alloc(N), sw = Buffer.alloc(N);
  for (let p = 0; p < N; p++) if (mask[p]) { const s = Math.max(0, Math.min(1, 1 - lum[p] / L[p])); sv[p] = Math.round(s * 255); sw[p] = 255; }
  const SR = Math.max(3, Math.round(SW / 160));
  const shS = await nblur(sv, sw, SR);
  const shB = Buffer.alloc(N); for (let p = 0; p < N; p++) { let s = shS[p] > 0 ? shS[p] : 0; s = s < 0.035 ? 0 : (s - 0.035) / 0.965; shB[p] = Math.round(Math.min(1, s) * 255); }
  const m8 = Buffer.alloc(N); for (let p = 0; p < N; p++) m8[p] = mask[p] ? 255 : 0;
  const mEr = await sharp(m8, { raw: { width: SW, height: SH, channels: 1 } }).blur(1.2).threshold(210).extractChannel(0).raw().toBuffer();
  for (let p = 0; p < N; p++) { const x = p % SW, y = (p - x) / SW; if (m8[p] && (x < 4 || y < 4 || x >= SW - 4 || y >= SH - 4)) mEr[p] = 255; }
  const mF = await sharp(mEr, { raw: { width: SW, height: SH, channels: 1 } }).resize(W, H, { fit: 'fill' }).blur(Math.max(1.5, W / 1400)).extractChannel(0).raw().toBuffer();
  const sF = await sharp(shB, { raw: { width: SW, height: SH, channels: 1 } }).resize(W, H, { fit: 'fill' }).blur(Math.max(1, W / 2000)).extractChannel(0).raw().toBuffer();
  let changed = 0;
  for (let p = 0; p < W * H; p++) {
    if ((p & 0xFFFFF) === 0) await new Promise((r) => setImmediate(r));
    const m = mF[p] / 255; if (m <= 0.004) continue;
    const f = 1 - sF[p] / 255, i = p * 3;
    const nr = TT[0] * f, ng = TT[1] * f, nb = TT[2] * f;
    full[i] = Math.round(full[i] + (nr - full[i]) * m); full[i + 1] = Math.round(full[i + 1] + (ng - full[i + 1]) * m); full[i + 2] = Math.round(full[i + 2] + (nb - full[i + 2]) * m);
    changed++;
  }
  console.log('  background replaced: ' + Math.round(changed * 100 / (W * H)) + '% of the frame set to rgb(' + TT.join(',') + ') (smooth shadow kept)');
  return sharp(full, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

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

// ---- Colour lock: correct global colour drift of the generated product back to the source photo (pixel math, no AI) ----
async function colorLockBuffer(outBuf, srcBase64) {
  if (!sharp) return outBuf;
  const S = 640;
  async function fgStats(buf) {
    const meta = await sharp(buf).metadata();
    const H = Math.max(1, Math.round(meta.height * S / meta.width));
    const { data } = await sharp(buf).removeAlpha().resize(S, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const N = S * H;
    let br = 0, bgc = 0, bb = 0, c = 0;
    for (let x = 0; x < S; x += 6) { for (const p of [x, x + (H - 1) * S]) { br += data[p * 3]; bgc += data[p * 3 + 1]; bb += data[p * 3 + 2]; c++; } }
    br /= c; bgc /= c; bb /= c;
    const m = [0, 0, 0], m2 = [0, 0, 0]; let k = 0;
    const mask = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      const r = data[p * 3], g = data[p * 3 + 1], b = data[p * 3 + 2];
      if (Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb) > 90) { mask[p] = 1; k++; m[0] += r; m[1] += g; m[2] += b; m2[0] += r * r; m2[1] += g * g; m2[2] += b * b; }
    }
    if (k < N * 0.005) return null;
    const mean = m.map((v) => v / k);
    const sd = m2.map((v, i) => Math.sqrt(Math.max(1, v / k - mean[i] * mean[i])));
    return { mean, sd };
  }
  try {
    const src = await fgStats(Buffer.from(srcBase64, 'base64'));
    const out = await fgStats(outBuf);
    if (!src || !out) return outBuf;
    // limit correction strength so we never overshoot
    const gain = out.sd.map((v, i) => Math.max(0.7, Math.min(1.4, src.sd[i] / v)));
    const meta = await sharp(outBuf).metadata();
    const { data, info } = await sharp(outBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    // recompute bg colour of the OUTPUT at full res for masking
    let br = 0, bgc = 0, bb = 0, c = 0;
    for (let x = 0; x < W; x += 24) { for (const p of [x, x + (H - 1) * W]) { br += data[p * 3]; bgc += data[p * 3 + 1]; bb += data[p * 3 + 2]; c++; } }
    br /= c; bgc /= c; bb /= c;
    for (let p = 0; p < W * H; p++) {
      const i = p * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const d = Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb);
      if (d <= 60) continue; // background / shadow zone untouched
      const w = Math.min(1, (d - 60) / 60); // feather at the product edge
      const nr = (r - out.mean[0]) * gain[0] + src.mean[0];
      const ng = (g - out.mean[1]) * gain[1] + src.mean[1];
      const nb = (b - out.mean[2]) * gain[2] + src.mean[2];
      data[i] = Math.max(0, Math.min(255, Math.round(r + (nr - r) * w)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g + (ng - g) * w)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b + (nb - b) * w)));
    }
    return sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  } catch (e) { return outBuf; }
}

// ---- Protect rest: outside the changed part, restore the ORIGINAL photo's pixels exactly (no AI) ----
async function protectRest(outBuf, srcBase64, opts = {}) {
  const TH = opts.threshold || 26;
  if (!sharp) return { buf: outBuf, protectedPct: 0 };
  const srcBuf = Buffer.from(srcBase64, 'base64');
  const sMeta = await sharp(srcBuf).metadata();
  let out = sharp(outBuf);
  const oMeta = await out.metadata();
  if (oMeta.width !== sMeta.width || oMeta.height !== sMeta.height) out = out.resize(sMeta.width, sMeta.height, { fit: 'fill' });
  const outFull = await out.removeAlpha().raw().toBuffer();
  const srcFull = await sharp(srcBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = sMeta.width, H = sMeta.height;
  if (srcFull.data.length !== outFull.length) return { buf: outBuf, protectedPct: 0 };
  // change mask at reduced scale, blurred for smooth feathering
  const S = 600, Hs = Math.max(1, Math.round(H * S / W));
  const dSrc = await sharp(srcBuf).removeAlpha().resize(S, Hs, { fit: 'fill' }).raw().toBuffer();
  const dOut = await sharp(outBuf).removeAlpha().resize(S, Hs, { fit: 'fill' }).raw().toBuffer();
  const diff = Buffer.alloc(S * Hs);
  for (let p = 0; p < S * Hs; p++) {
    const i = p * 3;
    const d = Math.abs(dSrc[i] - dOut[i]) + Math.abs(dSrc[i + 1] - dOut[i + 1]) + Math.abs(dSrc[i + 2] - dOut[i + 2]);
    diff[p] = d > TH ? 255 : 0;
  }
  // smooth the mask (fills pinholes, feathers edges), then expand it slightly so part edges are not clipped
  const maskR = await sharp(diff, { raw: { width: S, height: Hs, channels: 1 } }).blur(2).threshold(12).blur(5)
    .resize(W, H, { fit: 'fill' }).blur(Math.max(2, Math.round(W / 700))).raw().toBuffer({ resolveWithObject: true });
  const MC = maskR.info.channels; const mask = maskR.data;
  let changed = 0;
  for (let p = 0; p < W * H; p++) {
    if ((p & 0xFFFFF) === 0) await new Promise((r) => setImmediate(r));
    const m = mask[p * MC] / 255;
    if (m >= 0.995) { changed++; continue; }
    const i = p * 3;
    if (m <= 0.005) { outFull[i] = srcFull.data[i]; outFull[i + 1] = srcFull.data[i + 1]; outFull[i + 2] = srcFull.data[i + 2]; }
    else {
      outFull[i] = Math.round(srcFull.data[i] * (1 - m) + outFull[i] * m);
      outFull[i + 1] = Math.round(srcFull.data[i + 1] * (1 - m) + outFull[i + 1] * m);
      outFull[i + 2] = Math.round(srcFull.data[i + 2] * (1 - m) + outFull[i + 2] * m);
      changed++;
    }
  }
  const buf = await sharp(outFull, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { buf, protectedPct: Math.round((1 - changed / (W * H)) * 1000) / 10 };
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
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, maxBodyLength: Infinity, timeout: 600000,
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
    capReferenceStore(referenceStore);
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
      productType = 'shoes', prodFit = 'product', prodFitLabel = '',
      neckLabel = 'keep', hemLabel = 'keep',
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
    const APPAREL_TYPES = { top: 'a top / shirt', bottoms: 'bottoms (trousers, jeans or a skirt)', dress: 'a dress', bag: 'a bag' };
    if (APPAREL_TYPES[String(productType)]) {
      lines.push('IMPORTANT — PRODUCT TYPE: my product is NOT a shoe; it is ' + APPAREL_TYPES[String(productType)] + '. Wherever these instructions say "shoe" or "sole", they mean my product. Photograph it the professional e-commerce way for this product type (flat lay or ghost-mannequin presentation as appropriate), with the soft contact shadow under the product.');
      const PRES = {
        product: '',
        notrelaxed: 'PRESENTATION: present the garment NOT TOO RELAXED — a clean regular shape with minimal ease.',
        slight: 'PRESENTATION: present the garment SLIGHTLY RELAXED — a little soft ease and gentle natural drape.',
        relaxed: 'PRESENTATION: present the garment RELAXED — soft natural volume and drape, not pressed flat or slim.',
        toorelaxed: 'PRESENTATION: present the garment VERY RELAXED / OVERSIZED — generous volume and heavy soft drape.',
        slim: 'PRESENTATION: present the garment SLIM — a neat, trim silhouette.',
        fitted: 'PRESENTATION: present the garment BODY-FITTED in shape — a close, contoured silhouette.',
        other: prodFitLabel ? 'PRESENTATION: ' + prodFitLabel : '',
      };
      const pres = PRES[String(prodFit)] !== undefined ? PRES[String(prodFit)] : '';
      if (pres && String(productType) !== 'bag') lines.push(pres);
      if (String(neckLabel) === 'none') lines.push('LABELS: this garment has NO brand neck label — do not add one.');
      else if (String(neckLabel) === 'remove') lines.push('LABELS: REMOVE the brand neck label completely, leaving clean fabric where it was.');
      if (String(hemLabel) === 'none') lines.push('It has NO hem or side tag — do NOT add one anywhere.');
      else if (String(hemLabel) === 'remove') lines.push('REMOVE the hem/side tag completely — clean seam, no mark left.');
      lines.push('NEVER add or invent any label, tag, patch or logo the product does not clearly have in the product images.');
    }
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
      generatedStore.set(id, { ...cleaned, createdAt: Date.now(), label: ((typeof req !== 'undefined' && req.body && req.body.outName) ? String(req.body.outName).replace(/[^\w\-. ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) + '-take' + (typeof variant !== 'undefined' ? variant : 1) : undefined) }); if (typeof capGeneratedStore === 'function') capGeneratedStore();
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
      generatedStore.set(id, { ...cleaned, createdAt: Date.now(), label: ((typeof req !== 'undefined' && req.body && req.body.outName) ? String(req.body.outName).replace(/[^\w\-. ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) + '-take' + (typeof variant !== 'undefined' ? variant : 1) : undefined) }); if (typeof capGeneratedStore === 'function') capGeneratedStore();
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
// Async jobs: the browser gets a job id instantly and polls for the result,
// so no HTTP request ever outlives the hosting proxy's 5-minute limit.
const jobsStore = new Map();
setInterval(() => { for (const [id, j] of jobsStore) if (j.createdAt < Date.now() - 30 * 60e3) jobsStore.delete(id); }, 60e3);
// Memory caps: keep stores bounded when many people use the site at once
const MAX_STORED_IMAGES = Number(process.env.MAX_STORED_IMAGES || 120);
function capGeneratedStore() {
  while (generatedStore.size > MAX_STORED_IMAGES) {
    let oldestId = null, oldest = Infinity;
    for (const [id, g] of generatedStore) { const t = g.createdAt || 0; if (t < oldest) { oldest = t; oldestId = id; } }
    if (!oldestId) break;
    generatedStore.delete(oldestId);
  }
}
const MAX_STORED_UPLOADS = Number(process.env.MAX_STORED_UPLOADS || 30);
function capReferenceStore(store) {
  while (store.size > MAX_STORED_UPLOADS) {
    let oldestId = null, oldest = Infinity;
    for (const [id, e] of store) { const t = e.createdAt || 0; if (t < oldest) { oldest = t; oldestId = id; } }
    if (!oldestId) break;
    store.delete(oldestId);
  }
}

let AdmZip = null; try { AdmZip = require('adm-zip'); } catch (e) { AdmZip = null; }
const multerLib = require('multer');
const sheetUpload = multerLib({ storage: multerLib.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

function parseSheetWorkbook(buf) {
  const zip = new AdmZip(buf);
  const read = (p) => { const e = zip.getEntry(p); return e ? zip.readAsText(e) : null; };
  const readBin = (p) => { const e = zip.getEntry(p); return e ? e.getData() : null; };
  const colLetters = (ref) => { const m = ref.match(/^([A-Z]+)(\d+)$/); if (!m) return null; let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { col: c - 1, row: Number(m[2]) - 1 }; };
  const ssXml = read('xl/sharedStrings.xml') || '';
  const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('').replace(/&amp;/g, '&'));
  const wb = read('xl/workbook.xml') || '';
  const wbRels = read('xl/_rels/workbook.xml.rels') || '';
  const relMap = {}; [...wbRels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].forEach((m) => { relMap[m[1]] = m[2].replace(/^\//, ''); });
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: m[1], path: 'xl/' + String(relMap[m[2]] || '').replace(/^xl\//, '') }));
  const pics = [];
  for (const sh of sheets) {
    const sx = read(sh.path); if (!sx) continue;
    const cells = {};
    [...sx.matchAll(/<c ([^>]*)>([\s\S]*?)<\/c>/g)].forEach((m) => {
      const rAttr = m[1].match(/r="([A-Z]+\d+)"/); if (!rAttr) return;
      const tAttr = m[1].match(/t="(\w+)"/);
      const pos = colLetters(rAttr[1]); if (!pos) return;
      const type = tAttr ? tAttr[1] : '';
      let txt = null;
      if (type === 's') { const v = m[2].match(/<v>(\d+)<\/v>/); if (v) txt = shared[Number(v[1])]; }
      else if (type === 'inlineStr' || type === 'str') { const t = m[2].match(/<t[^>]*>([\s\S]*?)<\/t>/) || m[2].match(/<v>([\s\S]*?)<\/v>/); if (t) txt = t[1]; }
      else { const v = m[2].match(/<v>([\s\S]*?)<\/v>/); if (v) txt = v[1]; }
      if (txt != null && String(txt).trim()) cells[pos.row + ':' + pos.col] = String(txt).trim();
    });
    const base = sh.path.split('/').pop();
    const srel = read('xl/worksheets/_rels/' + base + '.rels') || '';
    const dm = srel.match(/Target="([^"]*drawing[^"]*)"/); if (!dm) continue;
    const dpath = 'xl/' + dm[1].replace(/\.\.\//g, '');
    const dx = read(dpath) || '';
    const drel = read(dpath.replace(/drawings\//, 'drawings/_rels/') + '.rels') || '';
    const dRelMap = {}; [...drel.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].forEach((m) => { dRelMap[m[1]] = 'xl/' + m[2].replace(/\.\.\//g, ''); });
    const anchors = [...dx.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)[^>]*>([\s\S]*?)<\/xdr:\1>/g)];
    for (const a of anchors) {
      const body = a[2];
      const from = body.match(/<xdr:from>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      const to = body.match(/<xdr:to>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      const blip = body.match(/r:embed="([^"]+)"/);
      if (!from || !blip || !dRelMap[blip[1]]) continue;
      const fc = Number(from[1]), fr = Number(from[2]);
      const tc = to ? Number(to[1]) : fc + 3, tr = to ? Number(to[2]) : fr + 10;
      const texts = [];
      for (let r = Math.max(0, fr - 1); r <= tr + 5; r++) for (let c = Math.max(0, fc - 2); c <= tc + 4; c++) { const t = cells[r + ':' + c]; if (t) texts.push({ r, c, t }); }
      texts.sort((x, y) => x.r - y.r || x.c - y.c);
      const labels = []; for (const t of texts) if (!/^[\d.,]+$/.test(t.t) && !labels.includes(t.t)) labels.push(t.t);
      pics.push({ sheet: sh.name, media: dRelMap[blip[1]], data: readBin(dRelMap[blip[1]]), style: labels[0] || '', colors: labels.slice(1, 7) });
    }
  }
  return pics.filter((p) => p.data && p.data.length > 2000);
}

app.post('/api/sheet', sheetUpload.single('sheet'), async (req, res) => {
  try {
    if (!AdmZip) return res.status(400).json({ error: 'Sheet reading needs one extra package. In the project folder run: npm install adm-zip  — then restart / push.' });
    if (!req.file) return res.status(400).json({ error: 'Upload an .xlsx file.' });
    const pics = parseSheetWorkbook(req.file.buffer);
    if (!pics.length) return res.status(400).json({ error: 'No embedded images found in that file.' });
    const bases = []; const items = [];
    for (let i = 0; i < pics.length; i++) {
      const p = pics[i];
      try {
        const big = await sharp(p.data).rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
        const meta = await sharp(big).metadata();
        const thumb = await sharp(p.data).rotate().resize({ width: 170 }).jpeg({ quality: 70 }).toBuffer();
        bases.push({ base64: big.toString('base64'), mime: 'image/jpeg', width: meta.width, height: meta.height, name: 'sheet-' + (i + 1) + '.jpg' });
        items.push({ index: bases.length - 1, sheet: p.sheet, thumb: 'data:image/jpeg;base64,' + thumb.toString('base64'), style: p.style, colors: p.colors });
      } catch (e) { /* skip unreadable image */ }
    }
    if (!items.length) return res.status(400).json({ error: 'Could not read any image from the file.' });
    const referenceId = crypto.randomUUID();
    capReferenceStore(referenceStore);
    referenceStore.set(referenceId, { createdAt: Date.now(), product: [], bases, logo: null, bg: null, labels: [] });
    console.log('[sheet] parsed ' + items.length + ' images from ' + (req.file.originalname || 'workbook'));
    res.json({ referenceId, items });
  } catch (err) {
    res.status(400).json({ error: 'Could not read the sheet: ' + err.message });
  }
});

// ===== Cut-out backdrop (Background tab): exact product, pure backdrop, soft contact shadow — no AI redraw =====
let __cutChain = Promise.resolve();
function __cutLock(fn) { const p = __cutChain.then(fn, fn); __cutChain = p.catch(() => {}); return p; }
async function composeOnBackdrop(cutPng, T, strength) {
  const { data, info } = await sharp(cutPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const yb = new Float32Array(W).fill(-1);
  for (let x = 0; x < W; x++) for (let y = H - 1; y >= 0; y--) if (data[(y * W + x) * 4 + 3] > 128) { yb[x] = y; break; }
  const ys = new Float32Array(W); const R = Math.max(2, Math.round(W / 200));
  for (let x = 0; x < W; x++) { let a = 0, n = 0; for (let k = -R; k <= R; k++) { const j = x + k; if (j >= 0 && j < W && yb[j] >= 0) { a += yb[j]; n++; } } ys[x] = n ? a / n : -1; }
  const d = Math.max(3, H / 140);
  const sh = Buffer.alloc(W * H);
  for (let x = 0; x < W; x++) { if (ys[x] < 0) continue; for (let y = Math.max(0, Math.floor(ys[x] - d)); y < H; y++) { const dy = y - ys[x]; const v = dy < 0 ? Math.exp(dy / (d * 0.5)) : Math.exp(-dy / d); if (v < 0.01) break; sh[y * W + x] = Math.round(v * 255); } }
  const shB = await sharp(sh, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(1.5, W / 250)).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    if ((p & 0xFFFFF) === 0) await new Promise((r) => setImmediate(r));
    const s = (shB[p] / 255) * strength, a = data[p * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) { const bg = T[c] * (1 - s); out[p * 3 + c] = Math.round(data[p * 4 + c] * a + bg * (1 - a)); }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
async function padToRatioColour(buf, ratio, T) {
  const m = String(ratio || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/); if (!m) return buf;
  const r = Number(m[1]) / Number(m[2]); const meta = await sharp(buf).metadata();
  let W = meta.width, H = meta.height;
  if (Math.abs(W / H - r) < 0.003) return buf;
  let nw = W, nh = H; if (W / H > r) nh = Math.round(W / r); else nw = Math.round(H * r);
  const left = Math.floor((nw - W) / 2), top = Math.floor((nh - H) / 2);
  return sharp(buf).extend({ left, right: nw - W - left, top, bottom: nh - H - top, background: { r: T[0], g: T[1], b: T[2] } }).png().toBuffer();
}
app.post('/api/cutout', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'ref', maxCount: 1 }]), async (req, res) => {
  const b = req.body || {};
  try {
    const img = req.files && req.files.image && req.files.image[0];
    if (!img) return res.status(200).json({ status: 'FAILED', error: 'No image received.' });
    let RB; try { RB = require('@imgly/background-removal-node'); } catch (e) { return res.status(200).json({ status: 'FAILED', error: 'Background remover is not installed. In the angle-studio folder run: npm install @imgly/background-removal-node — then commit and push.' }); }
    const bc = String(b.bgChoice || 'white').toLowerCase();
    let T = bc === 'white' ? [255, 255, 255] : /grey|gray|f8/.test(bc) ? [248, 248, 248] : null;
    const ref = req.files && req.files.ref && req.files.ref[0];
    if (!T && /ref/.test(bc) && ref && typeof refBackdropColor === 'function') T = await refBackdropColor(ref.buffer.toString('base64'));
    if (!T && String(b.bgCustom || '').trim() && typeof parseColourText === 'function') T = parseColourText(b.bgCustom);
    if (!T) T = [255, 255, 255];
    const t0 = Date.now();
    const out = await __cutLock(async () => {
      const input = await sharp(img.buffer).rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const blob = new Blob([input], { type: 'image/png' });
      const cutBlob = await RB.removeBackground(blob, { model: 'medium', output: { format: 'image/png' } });
      const cut = Buffer.from(await cutBlob.arrayBuffer());
      let o = await composeOnBackdrop(cut, T, 0.42);
      o = await padToRatioColour(o, b.aspectRatio, T);
      const LS = { '1k': 1024, '2k': 2048, '4k': 4096 }[String(b.resolution || '').toLowerCase()];
      if (LS) o = await sharp(o).resize({ width: LS, height: LS, fit: 'inside' }).png().toBuffer();
      return o;
    });
    const cleaned = await passthrough(out, 'image/png');
    const id = crypto.randomUUID();
    generatedStore.set(id, { ...cleaned, createdAt: Date.now(), label: 'background-photo' + (Number(b.baseIndex || 0) + 1) + '-cutout' });
    if (typeof capGeneratedStore === 'function') capGeneratedStore();
    console.log('  [cutout] photo ' + (Number(b.baseIndex || 0) + 1) + ' on rgb(' + T.join(',') + ') in ' + (Date.now() - t0) + 'ms — exact product, no AI redraw');
    res.json({ status: 'COMPLETED', imageUrl: '/api/image/' + id + '.png', width: cleaned.width, height: cleaned.height, variant: b.variant, baseIndex: b.baseIndex });
  } catch (err) {
    console.warn('  [cutout] failed: ' + err.message);
    res.status(200).json({ status: 'FAILED', error: 'Cut-out failed: ' + err.message });
  }
});

app.get('/api/recent', (req, res) => {
  const items = [];
  for (const [id, g] of generatedStore) items.push({ id, createdAt: g.createdAt, width: g.width || 0, height: g.height || 0, label: g.label || '' });
  items.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ images: items.slice(0, 120) });
});

app.get('/api/job/:id', (req, res) => {
  const j = jobsStore.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found (expired?)' });
  if (!j.done) return res.json({ done: false });
  res.json({ done: true, result: j.payload });
});

app.post('/api/edit', async (req, res) => {
  let slotHeld = false;
  try {
    const {
      referenceId, baseIndex, mode = 'swap', category = 'shoes', categoryLabel = '',
      prompt = '', variant = 1, resolution = '2k', logoColor = 'white', aspectRatio = 'auto', // PATCH34
      brandText = '', labelOverlay = 'on', logoMode = 'replace',
      part = 'buckle', partLabel = '', color = 'gold', colorLabel = '',
      mPart = 'bow', mPartLabel = '', material = 'leather', materialLabel = '', mColor = 'keep', mColorLabel = '',
      neckLabel = 'keep', hemLabel = 'keep',
      otherColor = 'keep', otherColorLabel = '',
      topStyle = 'product', topStyleLabel = '', swapNotes = '',
      sheetColor = '',
      fxShoes = 'keep', fxShoesText = '', fxBottoms = 'keep', fxBottomsText = '', fxTop = 'keep', fxTopText = '',
      fxBelt = 'keep', fxBeltText = '', fxNecklace = 'keep', fxNecklaceText = '', fxBag = 'keep', fxBagText = '',
      fxCrop = 'none', fxMain = 'none', fxNeck = 'keep', fxHem = 'keep', fxLogos = 'keep', fxMainRef = '0',
      fit = 'product', fitLabel = '', bottomsStyle = 'product', bottomsLabel = '', logosOpt = 'keep',
      bgChoice = 'white', bgCustom = '', shadowSrc = 'auto',
      copyAngle = 'on', copyShape = 'on', copyShadow = 'on', copyBg = 'on', colorLock = 'on',
      poseType = 'auto', poseFit = 'product', poseFitLabel = '',
      provider = 'google', model = 'gemini-3-pro-image-preview', googleApiKey = '',
    } = req.body || {};
    const entry = referenceStore.get(referenceId);
    if (!entry) return res.status(400).json({ error: 'Photos expired or not found — re-upload and try again.' });
    // APPAREL_EDIT_V2: in apparel mode each PRODUCT photo is the base image being edited (shape + labels preserved)
    const isApparel = mode === 'apparel';
    const base = isApparel ? (entry.product && entry.product[Number(baseIndex)]) : (entry.bases && entry.bases[Number(baseIndex)]);
    // Background tab / Recreate: give Gemini a photo whose backdrop is already the target colour
    if (mode === 'bg' && base && base.base64) {
      if (String((req.body || {}).bgMethod || 'recreate') === 'recreate') {
        try {
          const __bc = (typeof bgChoice !== 'undefined' ? String(bgChoice) : '').toLowerCase();
          let __t = __bc === 'white' ? [255, 255, 255] : /grey|gray|f8/.test(__bc) ? [248, 248, 248] : null;
          if (!__t && /ref/.test(__bc) && entry.bg && entry.bg.base64) __t = await refBackdropColor(entry.bg.base64);
          if (!__t && typeof bgCustom !== 'undefined' && String(bgCustom).trim()) __t = parseColourText(bgCustom);
          if (!__t) __t = [255, 255, 255];
          if (!base._orig) base._orig = { b64: base.base64, mime: base.mime };
          const __w = await whitenBackground(Buffer.from(base._orig.b64, 'base64'), __t);
          base.base64 = __w.toString('base64'); base.mime = 'image/png';
          console.log('  recreate: input pre-cleaned to rgb(' + __t.join(',') + ') before sending to Gemini');
        } catch (e) { console.warn('  recreate pre-clean failed: ' + e.message); }
      } else if (base._orig) { base.base64 = base._orig.b64; base.mime = base._orig.mime; }
    }
    if (!base) return res.status(400).json({ error: 'No ' + (isApparel ? 'product' : 'sample') + ' photo at index ' + baseIndex });
    const styleRef = isApparel ? (entry.bases && entry.bases[0]) : null;
    if (mode !== 'logo' && mode !== 'recolor' && mode !== 'bg' && mode !== 'pose' && mode !== 'material' && mode !== 'sheetangle' && mode !== 'modelfix' && mode !== 'free' && !entry.product.length) return res.status(400).json({ error: 'Upload product photos too.' });

    // async mode: acknowledge now, deliver via /api/job/:id
    let jobId = null;
    const isAsync = String((req.body || {}).async || '') === '1';
    const finish = (payload) => {
      if (isAsync && jobId) { jobsStore.set(jobId, { done: true, payload, createdAt: Date.now() }); }
      else if (!res.headersSent) res.json(payload);
    };
    req._finishJob = finish;
    if (isAsync) { jobId = crypto.randomUUID(); jobsStore.set(jobId, { done: false, createdAt: Date.now() }); res.json({ jobId }); }

    await acquireSlot(); slotHeld = true;
    const P = entry.product.length;
    const catNames = { shoes: 'shoes/footwear', top: 'top (shirt/blouse/jacket)', bottoms: 'bottoms (trousers/skirt)', dress: 'dress', bag: 'bag', other: categoryLabel || 'item' };
    const cat = catNames[category] || catNames.shoes;

    let instruction;
    if (mode === 'modelfix') {
      const ITEMS = [
        ['SHOES', 'the shoes the model wears', fxShoes, fxShoesText],
        ['BOTTOMS', 'the bottoms the model wears (pants / jeans / shorts / skirt)', fxBottoms, fxBottomsText],
        ['TOP', 'the top the model wears', fxTop, fxTopText],
        ['BELT', 'the belt', fxBelt, fxBeltText],
        ['NECKLACE', 'the necklace / jewellery', fxNecklace, fxNecklaceText],
        ['BAG', 'the bag', fxBag, fxBagText],
      ];
      const MAIN_TAG = ({ top: 'TOP', bottoms: 'BOTTOMS', shoes: 'SHOES', bag: 'BAG' })[String(fxMain)] || null;
      if (MAIN_TAG) for (const it of ITEMS) if (it[0] === MAIN_TAG) { it[2] = 'keep'; it[3] = ''; }
      const hasRefBoard = (ITEMS.some((it) => String(it[2]) === 'ref') || String(fxMainRef) === '1') && entry.bg;
      const itemLines = [];
      for (const [tag, phrase, opt, txt] of ITEMS) {
        const o = String(opt);
        if (o === 'remove') itemLines.push('REMOVE ' + phrase + ' completely — the model is simply not wearing it; reconstruct what it covered naturally (skin, garment, background), leaving no trace or mark.');
        else if (o === 'ref') itemLines.push('REPLACE ' + phrase + ' with the product shown in the reference board section labelled "' + tag + '": reproduce that product EXACTLY — same design, same colour, same material, texture, hardware and details — fitted naturally to the model in the same pose.' + (String(txt).trim() ? ' Details: ' + String(txt).trim() + '.' : ''));
        else if (o === 'text' && String(txt).trim()) itemLines.push('REPLACE ' + phrase + ' with: ' + String(txt).trim() + '. Render it realistically and fitted naturally to the model in the same pose.');
      }
      instruction = [
        'Edit image 1, a lifestyle model photo of my product. This is a professional retouching job, NOT a re-creation.',
        'KEEP EVERYTHING ELSE IDENTICAL: the same model, same face and hair (unless a change below says otherwise), same pose, same body position, same camera angle and framing, same lighting, same background, and every garment and accessory not mentioned below stays exactly as photographed, in its exact colour.',
        MAIN_TAG ? 'THE MAIN PRODUCT in this photo is ' + ({ TOP: 'the top', BOTTOMS: 'the bottoms (pants / shorts)', SHOES: 'the shoes', BAG: 'the bag' })[MAIN_TAG] + ' — it is the product being SOLD. It is UNTOUCHABLE: keep it pixel-faithful — the exact same design, the exact same colour (same hue, same darkness, same saturation, not lighter, not darker, no tint shift), same fabric, texture, print, fit, length and every detail, exactly as photographed. Changing other items must not affect it in any way.' : '',
        hasRefBoard ? 'A reference board image is included: it contains labelled sections, each showing one product to use. Copy products ONLY from their named sections; copy nothing else from the board (not its background, not its layout).' : '',
        itemLines.join(' '),
        String(fxCrop) === 'chin' ? 'FRAMING: the final image is cropped so the face is NOT visible — the frame starts just below the chin and shows the body down from there. Do not blur or paint over the face; the crop simply excludes it.' : '',
        String(fxNeck) === 'logo' ? 'EXCEPTION to the keep rules above — NECK LABEL: erase the logo / brand text printed on the neck label, leaving a clean plain label in its own colour; the label itself stays.' : String(fxNeck) === 'remove' ? 'EXCEPTION to the keep rules above — NECK LABEL: remove the neck label completely, leaving clean fabric with no mark.' : '',
        String(fxHem) === 'logo' ? 'EXCEPTION to the keep rules above — HEM / SIDE LABEL: erase the logo / brand text on the hem or side tag, leaving a clean plain tag; the tag itself stays.' : String(fxHem) === 'remove' ? 'EXCEPTION to the keep rules above — HEM / SIDE LABEL: remove the hem or side tag completely, leaving a clean seam with no mark.' : '',
        String(fxLogos) === 'remove' ? 'EXCEPTION to the keep rules above — LOGOS: remove every visible logo, brand name, print text or embroidery from all clothing, leaving the plain fabric in its exact colour and texture. Only the logos go; the garments stay identical otherwise.' : '',
        (String(fxMainRef) === '1' && entry.bg) ? 'COLOUR TRUTH FOR THE MAIN PRODUCT: the reference board section labelled "MAIN PRODUCT" shows my real product (' + (MAIN_TAG ? ({ TOP: 'the top', BOTTOMS: 'the bottoms', SHOES: 'the shoes', BAG: 'the bag' })[MAIN_TAG] : 'the item being sold') + '). In the final image that product must match those photos EXACTLY in colour — same hue, same darkness, same saturation, same fabric look. If it looks even slightly different in image 1, correct it to match the MAIN PRODUCT photos. Do not change its design, fit or position.' : '',
        'NEVER add or invent any garment, accessory, label or logo that is not in image 1 or explicitly requested above. Colours stay true to life.',
        'Premium e-commerce quality, sharp focus. Output one photorealistic image only.',
      ].filter(Boolean).join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'sheetangle') {
      const colr = String(sheetColor || '').trim() || 'the shown';
      instruction = [
        'The attached photo shows my footwear product — possibly several colourways together, at a casual angle, on a non-studio background (it may be a supplier or showroom photo).',
        'Create ONE professional e-commerce product photograph of ONLY the ' + colr + ' colourway: a single RIGHT shoe in a true side profile, toe pointing to the RIGHT, standing flat, like a premium Nordstrom catalogue shot.',
        'Reproduce MY shoe exactly — same design, construction, materials, texture and details as in the photo. If the photo does not show the ' + colr + ' colourway, recolour my shoe accurately to ' + colr + ' with a realistic finish for that material.',
        'BACKGROUND: pure seamless WHITE #FFFFFF edge to edge, no props, no other shoes, no surface texture. SHADOW: one soft, tight, natural contact shadow directly under the sole.',
        'The outsole and every surface stay CLEAN: NO logo, NO text, NO embossing on the sole. Premium studio lighting, sharp focus, true-to-life colour. Output one photorealistic image only.',
      ].join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'material') {
      const MPARTS = {
        bow: 'the bow on the toe',
        sole: 'the sole (outsole and midsole edge)',
        strap: 'the strap(s)',
        upper: 'the entire upper / whole shoe body',
        laces: 'the laces',
        heel: 'the heel',
        hardware: 'the buckle and small metal hardware',
        other: mPartLabel || 'the selected part',
      };
      const MATERIALS = {
        keep: null,
        leather: 'smooth genuine leather with a natural fine grain',
        suede: 'soft suede with a matte napped texture',
        patent: 'glossy patent leather with sharp reflective shine',
        satin: 'satin fabric with a soft elegant sheen',
        velvet: 'velvet with a plush light-absorbing pile',
        canvas: 'woven cotton canvas with visible weave',
        knit: 'fine knit / mesh textile',
        rubber: 'matte moulded rubber',
        jelly: 'translucent glossy jelly PVC',
        metallic: 'metallic-finish leather with a soft foil sheen',
        ref: entry.bg ? 'EXACTLY the material shown in the reference image — same material type, same surface texture and grain, same sheen/gloss level, same apparent thickness and construction (e.g. if the reference bow is a thin waxed cord, mine becomes a thin waxed cord; if it is a flat ribbon, mine becomes a flat ribbon)' : null,
        other: materialLabel || null,
      };
      const partText = MPARTS[String(mPart)] || MPARTS.bow;
      const matText = MATERIALS[String(material)] !== undefined ? MATERIALS[String(material)] : MATERIALS.leather;
      const colText = String(mColor) === 'ref' && entry.bg
        ? 'change its colour to EXACTLY the colour shown in the reference image'
        : String(mColor) === 'custom' && mColorLabel
        ? 'change its colour to ' + mColorLabel
        : 'keep its colour EXACTLY as it currently is — same hue, same darkness, same saturation, not lighter, not darker';
      instruction = [
        'Edit sample photo 1. Keep absolutely everything in the photo identical — the product, its shape, all other parts and their materials, the stitching, the background, lighting, shadows and reflections.',
        (entry.bg && (String(material) === 'ref' || String(mColor) === 'ref')) ? 'The reference image is included ONLY for the material texture and/or colour to copy — copy nothing else from it.' : '',
        'Change ONLY ' + partText + ':' + (matText ? ' change its MATERIAL to ' + matText + ', rendered realistically with correct texture, light response and natural transitions where it meets other parts;' : ' keep its material unchanged;') + ' and ' + colText + '.',
        'The part keeps its exact shape, size and position. Every other part of the product stays untouched, with no material or colour bleeding onto neighbouring parts. IMPORTANT: if the product does not have the selected part, change NOTHING and return the photo unmodified — never invent or add a part.',
        'Output one photorealistic image only.',
      ].filter(Boolean).join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'pose') {
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
        (String(poseType) !== 'auto' ? 'MY PRODUCT IS: ' + ({ top: 'a top / shirt', bottoms: 'bottoms (trousers, jeans or a skirt)', dress: 'a dress', shoes: 'footwear', bag: 'a bag' }[String(poseType)] || String(poseType)) + '.' : ''),
        (({ top: 1, bottoms: 1, dress: 1 }[String(poseType)]) ? ({
          product: '',
          notrelaxed: 'PRESENTATION: present the garment NOT TOO RELAXED — a clean regular shape with minimal ease.',
          slight: 'PRESENTATION: present the garment SLIGHTLY RELAXED — a little soft ease and gentle drape.',
          relaxed: 'PRESENTATION: present the garment RELAXED — soft natural volume and drape, not pressed flat or slim.',
          toorelaxed: 'PRESENTATION: present the garment VERY RELAXED / OVERSIZED — generous volume and heavy soft drape.',
          slim: 'PRESENTATION: present the garment SLIM — a neat, trim silhouette.',
          fitted: 'PRESENTATION: present the garment BODY-FITTED in shape — a close, contoured silhouette.',
          other: poseFitLabel ? 'PRESENTATION: ' + poseFitLabel : '',
        }[String(poseFit)] || '') : ''),
        (String(neckLabel) === 'none' ? 'LABELS: this garment has NO brand neck label — do not add one.' : String(neckLabel) === 'remove' ? 'LABELS: REMOVE the brand neck label completely, leaving clean fabric.' : ''),
        (String(hemLabel) === 'none' ? 'It has NO hem or side tag — do NOT add one anywhere.' : String(hemLabel) === 'remove' ? 'REMOVE the hem/side tag completely — clean seam, no mark.' : ''),
        'NEVER add or invent any label, tag or logo the product does not have in image 1.',
        'THE PRODUCT STAYS MINE, IDENTICAL: same design, same materials and textures, same bow/straps/details, same stitching, same sole, same proportions and true size, same labels and logos — exactly as in image 1. COLOUR IS CRITICAL: image 1 is the colour ground truth — every part of my product must keep EXACTLY the colour it has in image 1, same hue, same darkness, same saturation; do not lighten, darken, warm or cool it. Copy NOTHING of the reference product\'s design, colour or material. This is a minimal change: adjust only the viewpoint/pose/shadow/background as instructed, nothing else about the product.',
        'Premium e-commerce quality, sharp focus, true-to-life colour. Output one photorealistic image only.',
      ].join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'bg' && String((req.body || {}).bgMethod || 'recreate') === 'recreate') {
      const __bc = (typeof bgChoice !== 'undefined' ? String(bgChoice) : '').toLowerCase();
      const __cust = (typeof bgCustom !== 'undefined' ? String(bgCustom) : '').trim();
      const bgText = __bc === 'white' ? 'pure white #FFFFFF'
        : /grey|gray|f8/.test(__bc) ? 'very light grey #F8F8F8'
        : (/ref/.test(__bc) && entry.bg) ? 'exactly the background colour and tone of the reference image (copy ONLY its background colour from it, nothing else)'
        : __cust ? __cust : 'pure white #FFFFFF';
      const __sh = (typeof shadowSrc !== 'undefined' ? String(shadowSrc) : 'auto').toLowerCase();
      const TIGHT = 'a TIGHT CONTACT SHADOW in premium Nordstrom catalogue style: only a very faint, soft, light-grey shadow exactly where the sole touches the ground — a thin line hugging the bottom edge of the sole, fading out within a few millimetres. NOT a dark pool, NOT a wide oval patch spreading around or in front of the product, NOT a cast shadow to one side; the area around the product stays clean white';
      const shText = (/ref/.test(__sh) && entry.bg)
        ? 'copy the SHADOW STYLE of the reference image exactly — look at how faint, thin and tight the shadow under its product is and reproduce that same subtle look under my product, never darker, wider or longer than in the reference (' + TIGHT + ')'
        : TIGHT;
      instruction = [
        'Image 1 is my product photo. Re-shoot it from scratch as a brand-new premium e-commerce studio photograph of the SAME product. Do NOT reuse or copy any pixels of the old background or the old shadow — generate a completely new, clean backdrop and a new shadow.',
        'The product must stay identical in every detail: same shape, colour, material and texture, same stitching, sole, hardware and proportions. Keep EXACTLY the same camera angle, framing, size and position in the frame.',
        'BACKGROUND: completely replace the old backdrop with a seamless, perfectly even ' + bgText + ' background from edge to edge. No trace of the old backdrop may remain: no grey patches, no gradient, no vignette, no floor line, no halo around the product.',
        'SHADOW: ' + shText + '. No other shadows.',
        'Even studio lighting, sharp focus, true-to-life colour. Output one photorealistic image only.',
      ].join(' ');
      if (String(prompt || '').trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
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
        'COLOUR TRUTH: the garment keeps EXACTLY its colour from image 1 — same hue, same darkness, same saturation, no tint shift, no washing out. The background must be clean, even and seamless, and changing the background never changes the garment colour.',
        String(logoMode) === 'replace'
          ? 'Image roles: use Image 1 for the garment, its shape and the position, size and orientation of every label; use the additional product photos for the label positions and the garment details; the logo image is the COMPLETE new artwork for every label; use the style reference only for background, lighting and finish.'
          : 'Image roles: use Image 1 for the garment, its shape and the position of every label; use the additional product photos for the exact look of each label up close; use the logo image only for the exact icon and lettering; use the style reference only for background, lighting and finish.',
        String(logoMode) === 'replace'
          ? ('LABEL RULES — the garment keeps ONLY the labels it already has in the product photos. NEVER add or invent any label, tag, patch or logo anywhere on the garment, and never print anything directly onto the garment fabric. '
            + (String(neckLabel) === 'none' ? 'NECK LABEL: this garment has NO brand neck label — do not add one. '
              : String(neckLabel) === 'remove' ? 'NECK LABEL: REMOVE the brand neck label completely — take it off and leave clean, untouched fabric where it was, with no mark and nothing put in its place. '
              : 'NECK LABEL: the sewn-in brand label at the inside back neck MUST STAY exactly where it is — same label rectangle, colour, size, stitching, position and orientation. Change ONLY the design on its face: erase the old design (any doll/figure icon and the old lettering) and put ' + (entry.logo ? (String(brandText).trim() ? 'the text "' + String(brandText).trim().replace(/"/g, '') + '" in that exact script font' : 'the text of the logo image in that exact script font') : (String(brandText).trim() ? 'the text "' + String(brandText).trim().replace(/"/g, '') + '" in the SAME script lettering that is already on the labels in the product photos (keep that existing lettering exactly, just without the icon)' : 'the existing lettering that is already on the labels in the product photos, kept exactly as it is, just without the icon')) + ', white on the label, centred, sized to fit with a small margin — text only, NO icon, NO figure, NO symbol, text horizontal. ')
            + (String(hemLabel) === 'none' ? 'HEM/SIDE TAG: this garment has NO hem or side flag tag — do NOT add one anywhere. '
              : String(hemLabel) === 'remove' ? 'HEM/SIDE TAG: REMOVE the flag tag at the hem/side seam completely — take it off and leave a clean seam, no tag and no mark left behind. '
              : 'HEM/SIDE TAG: the flag tag at the hem/side seam MUST STAY exactly where it is; update its print the same way — old icon gone, ' + (entry.logo ? (String(brandText).trim() ? 'the text "' + String(brandText).trim().replace(/"/g, '') + '" in that exact script font' : 'the text of the logo image in that exact script font') : (String(brandText).trim() ? 'the text "' + String(brandText).trim().replace(/"/g, '') + '" in the SAME script lettering that is already on the labels in the product photos (keep that existing lettering exactly, just without the icon)' : 'the existing lettering that is already on the labels in the product photos, kept exactly as it is, just without the icon')) + ' running along the tag as before. ')
            + 'SIZE LABEL: the separate small size label (e.g. "M") is NOT a brand label — keep it exactly as photographed, untouched; any care label stays too. Nothing else is removed.')
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
      const TSTYLES = {
        product: '',
        regular: 'TOP STYLE: REGULAR cut and length.',
        crop: 'TOP STYLE: CROPPED — the hem ends above the hip, around the natural waistline.',
        boxy: 'TOP STYLE: BOXY — a square, roomy cut with a straight, wide body.',
        drop: 'TOP STYLE: DROP SHOULDER — the shoulder seams sit visibly below the natural shoulder line.',
        longline: 'TOP STYLE: LONGLINE — the hem extends below the hip.',
        other: topStyleLabel ? 'TOP STYLE: ' + topStyleLabel : '',
      };
      const tText = TSTYLES[String(topStyle)] !== undefined ? TSTYLES[String(topStyle)] : '';
      const notesText = String(swapNotes || '').trim() ? 'Extra instructions: ' + String(swapNotes).trim() : '';
      const fitText = FITS[String(fit)] !== undefined ? FITS[String(fit)] : FITS.product;
      const bText = BSTYLES[String(bottomsStyle)] !== undefined ? BSTYLES[String(bottomsStyle)] : '';
      const swapLabelRules = 'LABEL RULES: the garment has ONLY the labels and tags visible in my product photos — NEVER add or invent any label, tag, patch, embroidery or logo anywhere on it. '
        + (String(hemLabel) === 'none' ? 'It has NO hem or side tag — do NOT add one. ' : String(hemLabel) === 'remove' ? 'Remove its hem/side tag completely — clean seam, no mark left. ' : '')
        + (String(neckLabel) === 'none' ? 'It has NO brand neck label — do not add one. ' : String(neckLabel) === 'remove' ? 'Remove its brand neck label completely. ' : '');
      const swapColourTruth = 'COLOUR TRUTH: the garment keeps EXACTLY the colour of my product photos — same hue, same darkness, same saturation, no tint shift.';
      const otherGarment = String(category) === 'bottoms' ? 'the TOP the model wears'
        : (String(category) === 'top' || String(category) === 'dress') ? 'the BOTTOMS the model wears (trousers, jeans or skirt)'
        : 'the other main clothing the model wears';
      const OTHER_COLORS = {
        keep: '',
        match: 'the EXACT same colour as my product, so the outfit reads as a colour-matched set',
        black: 'BLACK', white: 'WHITE', grey: 'GREY', beige: 'BEIGE / neutral tan', denim: 'classic blue DENIM',
        other: otherColorLabel || '',
      };
      const otherColText = OTHER_COLORS[String(otherColor)] !== undefined ? OTHER_COLORS[String(otherColor)] : '';
      const otherText = otherColText
        ? 'EXCEPTION — OTHER CLOTHING COLOUR: additionally recolour ' + otherGarment + ' to ' + otherColText + '. Only its COLOUR changes — it stays the exact same garment with the same fit, cut, fabric, texture and details, worn exactly the same way. No other clothing, and nothing else in the photo, changes colour.'
        : '';
      const logosText = String(logosOpt) === 'remove'
        ? 'LOGOS: remove every visible brand logo, brand label, hem tag, side tag, patch, button logo, embroidery or brand text from the garment — it must look completely plain and unbranded.'
        : 'LOGOS AND LABELS: keep every logo, label, hem tag and marking exactly as it appears on my product in the product photos — do not remove or invent any.';
      instruction = [
        `Edit sample photo 1. Keep absolutely everything the same — the person, face, pose, skin, hair, all other clothing, the background, lighting, colours and shadows. Replace ONLY the ${cat} worn in the photo with my product shown in product photo${P > 1 ? 's 1 to ' + P : ' 1'}. My product must be reproduced exactly: same shape, colour, material, texture and details as in the product photos, with correct perspective, size and lighting for the scene.`,
        fitText, tText, bText, logosText, swapLabelRules, swapColourTruth, otherText, notesText,
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
    if ((mode === 'material' || mode === 'recolor') && String(req.body.protectRest || 'on') !== 'off') {
      try {
        const pr = await protectRest(outBuf, base.base64, { threshold: mode === 'material' ? 14 : 26 });
        if (pr.protectedPct >= 99.9) console.log('  protect rest skipped — change too subtle to isolate (kept the model output whole)');
        else if (pr.protectedPct >= 20) { outBuf = pr.buf; console.log('  protect rest: ' + pr.protectedPct + '% of the photo restored pixel-exact from the original'); }
        else console.log('  protect rest skipped — the change covered most of the frame (' + (100 - pr.protectedPct) + '%)');
      } catch (e) { console.warn('  protect rest failed: ' + e.message); }
    }
    if (mode === 'pose' && String(colorLock) !== 'off') {
      try { outBuf = await colorLockBuffer(outBuf, base.base64); console.log('  colour lock applied (product colours matched to the source photo)'); } catch (e) { console.warn('  colour lock failed: ' + e.message); }
    }
    if (mode === 'apparel' && String(labelOverlay) !== 'off' && ((entry.labels && entry.labels.length) || (String(logoMode) === 'replace' && entry.logo))) {
      try {
        let labelSet = entry.labels && entry.labels.length ? entry.labels : null;
        if (!labelSet) {
          if (!entry.autoLabels) { entry.autoLabels = await buildLabelArtworks(entry.logo); console.log('  built ' + entry.autoLabels.length + ' label artworks from the logo image'); }
          labelSet = entry.autoLabels.filter((li, i) => (i === 0 ? String(neckLabel) === 'keep' : String(hemLabel) === 'keep'));
        }
        const r = await overlayLabels(outBuf, labelSet, entry.labels && entry.labels.length ? 0.45 : 0.68); // auto-built labels need a confident match
        outBuf = r.buf;
        console.log('  label overlay: ' + r.hits.map((h, i) => 'label ' + (i + 1) + (h ? ' pasted at ' + h.x + ',' + h.y + ' ' + h.w + 'x' + h.h + ' (match ' + h.score.toFixed(2) + ')' : ' not pasted — no confident match, left as generated')).join('; '));
      } catch (e) { console.warn('  label overlay failed: ' + e.message); }
    }
    if (targetAspect) { try { outBuf = await (mode === 'free' ? cropToAspect(g.buf, targetAspect) : padToAspect(g.buf, targetAspect)); } catch (e) { console.warn('  pad to ' + targetAspect + ' failed: ' + e.message); } }
    if (mode === 'bg') { const __bc = (typeof bgChoice !== 'undefined' ? String(bgChoice) : '').toLowerCase(); let __t = null;
      try {
        if (__bc === 'white') __t = [255, 255, 255];
        else if (/grey|gray|f8/.test(__bc)) __t = [248, 248, 248];
        else if (/ref/.test(__bc) && entry && entry.bg && entry.bg.base64) { __t = await refBackdropColor(entry.bg.base64); console.log('  reference backdrop colour: rgb(' + __t.join(',') + ')'); }
        if (!__t && typeof bgCustom !== 'undefined' && String(bgCustom).trim()) { __t = parseColourText(bgCustom); if (__t) console.log('  custom backdrop colour "' + String(bgCustom).trim() + '": rgb(' + __t.join(',') + ')'); }
        if (__t && String((req.body || {}).bgMethod || 'recreate') === 'recreate') { console.log('  recreate: using the Gemini output as-is (no pixel edits)'); __t = null; }
        if (__t) outBuf = await whitenBackground(outBuf, __t);
      } catch (e) { console.warn('  backdrop fix failed: ' + e.message); } }
    const cleaned = await passthrough(outBuf, targetAspect ? 'image/png' : g.mime);
    console.log(`  [edit/${mode}] photo ${Number(baseIndex) + 1} v${variant}: done ${cleaned.width}x${cleaned.height} (requested ${String(resolution).toUpperCase()}, generated ${aspect}${targetAspect ? ', padded to ' + targetAspect : ''}) via ${provider}/${model}`);
    const id = crypto.randomUUID();
    generatedStore.set(id, { ...cleaned, createdAt: Date.now(), label: ((typeof req !== 'undefined' && req.body && req.body.outName) ? String(req.body.outName).replace(/[^\w\-. ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) + '-take' + (typeof variant !== 'undefined' ? variant : 1) : undefined) }); if (typeof capGeneratedStore === 'function') capGeneratedStore();
    req._finishJob({ status: 'COMPLETED', imageUrl: `/api/image/${id}.png`, width: cleaned.width, height: cleaned.height, variant, baseIndex });
  } catch (err) {
    console.error('edit error:', err.message);
    const failPayload = { status: 'FAILED', error: err.message, variant: req.body && req.body.variant, baseIndex: req.body && req.body.baseIndex };
    if (req._finishJob) req._finishJob(failPayload); else if (!res.headersSent) res.status(200).json(failPayload);
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
