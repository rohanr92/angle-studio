const fs = require('fs');
let n = 0;
function must(s, a, b, f) { if (!s.includes(a)) { console.error('PATCH FAILED in ' + f + ': ' + String(a).slice(0, 80)); process.exit(1); } n++; return s.replace(a, b); }

let s = fs.readFileSync('server.js', 'utf8');
if (!s.includes('MAX_STORED_IMAGES')) {
  // 1. heavy NCC loop yields to the event loop so other users' requests keep flowing
  s = must(s, `    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (region && region.allow && !region.allow(x, y, tw, th)) continue;`,
`    for (let y = y0; y <= y1; y++) {
      if ((y & 7) === 0) await new Promise((r) => setImmediate(r)); // stay responsive for other users
      for (let x = x0; x <= x1; x++) {
        if (region && region.allow && !region.allow(x, y, tw, th)) continue;`, 'server.js');

  // 2. colour lock loop yields periodically too
  s = must(s, `    for (let p = 0; p < W * H; p++) {
      const i = p * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const d = Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb);
      if (d <= 60) continue; // background / shadow zone untouched`,
`    for (let p = 0; p < W * H; p++) {
      if ((p & 0xFFFFF) === 0) await new Promise((r2) => setImmediate(r2)); // stay responsive
      const i = p * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const d = Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb);
      if (d <= 60) continue; // background / shadow zone untouched`, 'server.js');

  // 3. hard caps with oldest-first eviction (protects memory with many users)
  s = must(s, `setInterval(() => { for (const [id, g] of generatedStore) if (g.createdAt < Date.now() - 6 * 3600e3) generatedStore.delete(id); }, 600e3);`,
`setInterval(() => { for (const [id, g] of generatedStore) if (g.createdAt < Date.now() - 6 * 3600e3) generatedStore.delete(id); }, 600e3);
const MAX_STORED_IMAGES = Number(process.env.MAX_STORED_IMAGES || 120);
function capGeneratedStore() {
  while (generatedStore.size > MAX_STORED_IMAGES) {
    let oldestId = null, oldest = Infinity;
    for (const [id, g] of generatedStore) if (g.createdAt < oldest) { oldest = g.createdAt; oldestId = id; }
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
}`, 'server.js');
  // apply caps at every insertion
  s = s.split(`generatedStore.set(id, { ...cleaned, createdAt: Date.now() });`).join(`generatedStore.set(id, { ...cleaned, createdAt: Date.now() }); capGeneratedStore();`);
  n++;
  s = must(s, `    referenceStore.set(referenceId, {`, `    capReferenceStore(referenceStore);
    referenceStore.set(referenceId, {
      createdAt: Date.now(),`, 'server.js');
  fs.writeFileSync('server.js', s);
}
console.log('patched OK (' + n + ' edits)');
