const fs = require('fs');
let n = 0;
function must(s, a, b, f) { if (!s.includes(a)) { console.error('PATCH FAILED in ' + f + ': ' + String(a).slice(0, 80)); process.exit(1); } n++; return s.replace(a, b); }

// ===================== server.js =====================
let s = fs.readFileSync('server.js', 'utf8');
if (!s.includes('modelfix')) {
  s = must(s, `      sheetColor = '',`,
             `      sheetColor = '',
      fxShoes = 'keep', fxShoesText = '', fxBottoms = 'keep', fxBottomsText = '', fxTop = 'keep', fxTopText = '',
      fxBelt = 'keep', fxBeltText = '', fxNecklace = 'keep', fxNecklaceText = '', fxBag = 'keep', fxBagText = '',
      fxCrop = 'none',`, 'server.js');
  s = must(s, `mode !== 'material' && mode !== 'sheetangle' && !entry.product.length`,
             `mode !== 'material' && mode !== 'sheetangle' && mode !== 'modelfix' && !entry.product.length`, 'server.js');
  s = must(s, `    if (mode === 'sheetangle') {`, `    if (mode === 'modelfix') {
      const ITEMS = [
        ['SHOES', 'the shoes the model wears', fxShoes, fxShoesText],
        ['BOTTOMS', 'the bottoms the model wears (pants / jeans / shorts / skirt)', fxBottoms, fxBottomsText],
        ['TOP', 'the top the model wears', fxTop, fxTopText],
        ['BELT', 'the belt', fxBelt, fxBeltText],
        ['NECKLACE', 'the necklace / jewellery', fxNecklace, fxNecklaceText],
        ['BAG', 'the bag', fxBag, fxBagText],
      ];
      const hasRefBoard = ITEMS.some((it) => String(it[2]) === 'ref') && entry.bg;
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
        hasRefBoard ? 'A reference board image is included: it contains labelled sections, each showing one product to use. Copy products ONLY from their named sections; copy nothing else from the board (not its background, not its layout).' : '',
        itemLines.join(' '),
        String(fxCrop) === 'chin' ? 'FRAMING: the final image is cropped so the face is NOT visible — the frame starts just below the chin and shows the body down from there. Do not blur or paint over the face; the crop simply excludes it.' : '',
        'NEVER add or invent any garment, accessory, label or logo that is not in image 1 or explicitly requested above. Colours stay true to life.',
        'Premium e-commerce quality, sharp focus. Output one photorealistic image only.',
      ].filter(Boolean).join(' ');
      if (String(prompt).trim()) instruction += ' Extra instructions: ' + String(prompt).trim();
    } else if (mode === 'sheetangle') {`, 'server.js');
  fs.writeFileSync('server.js', s);
}

// ===================== index.html =====================
let h = fs.readFileSync('public/index.html', 'utf8');
if (!h.includes('modelfixPanel')) {
  h = must(h, `<button type="button" class="tab" data-ws="group">Group split</button>`,
             `<button type="button" class="tab" data-ws="group">Group split</button>
      <button type="button" class="tab" data-ws="modelfix">Model fix</button>`, 'index.html');
  h = must(h, `      <section class="panel" id="groupPanel" hidden>`, `      <section class="panel" id="modelfixPanel" hidden>
        <header class="panel__head"><span class="panel__num">Mf</span><h2>Model fix</h2></header>
        <p class="panel__hint">Upload the lifestyle images of one style/colour (all its angles). Pick what to change — everything else, model included, stays identical. The same changes apply to every image so the set stays consistent.</p>
        <p class="panel__hint" style="margin-bottom:6px">1 · Model images (up to 30)</p>
        <label id="basesDropZone9" class="dropzone" for="basesFileInput" style="margin-bottom:10px">
          <span class="dropzone__icon">＋</span>
          <span class="dropzone__text">Drop model images</span>
          <span class="dropzone__meta">JPG / PNG · the 5–6 angles of this style</span>
        </label>
        <p class="panel__hint" style="margin-bottom:6px">2 · What to change</p>
        <div id="fxItems"></div>
        <div class="spec-row" style="margin-top:10px; margin-bottom:8px">
          <label class="spec-field"><span>Crop</span>
            <select id="fxCropSelect">
              <option value="none" selected>No crop</option>
              <option value="chin">Cut at chin (no face)</option>
            </select>
          </label>
        </div>
        <input id="fxNotesInput" type="text" placeholder="Notes (optional), e.g. remove all tattoos from her hands" style="margin-bottom:8px">
      </section>

      <section class="panel" id="groupPanel" hidden>`, 'index.html');
  fs.writeFileSync('public/index.html', h);
}

