const fs = require('fs');
let n = 0;
function must(s, a, b, f) { if (!s.includes(a)) { console.error('PATCH FAILED in ' + f + ': ' + String(a).slice(0, 80)); process.exit(1); } n++; return s.replace(a, b); }

// ===================== server.js =====================
let s = fs.readFileSync('server.js', 'utf8');
if (!s.includes('sheetangle')) {
  // params
  s = must(s, `      topStyle = 'product', topStyleLabel = '', swapNotes = '',`,
             `      topStyle = 'product', topStyleLabel = '', swapNotes = '',
      sheetColor = '',`, 'server.js');
  // product-photo exemption
  s = must(s, `mode !== 'material' && !entry.product.length`,
             `mode !== 'material' && mode !== 'sheetangle' && !entry.product.length`, 'server.js');
  // mode branch
  s = must(s, `    if (mode === 'material') {`, `    if (mode === 'sheetangle') {
      const colr = String(sheetColor || '').trim() || 'the shown';
      instruction = [
        'The attached photo shows my footwear product — possibly several colourways together, at a casual angle, on a non-studio background (it may be a supplier or showroom photo).',
        'Create ONE professional e-commerce product photograph of ONLY the ' + colr + ' colourway: a single RIGHT shoe in a true side profile, toe pointing to the RIGHT, standing flat, like a premium Nordstrom catalogue shot.',
        'Reproduce MY shoe exactly — same design, construction, materials, texture and details as in the photo. If the photo does not show the ' + colr + ' colourway, recolour my shoe accurately to ' + colr + ' with a realistic finish for that material.',
        'BACKGROUND: pure seamless WHITE #FFFFFF edge to edge, no props, no other shoes, no surface texture. SHADOW: one soft, tight, natural contact shadow directly under the sole.',
        'The outsole and every surface stay CLEAN: NO logo, NO text, NO embossing on the sole. Premium studio lighting, sharp focus, true-to-life colour. Output one photorealistic image only.',
      ].join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'material') {`, 'server.js');
  // output naming honours outName
  const oldLabel = `label: (typeof mode !== 'undefined' ? mode + '-photo' + (Number(typeof baseIndex !== 'undefined' ? baseIndex : 0) + 1) + '-take' + (typeof variant !== 'undefined' ? variant : 1) : (typeof angleLabel !== 'undefined' ? angleLabel + '-take' + variant : 'image'))`;
  if (!s.includes(oldLabel)) { console.error('PATCH FAILED in server.js: label expression not found'); process.exit(1); }
  s = s.split(oldLabel).join(`label: ((req.body && req.body.outName) ? String(req.body.outName).replace(/[^\\w\\-. ]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 60) + '-take' + (typeof variant !== 'undefined' ? variant : 1) : ` + oldLabel + `)`);
  n++;
  // sheet parsing + upload endpoint
  s = must(s, `app.get('/api/recent', (req, res) => {`,
`let AdmZip = null; try { AdmZip = require('adm-zip'); } catch (e) { AdmZip = null; }
const multerLib = require('multer');
const sheetUpload = multerLib({ storage: multerLib.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

function parseSheetWorkbook(buf) {
  const zip = new AdmZip(buf);
  const read = (p) => { const e = zip.getEntry(p); return e ? zip.readAsText(e) : null; };
  const readBin = (p) => { const e = zip.getEntry(p); return e ? e.getData() : null; };
  const colLetters = (ref) => { const m = ref.match(/^([A-Z]+)(\\d+)$/); if (!m) return null; let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { col: c - 1, row: Number(m[2]) - 1 }; };
  const ssXml = read('xl/sharedStrings.xml') || '';
  const shared = [...ssXml.matchAll(/<si>([\\s\\S]*?)<\\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\\s\\S]*?)<\\/t>/g)].map((t) => t[1]).join('').replace(/&amp;/g, '&'));
  const wb = read('xl/workbook.xml') || '';
  const wbRels = read('xl/_rels/workbook.xml.rels') || '';
  const relMap = {}; [...wbRels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].forEach((m) => { relMap[m[1]] = m[2].replace(/^\\//, ''); });
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: m[1], path: 'xl/' + String(relMap[m[2]] || '').replace(/^xl\\//, '') }));
  const pics = [];
  for (const sh of sheets) {
    const sx = read(sh.path); if (!sx) continue;
    const cells = {};
    [...sx.matchAll(/<c ([^>]*)>([\\s\\S]*?)<\\/c>/g)].forEach((m) => {
      const rAttr = m[1].match(/r="([A-Z]+\\d+)"/); if (!rAttr) return;
      const tAttr = m[1].match(/t="(\\w+)"/);
      const pos = colLetters(rAttr[1]); if (!pos) return;
      const type = tAttr ? tAttr[1] : '';
      let txt = null;
      if (type === 's') { const v = m[2].match(/<v>(\\d+)<\\/v>/); if (v) txt = shared[Number(v[1])]; }
      else if (type === 'inlineStr' || type === 'str') { const t = m[2].match(/<t[^>]*>([\\s\\S]*?)<\\/t>/) || m[2].match(/<v>([\\s\\S]*?)<\\/v>/); if (t) txt = t[1]; }
      else { const v = m[2].match(/<v>([\\s\\S]*?)<\\/v>/); if (v) txt = v[1]; }
      if (txt != null && String(txt).trim()) cells[pos.row + ':' + pos.col] = String(txt).trim();
    });
    const base = sh.path.split('/').pop();
    const srel = read('xl/worksheets/_rels/' + base + '.rels') || '';
    const dm = srel.match(/Target="([^"]*drawing[^"]*)"/); if (!dm) continue;
    const dpath = 'xl/' + dm[1].replace(/\\.\\.\\//g, '');
    const dx = read(dpath) || '';
    const drel = read(dpath.replace(/drawings\\//, 'drawings/_rels/') + '.rels') || '';
    const dRelMap = {}; [...drel.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].forEach((m) => { dRelMap[m[1]] = 'xl/' + m[2].replace(/\\.\\.\\//g, ''); });
    const anchors = [...dx.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)[^>]*>([\\s\\S]*?)<\\/xdr:\\1>/g)];
    for (const a of anchors) {
      const body = a[2];
      const from = body.match(/<xdr:from>[\\s\\S]*?<xdr:col>(\\d+)<\\/xdr:col>[\\s\\S]*?<xdr:row>(\\d+)<\\/xdr:row>/);
      const to = body.match(/<xdr:to>[\\s\\S]*?<xdr:col>(\\d+)<\\/xdr:col>[\\s\\S]*?<xdr:row>(\\d+)<\\/xdr:row>/);
      const blip = body.match(/r:embed="([^"]+)"/);
      if (!from || !blip || !dRelMap[blip[1]]) continue;
      const fc = Number(from[1]), fr = Number(from[2]);
      const tc = to ? Number(to[1]) : fc + 3, tr = to ? Number(to[2]) : fr + 10;
      const texts = [];
      for (let r = Math.max(0, fr - 1); r <= tr + 5; r++) for (let c = Math.max(0, fc - 2); c <= tc + 4; c++) { const t = cells[r + ':' + c]; if (t) texts.push({ r, c, t }); }
      texts.sort((x, y) => x.r - y.r || x.c - y.c);
      const labels = []; for (const t of texts) if (!/^[\\d.,]+$/.test(t.t) && !labels.includes(t.t)) labels.push(t.t);
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

app.get('/api/recent', (req, res) => {`, 'server.js');
  fs.writeFileSync('server.js', s);
}

