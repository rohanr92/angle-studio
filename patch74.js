const fs = require('fs');
let n = 0;
function must(s, a, b, f) { if (!s.includes(a)) { console.error('PATCH FAILED in ' + f + ': ' + String(a).slice(0, 80)); process.exit(1); } n++; return s.replace(a, b); }

// ===================== server.js =====================
let s = fs.readFileSync('server.js', 'utf8');
if (!s.includes('fxMainRef')) {
  s = must(s, `fxNeck = 'keep', fxHem = 'keep', fxLogos = 'keep',`,
             `fxNeck = 'keep', fxHem = 'keep', fxLogos = 'keep', fxMainRef = '0',`, 'server.js');
  s = must(s, `      const hasRefBoard = ITEMS.some((it) => String(it[2]) === 'ref') && entry.bg;`,
             `      const hasRefBoard = (ITEMS.some((it) => String(it[2]) === 'ref') || String(fxMainRef) === '1') && entry.bg;`, 'server.js');
  s = must(s, `        'NEVER add or invent any garment, accessory, label or logo that is not in image 1 or explicitly requested above. Colours stay true to life.',`,
             `        (String(fxMainRef) === '1' && entry.bg) ? 'COLOUR TRUTH FOR THE MAIN PRODUCT: the reference board section labelled "MAIN PRODUCT" shows my real product (' + (MAIN_TAG ? ({ TOP: 'the top', BOTTOMS: 'the bottoms', SHOES: 'the shoes', BAG: 'the bag' })[MAIN_TAG] : 'the item being sold') + '). In the final image that product must match those photos EXACTLY in colour — same hue, same darkness, same saturation, same fabric look. If it looks even slightly different in image 1, correct it to match the MAIN PRODUCT photos. Do not change its design, fit or position.' : '',
        'NEVER add or invent any garment, accessory, label or logo that is not in image 1 or explicitly requested above. Colours stay true to life.',`, 'server.js');
  fs.writeFileSync('server.js', s);
}

// ===================== index.html =====================
let h = fs.readFileSync('public/index.html', 'utf8');
if (!h.includes('fxMainInput')) {
  h = must(h, `        <p class="panel__hint" style="margin-bottom:6px">2 · What to change</p>`,
`        <p class="panel__hint" style="margin-bottom:6px">Main product photos (optional, up to 4) — photos of your real product, used as the colour truth so it never drifts.</p>
        <button id="fxMainBtn" type="button" class="btn btn--ghost" style="margin-bottom:8px">Add main product photos</button>
        <input id="fxMainInput" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
        <div id="fxMainPreview" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px"></div>
        <p class="panel__hint" style="margin-bottom:6px">2 · What to change</p>`, 'index.html');
  fs.writeFileSync('public/index.html', h);
}

// ===================== app.js =====================
let a = fs.readFileSync('public/app.js', 'utf8');
if (!a.includes('fxMainInput')) {
  a = must(a, `    state.fxBoardBlob = null;
    async function rebuildBoard() {
      const refs = ITEMS.filter((t) => st[t].opt === 'ref' && st[t].file);
      if (!refs.length) { state.fxBoardBlob = null; return; }`,
`    state.fxBoardBlob = null;
    const mainFiles = [];
    async function rebuildBoard() {
      const refs = ITEMS.filter((t) => st[t].opt === 'ref' && st[t].file);
      if (!refs.length && !mainFiles.length) { state.fxBoardBlob = null; return; }`, 'app.js');
  a = must(a, `          imgs.push({ tag: t, im, h: Math.round(im.height * W / im.width) });
        }`,
`          imgs.push({ tag: t, im, h: Math.round(im.height * W / im.width) });
        }
        for (let mi = 0; mi < mainFiles.length; mi++) {
          const url = URL.createObjectURL(mainFiles[mi]);
          const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
          imgs.push({ tag: 'MAIN PRODUCT' + (mainFiles.length > 1 ? ' (' + (mi + 1) + ')' : ''), im, h: Math.round(im.height * W / im.width) });
        }`, 'app.js');
  a = must(a, `    window.fxOpt = (tag) => (st[tag] ? st[tag].opt : 'keep');`,
`    const mInput = document.getElementById('fxMainInput');
    const mBtn = document.getElementById('fxMainBtn');
    const mPrev = document.getElementById('fxMainPreview');
    function renderMain() {
      mPrev.innerHTML = '';
      mainFiles.forEach((f, i) => {
        const box = document.createElement('div'); box.style.cssText = 'position:relative';
        const im = document.createElement('img'); im.src = URL.createObjectURL(f); im.style.cssText = 'width:52px; height:52px; object-fit:cover; border-radius:5px';
        const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×'; rm.style.cssText = 'position:absolute; top:-6px; right:-6px';
        rm.addEventListener('click', () => { mainFiles.splice(i, 1); renderMain(); rebuildBoard(); });
        box.appendChild(im); box.appendChild(rm); mPrev.appendChild(box);
      });
    }
    if (mBtn && mInput) {
      mBtn.addEventListener('click', () => mInput.click());
      mInput.addEventListener('change', (e) => {
        for (const f of Array.from(e.target.files || [])) { if (f.type.startsWith('image/') && mainFiles.length < 4) mainFiles.push(f); }
        mInput.value = ''; renderMain(); rebuildBoard();
      });
    }
    window.fxMainCount = () => mainFiles.length;
    window.fxOpt = (tag) => (st[tag] ? st[tag].opt : 'keep');`, 'app.js');
  a = must(a, `fxLogos: (document.getElementById('fxLogosSelect') || { value: 'keep' }).value,`,
             `fxLogos: (document.getElementById('fxLogosSelect') || { value: 'keep' }).value,
              fxMainRef: (window.fxMainCount && window.fxMainCount() > 0) ? '1' : '0',`, 'app.js');
  fs.writeFileSync('public/app.js', a);
}
console.log('patched OK (' + n + ' edits)');