// ===================== app.js =====================
let a = fs.readFileSync('public/app.js', 'utf8');
if (!a.includes('modelfixPanel')) {
  a = must(a, `  const groupPanel = document.getElementById('groupPanel');`,
             `  const groupPanel = document.getElementById('groupPanel');
  const modelfixPanel = document.getElementById('modelfixPanel');`, 'app.js');
  a = must(a, `    if (groupPanel) groupPanel.hidden = ws !== 'group';`,
             `    if (groupPanel) groupPanel.hidden = ws !== 'group';
    if (modelfixPanel) modelfixPanel.hidden = ws !== 'modelfix';`, 'app.js');
  a = must(a, ` : workspace === 'bg' ? 'bg' : workspace === 'pose' ? 'pose' : workspace === 'material' ? 'material' : 'swap',`,
             ` : workspace === 'bg' ? 'bg' : workspace === 'pose' ? 'pose' : workspace === 'material' ? 'material' : workspace === 'modelfix' ? 'modelfix' : 'swap',`, 'app.js');
  a = must(a, `    if (workspace !== 'logo' && workspace !== 'recolor' && workspace !== 'bg' && workspace !== 'pose' && workspace !== 'material' && !state.refFiles.length)`,
             `    if (workspace !== 'logo' && workspace !== 'recolor' && workspace !== 'bg' && workspace !== 'pose' && workspace !== 'material' && workspace !== 'modelfix' && !state.refFiles.length)`, 'app.js');
  a = must(a, `      if (workspace === 'material' && state.materialRefFile) fd.append('bg', state.materialRefFile);`,
             `      if (workspace === 'material' && state.materialRefFile) fd.append('bg', state.materialRefFile);
      if (workspace === 'modelfix' && state.fxBoardBlob) fd.append('bg', state.fxBoardBlob, 'reference-board.jpg');`, 'app.js');
  a = must(a, `              topStyle: (topStyleSelect || { value: 'product' }).value, topStyleLabel: (topStyleOther || { value: '' }).value.trim(), swapNotes: (swapNotesInput || { value: '' }).value.trim(),`,
             `              topStyle: (topStyleSelect || { value: 'product' }).value, topStyleLabel: (topStyleOther || { value: '' }).value.trim(), swapNotes: (swapNotesInput || { value: '' }).value.trim(),
              fxShoes: fxOpt('SHOES'), fxShoesText: fxTxt('SHOES'), fxBottoms: fxOpt('BOTTOMS'), fxBottomsText: fxTxt('BOTTOMS'), fxTop: fxOpt('TOP'), fxTopText: fxTxt('TOP'),
              fxBelt: fxOpt('BELT'), fxBeltText: fxTxt('BELT'), fxNecklace: fxOpt('NECKLACE'), fxNecklaceText: fxTxt('NECKLACE'), fxBag: fxOpt('BAG'), fxBagText: fxTxt('BAG'),
              fxCrop: (document.getElementById('fxCropSelect') || { value: 'none' }).value,
              prompt: workspace === 'modelfix' ? ((document.getElementById('fxNotesInput') || { value: '' }).value.trim() + ' ' + (promptInput.value || '').trim()).trim() : undefined,`, 'app.js');
  a = must(a, `  applyWorkspace('angles');
})();`,
`  // --- Model fix: per-item change rows + labelled reference board ---
  window.fxOpt = () => 'keep'; window.fxTxt = () => '';
  (function modelFix() {
    const wrap = document.getElementById('fxItems');
    if (!wrap) return;
    const ITEMS = ['SHOES', 'BOTTOMS', 'TOP', 'BELT', 'NECKLACE', 'BAG'];
    const NICE = { SHOES: 'Shoes', BOTTOMS: 'Bottoms (pants/shorts)', TOP: 'Top', BELT: 'Belt', NECKLACE: 'Necklace', BAG: 'Bag' };
    const st = {};
    ITEMS.forEach((tag) => {
      st[tag] = { opt: 'keep', text: '', file: null };
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap';
      const lab = document.createElement('span'); lab.textContent = NICE[tag]; lab.style.cssText = 'width:150px; flex:none; font-size:13px';
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="keep" selected>Keep</option><option value="ref">Replace — attach image</option><option value="text">Replace — describe</option><option value="remove">Remove</option>';
      const txt = document.createElement('input'); txt.type = 'text'; txt.placeholder = 'Describe it, e.g. Menina high-waist baggy jeans'; txt.style.cssText = 'flex:1; min-width:170px; display:none';
      txt.addEventListener('input', () => { st[tag].text = txt.value; });
      const fileBtn = document.createElement('button'); fileBtn.type = 'button'; fileBtn.textContent = 'Add photo'; fileBtn.style.display = 'none';
      const fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'image/png,image/jpeg,image/webp'; fileIn.hidden = true;
      const thumb = document.createElement('img'); thumb.style.cssText = 'width:40px; height:40px; object-fit:cover; border-radius:5px; display:none';
      fileBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f && f.type.startsWith('image/')) { st[tag].file = f; thumb.src = URL.createObjectURL(f); thumb.style.display = ''; rebuildBoard(); }
        fileIn.value = '';
      });
      sel.addEventListener('change', () => {
        st[tag].opt = sel.value;
        txt.style.display = (sel.value === 'text' || sel.value === 'ref') ? '' : 'none';
        txt.placeholder = sel.value === 'ref' ? 'Optional detail, e.g. worn without socks' : 'Describe it, e.g. Menina high-waist baggy jeans';
        fileBtn.style.display = sel.value === 'ref' ? '' : 'none';
        thumb.style.display = (sel.value === 'ref' && st[tag].file) ? '' : 'none';
        rebuildBoard();
      });
      row.appendChild(lab); row.appendChild(sel); row.appendChild(fileBtn); row.appendChild(thumb); row.appendChild(txt); row.appendChild(fileIn);
      wrap.appendChild(row);
    });
    state.fxBoardBlob = null;
    async function rebuildBoard() {
      const refs = ITEMS.filter((t) => st[t].opt === 'ref' && st[t].file);
      if (!refs.length) { state.fxBoardBlob = null; return; }
      try {
        const W = 900, LABEL_H = 46;
        const imgs = [];
        for (const t of refs) {
          const url = URL.createObjectURL(st[t].file);
          const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
          imgs.push({ tag: t, im, h: Math.round(im.height * W / im.width) });
        }
        const totalH = imgs.reduce((acc, x) => acc + LABEL_H + x.h + 14, 8);
        const cv = document.createElement('canvas'); cv.width = W; cv.height = totalH;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, totalH);
        let y = 8;
        for (const x of imgs) {
          ctx.fillStyle = '#000000'; ctx.font = 'bold 30px Arial';
          ctx.fillText(x.tag, 12, y + 32);
          y += LABEL_H;
          ctx.drawImage(x.im, 0, y, W, x.h);
          ctx.strokeStyle = '#000000'; ctx.lineWidth = 2; ctx.strokeRect(0, y, W, x.h);
          y += x.h + 14;
        }
        state.fxBoardBlob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
      } catch (e) { state.fxBoardBlob = null; }
    }
    window.fxOpt = (tag) => (st[tag] ? st[tag].opt : 'keep');
    window.fxTxt = (tag) => (st[tag] ? String(st[tag].text || '').trim() : '');
  })();

  applyWorkspace('angles');
})();`, 'app.js');
  fs.writeFileSync('public/app.js', a);
}
console.log('patched OK (' + n + ' edits)');