// ===================== index.html =====================
let h = fs.readFileSync('public/index.html', 'utf8');
if (!h.includes('sheetPanel')) {
  h = must(h, `<button type="button" class="tab" data-ws="material">Material</button>`,
             `<button type="button" class="tab" data-ws="material">Material</button>
      <button type="button" class="tab" data-ws="sheet">Batch sheet</button>`, 'index.html');
  h = must(h, `      <section class="panel" id="materialPanel" hidden>`, `      <section class="panel" id="sheetPanel" hidden>
        <header class="panel__head"><span class="panel__num">Bs</span><h2>Batch from sheet</h2></header>
        <p class="panel__hint">Upload a buying sheet (.xlsx). Every embedded photo is pulled out with its style name and colours. Review the list, fix any name, then generate: one professional side-profile angle per colour, pure white background, no sole logo — each output named Style-Colour.</p>
        <label class="dropzone" for="sheetFileInput" style="padding:14px; margin-bottom:10px">
          <span class="dropzone__text">Drop the .xlsx sheet</span>
          <span class="dropzone__meta">Excel with embedded photos</span>
        </label>
        <input id="sheetFileInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
        <div id="sheetReview" style="margin-bottom:10px"></div>
        <div class="spec-row" style="margin-bottom:8px">
          <label class="spec-field"><span>Resolution</span>
            <select id="sheetResolution"><option value="2k" selected>2K</option><option value="4k">4K</option></select>
          </label>
          <label class="spec-field"><span>Aspect</span>
            <select id="sheetAspect"><option value="1:1" selected>1:1</option><option value="4:5">4:5</option><option value="auto">Auto</option></select>
          </label>
        </div>
        <button id="sheetGenerateBtn" class="btn" type="button" style="width:100%">Generate batch</button>
      </section>

      <section class="panel" id="materialPanel" hidden>`, 'index.html');
  fs.writeFileSync('public/index.html', h);
}

// ===================== app.js =====================
let a = fs.readFileSync('public/app.js', 'utf8');
if (!a.includes('sheetPanel')) {
  a = must(a, `  const materialPanel = document.getElementById('materialPanel');`,
             `  const materialPanel = document.getElementById('materialPanel');
  const sheetPanel = document.getElementById('sheetPanel');`, 'app.js');
  a = must(a, `    materialPanel.hidden = ws !== 'material';`,
             `    materialPanel.hidden = ws !== 'material';
    if (sheetPanel) sheetPanel.hidden = ws !== 'sheet';`, 'app.js');
  a = must(a, `  applyWorkspace('angles');
})();`,
`  // --- Batch sheet: parse xlsx server-side, review, generate per colour ---
  (function batchSheet() {
    const fileInput = document.getElementById('sheetFileInput');
    const reviewEl = document.getElementById('sheetReview');
    const genBtn = document.getElementById('sheetGenerateBtn');
    if (!fileInput || !genBtn) return;
    let sheet = null;
    function renderReview() {
      reviewEl.innerHTML = '';
      if (!sheet) return;
      sheet.items.forEach((it, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:8px';
        const img = document.createElement('img');
        img.src = it.thumb; img.style.cssText = 'width:64px; height:64px; object-fit:cover; border-radius:6px; flex:none';
        const styleIn = document.createElement('input'); styleIn.type = 'text'; styleIn.value = it.style || ''; styleIn.placeholder = 'Style name'; styleIn.style.cssText = 'width:34%';
        styleIn.addEventListener('input', () => { it.style = styleIn.value; });
        const colorsIn = document.createElement('input'); colorsIn.type = 'text'; colorsIn.value = (it.colors || []).join(', '); colorsIn.placeholder = 'Colours, comma separated'; colorsIn.style.cssText = 'flex:1';
        colorsIn.addEventListener('input', () => { it.colors = colorsIn.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean); });
        const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×';
        rm.addEventListener('click', () => { sheet.items.splice(idx, 1); renderReview(); });
        row.appendChild(img); row.appendChild(styleIn); row.appendChild(colorsIn); row.appendChild(rm);
        reviewEl.appendChild(row);
      });
    }
    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      setStatus('Reading the sheet…');
      const fd = new FormData(); fd.append('sheet', f);
      try {
        const r = await fetch('/api/sheet', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok || d.error) { setStatus(d.error || 'Could not read the sheet.', 'is-error'); return; }
        sheet = d; renderReview();
        setStatus('Found ' + d.items.length + ' photos — check styles and colours, then Generate batch.', 'is-ok');
      } catch (err) { setStatus('Sheet upload failed: ' + err.message, 'is-error'); }
    });
    genBtn.addEventListener('click', async () => {
      if (!sheet || !sheet.items.length) return setStatus('Upload the .xlsx sheet first.', 'is-error');
      const key = (typeof googleKeyInput !== 'undefined' && googleKeyInput) ? googleKeyInput.value.trim() : (localStorage.getItem('googleApiKey') || '');
      if (!key) return setStatus('Enter your Google API key in the Google API key section first.', 'is-error');
      const tasks = [];
      sheet.items.forEach((it) => {
        const style = (it.style || '').trim() || 'Style';
        const colors = (it.colors && it.colors.length) ? it.colors : ['as shown'];
        colors.forEach((c) => tasks.push({ baseIndex: it.index, color: c, outName: style + ' - ' + c }));
      });
      if (!tasks.length) return setStatus('Nothing to generate — add at least one colour.', 'is-error');
      const resolution = document.getElementById('sheetResolution').value;
      const aspect = document.getElementById('sheetAspect').value;
      renderPlaceholders(tasks.map((t) => t.outName), 1);
      genBtn.disabled = true;
      setStatus('Generating ' + tasks.length + ' angle image(s)…');
      const finished = []; let done = 0;
      await Promise.all(tasks.map(async (t, idx) => {
        await new Promise((r) => setTimeout(r, idx * 250));
        let result;
        try {
          const resp = await fetch('/api/edit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ async: '1', referenceId: sheet.referenceId, baseIndex: t.baseIndex, mode: 'sheetangle', sheetColor: t.color, outName: t.outName, variant: 1, resolution, aspectRatio: aspect, provider: 'google', googleApiKey: key }),
          });
          result = await resp.json();
          if (result && result.jobId) result = await pollJob(result.jobId);
        } catch (err) { result = { status: 'FAILED', error: err.message }; }
        renderCellResult(idx, 1, t.outName, result, aspect, resolution);
        if (result && result.status === 'COMPLETED') finished.push({ label: t.outName, url: result.imageUrl });
        done++; sheetSub.textContent = done + ' of ' + tasks.length + ' frames developed.';
      }));
      genBtn.disabled = false;
      if (finished.length) { downloadAllBtn.hidden = false; downloadAllBtn.onclick = () => downloadAll(finished); }
      setStatus('Batch done — ' + finished.length + ' of ' + tasks.length + ' succeeded. Download the zip now.', finished.length ? 'is-ok' : 'is-error');
    });
  })();

  applyWorkspace('angles');
})();`, 'app.js');
  fs.writeFileSync('public/app.js', a);
}
console.log('patched OK (' + n + ' edits)');
