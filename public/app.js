(() => {
  const VARIANT_NAMES = { 1: 'white', 2: 'grey-f8' };
  const VARIANT_NAMES_STYLE = { 1: 'ref-bg', 2: 'grey-f8' };
  const VARIANT_NAMES_RAW = { 1: 'take-1', 2: 'take-2' };
  const vname = (v) => (postProcessSelect && postProcessSelect.value === 'off') ? (VARIANT_NAMES_RAW[v] || ('take-' + v)) : ((document.getElementById('guideModeSelect') || {}).value === 'style' ? VARIANT_NAMES_STYLE : VARIANT_NAMES)[v] || ('v' + v);
  const state = {
    angleFiles: [],   // File[]
    angleLabels: [],  // string[] parallel to angleFiles
    refFiles: [],     // product photos, File[]
    logoFile: null,
    heelFile: null,
  };

  // ---- DOM refs ----
  const promptInput = document.getElementById('promptInput');

  const angleDropZone = document.getElementById('angleDropZone');
  const angleFileInput = document.getElementById('angleFileInput');
  const angleThumbsEl = document.getElementById('angleThumbs');

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const refPreviewsEl = document.getElementById('refPreviews');
  const logoFileInput = document.getElementById('logoFileInput');
  const logoPreviewEl = document.getElementById('logoPreview');
  function renderLogo() {
    const l2 = document.getElementById('logoPreview2'); if (l2) l2.innerHTML = '';
    logoPreviewEl.innerHTML = '';
    if (!state.logoFile) return;
    const thumb = document.createElement('div'); thumb.className = 'ref-thumb';
    const img = document.createElement('img'); img.src = URL.createObjectURL(state.logoFile); thumb.appendChild(img);
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×';
    rm.addEventListener('click', () => { state.logoFile = null; logoFileInput.value = ''; renderLogo(); });
    thumb.appendChild(rm); logoPreviewEl.appendChild(thumb);
    const l2b = document.getElementById('logoPreview2');
    if (l2b) { const c = thumb.cloneNode(true); c.querySelector('button').addEventListener('click', () => { state.logoFile = null; logoFileInput.value = ''; renderLogo(); }); l2b.appendChild(c); }
  }
  logoFileInput.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f && f.type.startsWith('image/')) { state.logoFile = f; renderLogo(); } });
  const heelFileInput = document.getElementById('heelFileInput');
  const heelPreviewEl = document.getElementById('heelPreview');
  function renderHeel() {
    heelPreviewEl.innerHTML = '';
    if (!state.heelFile) return;
    const thumb = document.createElement('div'); thumb.className = 'ref-thumb';
    const img = document.createElement('img'); img.src = URL.createObjectURL(state.heelFile); thumb.appendChild(img);
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×';
    rm.addEventListener('click', () => { state.heelFile = null; heelFileInput.value = ''; renderHeel(); });
    thumb.appendChild(rm); heelPreviewEl.appendChild(thumb);
  }
  heelFileInput.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f && f.type.startsWith('image/')) { state.heelFile = f; renderHeel(); } });

  const modelSelect = document.getElementById('modelSelect');
  const aspectSelect = document.getElementById('aspectSelect');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const runModeSelect = document.getElementById('runModeSelect');
  const perAngleSelect = document.getElementById('perAngleSelect');
  const guideModeSelect = document.getElementById('guideModeSelect');
  const postProcessSelect = document.getElementById('postProcessSelect');
  const providerTabs = document.getElementById('providerTabs');
  const googlePanel = document.getElementById('googlePanel');
  const googleKeyInput = document.getElementById('googleKeyInput');
  const googleModelSelect = document.getElementById('googleModelSelect');
  const freepikModelField = document.getElementById('freepikModelField');
  let provider = localStorage.getItem('angleStudioProvider') || 'freepik';
  googleKeyInput.value = localStorage.getItem('angleStudioGoogleKey') || '';
  googleKeyInput.addEventListener('input', () => localStorage.setItem('angleStudioGoogleKey', googleKeyInput.value.trim()));
  function applyProvider(p) {
    provider = p;
    localStorage.setItem('angleStudioProvider', p);
    providerTabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.provider === p));
    googlePanel.hidden = p !== 'google';
    freepikModelField.style.display = p === 'google' ? 'none' : '';
  }
  providerTabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) applyProvider(b.dataset.provider); });
  applyProvider(provider);
  const generateBtn = document.getElementById('generateBtn');
  const statusLine = document.getElementById('statusLine');
  const sheetGrid = document.getElementById('sheetGrid');
  const sheetSub = document.getElementById('sheetSub');
  const downloadAllBtn = document.getElementById('downloadAllBtn');

  // ---- Angle reference uploads ----
  function addAngleFiles(fileList) {
    const incoming = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    for (const f of incoming) {
      if (state.angleFiles.length >= 8) break;
      state.angleFiles.push(f);
      state.angleLabels.push(`Angle ${state.angleFiles.length}`);
    }
    renderAngleThumbs();
  }

  function renderAngleThumbs() {
    angleThumbsEl.innerHTML = '';
    state.angleFiles.forEach((file, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'angle-thumb';

      const imgWrap = document.createElement('div');
      imgWrap.className = 'angle-thumb__img';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      const num = document.createElement('span');
      num.className = 'angle-thumb__num';
      num.textContent = String(idx + 1).padStart(2, '0');
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'angle-thumb__remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        state.angleFiles.splice(idx, 1);
        state.angleLabels.splice(idx, 1);
        renderAngleThumbs();
      });
      imgWrap.appendChild(img);
      imgWrap.appendChild(num);
      imgWrap.appendChild(removeBtn);

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = state.angleLabels[idx];
      labelInput.addEventListener('input', () => { state.angleLabels[idx] = labelInput.value; });

      wrap.appendChild(imgWrap);
      wrap.appendChild(labelInput);
      angleThumbsEl.appendChild(wrap);
    });
  }

  angleFileInput.addEventListener('change', (e) => addAngleFiles(e.target.files));
  ['dragover', 'dragenter'].forEach((ev) =>
    angleDropZone.addEventListener(ev, (e) => { e.preventDefault(); angleDropZone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    angleDropZone.addEventListener(ev, (e) => { e.preventDefault(); angleDropZone.classList.remove('dragover'); })
  );
  angleDropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addAngleFiles(e.dataTransfer.files);
  });

  // ---- Product reference upload ----
  function addFiles(fileList) {
    const incoming = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    for (const f of incoming) {
      if (state.refFiles.length >= 6) break;
      state.refFiles.push(f);
    }
    renderRefPreviews();
  }

  function renderRefPreviews() {
    refPreviewsEl.innerHTML = '';
    state.refFiles.forEach((file, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'ref-thumb';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      thumb.appendChild(img);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        state.refFiles.splice(idx, 1);
        renderRefPreviews();
      });
      thumb.appendChild(removeBtn);
      refPreviewsEl.appendChild(thumb);
    });
  }

  fileInput.addEventListener('change', (e) => addFiles(e.target.files));
  ['dragover', 'dragenter'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
  );
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  // ---- Status helper ----
  function setStatus(text, kind) {
    statusLine.textContent = text;
    statusLine.classList.remove('is-error', 'is-ok');
    if (kind) statusLine.classList.add(kind);
  }

  // ---- Contact sheet rendering ----
  const cellRefs = new Map(); // idx -> { cellEl, bodyEl, footEl }

  function renderPlaceholders(labels, perAngle) {
    sheetGrid.innerHTML = '';
    cellRefs.clear();
    downloadAllBtn.hidden = true;

    const jobs = [];
    labels.forEach((label, idx) => { for (let v = 1; v <= perAngle; v++) jobs.push({ label, idx, v }); });
    jobs.forEach(({ label, idx, v }) => {
      const cell = document.createElement('div');
      cell.className = 'cell cell--pending';

      const sprockets = document.createElement('div');
      sprockets.className = 'cell__sprockets';
      for (let i = 0; i < 8; i++) sprockets.appendChild(document.createElement('span'));

      const tag = document.createElement('div');
      tag.className = 'cell__tag';
      tag.innerHTML = `<span class="cell__num">${String(idx + 1).padStart(2, '0')}${perAngle > 1 ? String.fromCharCode(64 + v) : ''}</span><span class="cell__label">${escapeHtml(label)}${perAngle > 1 ? ' · ' + (vname(v)) : ''}</span>`;

      const body = document.createElement('div');
      body.className = 'cell__body';
      body.innerHTML = `<div class="cell__state"><span>queued…</span></div>`;

      const foot = document.createElement('div');
      foot.className = 'cell__foot';
      foot.innerHTML = `<span class="cell__spec">—</span>`;

      cell.appendChild(sprockets);
      cell.appendChild(tag);
      cell.appendChild(body);
      cell.appendChild(foot);
      sheetGrid.appendChild(cell);

      cellRefs.set(`${idx}-${v}`, { cell, body, foot });
    });
  }

  function markActive(idx, v) {
    const refs = cellRefs.get(`${idx}-${v}`);
    if (!refs) return;
    refs.cell.classList.remove('cell--pending');
    refs.cell.classList.add('cell--active');
    refs.body.innerHTML = `<div class="cell__state"><div class="spinner"></div><span>developing…</span></div>`;
  }

  function renderCellResult(idx, v, label, result, aspect, resolution) {
    const refs = cellRefs.get(`${idx}-${v}`);
    if (!refs) return;
    refs.cell.classList.remove('cell--active', 'cell--pending');
    if (result.status === 'COMPLETED' && result.imageUrl) {
      const previewSrc = String(result.imageUrl).startsWith('/api/image/') ? result.imageUrl + '?thumb=1' : result.imageUrl;
      refs.body.innerHTML = `<a href="${result.imageUrl}" target="_blank" rel="noopener"><img src="${previewSrc}" alt="${escapeHtml(label)}"></a>`;
      refs.foot.innerHTML = `
        <span class="cell__spec">${aspect} · ${resolution.toUpperCase()}</span>
        <a class="cell__dl" href="${result.imageUrl}" download="${slug(label)}-${vname(v)}.png" target="_blank" rel="noopener">Save</a>`;
    } else {
      refs.body.innerHTML = `<div class="cell__error">${escapeHtml(result.error || 'Generation failed.')}</div>`;
      refs.foot.innerHTML = `<span class="cell__spec" style="color:var(--rust)">failed</span>`;
    }
  }

  // ---- Generate flow: strictly sequential, angle 1 → 2 → 3 → ... ----
  generateBtn.addEventListener('click', async () => {
    if (typeof workspace !== 'undefined' && workspace !== 'angles') return runEditSet();
    if (!state.angleFiles.length) return setStatus('Upload at least one angle reference photo.', 'is-error');
    if (!state.refFiles.length) return setStatus('Upload at least one reference product photo.', 'is-error');

    generateBtn.disabled = true;
    const aspect = aspectSelect.value;
    const resolution = resolutionSelect.value;
    const model = provider === 'google' ? googleModelSelect.value : modelSelect.value;
    const googleApiKey = googleKeyInput.value.trim();
    if (provider === 'google' && !googleApiKey) return setStatus('Paste your Google API key first.', 'is-error');
    const prompt = promptInput.value.trim();

    try {
      setStatus('Uploading angle + product photos…');
      const formData = new FormData();
      state.refFiles.forEach((f) => formData.append('product', f));
      if (state.logoFile) formData.append('logo', state.logoFile);
      if (state.heelFile) formData.append('heel', state.heelFile);
      state.angleFiles.forEach((f) => formData.append('angles', f));
      const refRes = await fetch('/api/reference', { method: 'POST', body: formData });
      const refData = await refRes.json();
      if (!refRes.ok) throw new Error(refData.error || 'Upload failed.');
      const referenceId = refData.referenceId;

      const labels = state.angleLabels.slice();
      const perAngle = Number(perAngleSelect.value) || 1;
      const runMode = runModeSelect.value;
      const guideMode = guideModeSelect.value;
      renderPlaceholders(labels, perAngle);

      const jobs = [];
      labels.forEach((label, idx) => { for (let v = 1; v <= perAngle; v++) jobs.push({ label, idx, v }); });
      const total = jobs.length;
      let okCount = 0, doneCount = 0;
      const finished = [];
      sheetSub.innerHTML = `Developing <em>${total}</em> frames (${runMode === 'parallel' ? 'all at once' : 'one at a time'})…`;

      async function runJob({ label, idx, v }) {
        markActive(idx, v);
        let result;
        try {
          const r = await fetch('/api/generate-angle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ referenceId, prompt, angleIndex: idx, angleLabel: label, variant: v, aspectRatio: aspect, resolution, model, guideMode, provider, googleApiKey, postProcess: postProcessSelect.value }),
          });
          result = await r.json();
        } catch (e) {
          result = { status: 'FAILED', error: e.message };
        }
        doneCount++;
        renderCellResult(idx, v, label, result, aspect, resolution);
        if (result.status === 'COMPLETED') { okCount++; finished.push({ label: `${label}-${vname(v)}`, url: result.imageUrl }); }
        setStatus(`Developed ${doneCount} of ${total}…`);
      }

      if (runMode === 'parallel') {
        setStatus(`Developing all ${total} frames at once…`);
        await Promise.all(jobs.map(runJob));
      } else {
        for (const job of jobs) {
          setStatus(`Developing ${job.label} (${job.v}/${perAngle})…`);
          await runJob(job);
        }
      }

      sheetSub.textContent = `${okCount} of ${total} frames developed.`;

      if (finished.length) {
        downloadAllBtn.hidden = false;
        downloadAllBtn.onclick = () => downloadAll(finished);
        setStatus(`Done — ${okCount} of ${total} frames ready.`, 'is-ok');
      } else {
        setStatus('All frames failed — check the errors above and your .env API key.', 'is-error');
      }
    } catch (err) {
      setStatus(err.message || 'Something went wrong.', 'is-error');
    } finally {
      generateBtn.disabled = false;
    }
  });

  async function downloadAll(images) {
    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = 'Zipping…';
    try {
      const res = await fetch('/api/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      if (!res.ok) throw new Error('Could not build zip.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'product-angle-set.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setStatus(e.message, 'is-error');
    } finally {
      downloadAllBtn.disabled = false;
      downloadAllBtn.textContent = 'Download all (.zip)';
    }
  }

  // ---- utils ----
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  // ================= Workspaces: Lifestyle swap & Prompt lab =================
  let workspace = 'angles';
  const workspaceTabs = document.getElementById('workspaceTabs');
  const lifestylePanel = document.getElementById('lifestylePanel');
  const freePanel = document.getElementById('freePanel');
  const logoPanel = document.getElementById('logoPanel');
  const apparelPanel = document.getElementById('apparelPanel');
  const bgFileInput = document.getElementById('bgFileInput');
  const bgPreviewEl = document.getElementById('bgPreview');
  state.bgFile = null;
  function renderBg() {
    bgPreviewEl.innerHTML = '';
    if (!state.bgFile) return;
    const t = document.createElement('div'); t.className = 'ref-thumb';
    const img = document.createElement('img'); img.src = URL.createObjectURL(state.bgFile); t.appendChild(img);
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×';
    rm.addEventListener('click', () => { state.bgFile = null; bgFileInput.value = ''; renderBg(); });
    t.appendChild(rm); bgPreviewEl.appendChild(t);
  }
  bgFileInput.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f && f.type.startsWith('image/')) { state.bgFile = f; renderBg(); } });
  const labelsFileInput = document.getElementById('labelsFileInput');
  const labelsPreviewEl = document.getElementById('labelsPreview');
  state.labelFiles = [];
  function renderLabels() {
    labelsPreviewEl.innerHTML = '';
    state.labelFiles.forEach((file, idx) => {
      const t = document.createElement('div'); t.className = 'ref-thumb';
      const img = document.createElement('img'); img.src = URL.createObjectURL(file); t.appendChild(img);
      const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×';
      rm.addEventListener('click', () => { state.labelFiles.splice(idx, 1); renderLabels(); });
      t.appendChild(rm); labelsPreviewEl.appendChild(t);
    });
  }
  labelsFileInput.addEventListener('change', (e) => { for (const f of Array.from(e.target.files)) { if (state.labelFiles.length >= 4) break; if (f.type.startsWith('image/')) state.labelFiles.push(f); } renderLabels(); });
  const anglePanel = document.querySelector('#angleThumbs') ? document.querySelector('#angleThumbs').closest('section') : null;
  const categorySelect = document.getElementById('categorySelect');
  const categoryOther = document.getElementById('categoryOther');
  const basesFileInput = document.getElementById('basesFileInput');
  const basesThumbsHost = document.getElementById('basesThumbsHost');
  const freePromptInput = document.getElementById('freePromptInput');
  const mentionMenu = document.getElementById('mentionMenu');
  state.baseFiles = [];

  categorySelect.addEventListener('change', () => { categoryOther.style.display = categorySelect.value === 'other' ? '' : 'none'; });

  function renderBases() {
    basesThumbsHost.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'angle-previews';
    state.baseFiles.forEach((file, idx) => {
      const t = document.createElement('div'); t.className = 'angle-thumb';
      const iw = document.createElement('div'); iw.className = 'angle-thumb__img';
      const img = document.createElement('img'); img.src = URL.createObjectURL(file);
      const num = document.createElement('span'); num.className = 'angle-thumb__num'; num.textContent = String(idx + 1).padStart(2, '0');
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'angle-thumb__remove'; rm.textContent = '×';
      rm.addEventListener('click', () => { state.baseFiles.splice(idx, 1); renderBases(); });
      iw.appendChild(img); iw.appendChild(num); iw.appendChild(rm);
      t.appendChild(iw); wrap.appendChild(t);
    });
    basesThumbsHost.appendChild(wrap);
    basesThumbsHost.style.display = workspace === 'angles' ? 'none' : '';
  }
  basesFileInput.addEventListener('change', (e) => {
    for (const f of Array.from(e.target.files)) { if (state.baseFiles.length >= 30) break; if (f.type.startsWith('image/')) state.baseFiles.push(f); }
    renderBases();
  });

  function applyWorkspace(ws) {
    workspace = ws;
    workspaceTabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.ws === ws));
    lifestylePanel.hidden = ws !== 'lifestyle';
    freePanel.hidden = ws !== 'free';
    logoPanel.hidden = ws !== 'logo';
    apparelPanel.hidden = ws !== 'apparel';
    const productSection = refPreviewsEl.closest('section');
    const briefSection = promptInput.closest('section');
    const hideEl = (el, hide) => { if (el) el.style.display = hide ? 'none' : ''; };
    const fieldOf = (sel) => (sel && sel.closest ? sel.closest('.spec-field') : null);
    const minimal = ws === 'logo';
    hideEl(productSection, minimal);
    hideEl(briefSection, minimal);
    hideEl(fieldOf(guideModeSelect), minimal);
    hideEl(fieldOf(postProcessSelect), minimal);
    hideEl(fieldOf(perAngleSelect), minimal);
    hideEl(fieldOf(aspectSelect), minimal);
    if (anglePanel) anglePanel.style.display = ws === 'angles' ? '' : 'none';
    renderBases();
    sheetSub.textContent = ws === 'angles'
      ? 'Add angle references and a product photo, then press Develop set.'
      : ws === 'lifestyle' ? 'Add lifestyle photos + product photos, then press Develop set.'
      : ws === 'logo' ? 'Add product images + your logo, then press Develop set.'
      : ws === 'apparel' ? 'Add angle/style references, product photos and your logo, then press Develop set.'
      : 'Add sample photos + product photos, write your prompt, then press Develop set.';
  }
  workspaceTabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) applyWorkspace(b.dataset.ws); });

  // @ mention menu for the Prompt lab
  freePromptInput.addEventListener('input', () => {
    const pos = freePromptInput.selectionStart;
    const before = freePromptInput.value.slice(0, pos);
    if (!before.endsWith('@')) { mentionMenu.hidden = true; return; }
    mentionMenu.innerHTML = '';
    const add = (label) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.addEventListener('click', () => {
        const v = freePromptInput.value;
        freePromptInput.value = v.slice(0, pos - 1) + label + ' ' + v.slice(pos);
        mentionMenu.hidden = true; freePromptInput.focus();
      });
      mentionMenu.appendChild(b);
    };
    state.baseFiles.forEach((_, i) => add('sample photo ' + (i + 1)));
    state.refFiles.forEach((_, i) => add('product photo ' + (i + 1)));
    if (!mentionMenu.childElementCount) { mentionMenu.hidden = true; return; }
    const r = freePromptInput.getBoundingClientRect();
    mentionMenu.style.left = r.left + 'px';
    mentionMenu.style.top = (r.bottom + 4) + 'px';
    mentionMenu.hidden = false;
  });
  document.addEventListener('click', (e) => { if (!mentionMenu.contains(e.target) && e.target !== freePromptInput) mentionMenu.hidden = true; });

  async function runEditSet() {
    // APPAREL_EDIT_V2: apparel edits each product photo; style refs are optional
    if (workspace !== 'apparel' && !state.baseFiles.length) return setStatus(workspace === 'lifestyle' ? 'Upload lifestyle photos first.' : workspace === 'logo' ? 'Upload the product images to edit.' : 'Upload sample photos first.', 'is-error');
    if (workspace === 'logo' && !state.logoFile) return setStatus('Upload your logo (Brand logo upload).', 'is-error');
    if (workspace !== 'logo' && !state.refFiles.length) return setStatus('Upload product photos too.', 'is-error');
    if (workspace === 'free' && !freePromptInput.value.trim()) return setStatus('Write your prompt (type @ to reference photos).', 'is-error');
    generateBtn.disabled = true;
    const resolution = resolutionSelect.value;
    const model = provider === 'google' ? googleModelSelect.value : modelSelect.value;
    const googleApiKey = googleKeyInput.value.trim();
    if (provider === 'google' && !googleApiKey) { generateBtn.disabled = false; return setStatus('Paste your Google API key first.', 'is-error'); }
    try {
      setStatus('Uploading photos…');
      const fd = new FormData();
      state.refFiles.forEach((f) => fd.append('product', f));
      state.baseFiles.forEach((f) => fd.append('bases', f));
      if (state.logoFile) fd.append('logo', state.logoFile);
      if (state.heelFile) fd.append('heel', state.heelFile);
      if (workspace === 'apparel' && state.bgFile) fd.append('bg', state.bgFile);
      if (workspace === 'apparel') state.labelFiles.forEach((f) => fd.append('labels', f));
      const r = await fetch('/api/reference', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload failed.');
      const referenceId = d.referenceId;

      const perAngle = workspace === 'logo' ? 1 : (Number(perAngleSelect.value) || 1);
      const labels = workspace === 'apparel' ? state.refFiles.map((_, i) => 'Product ' + (i + 1)) : state.baseFiles.map((_, i) => 'Photo ' + (i + 1));
      renderPlaceholders(labels, perAngle);
      const jobs = [];
      labels.forEach((label, idx) => { for (let v = 1; v <= perAngle; v++) jobs.push({ label, idx, v }); });
      let done = 0, ok = 0; const finished = [];
      sheetSub.innerHTML = 'Developing <em>' + jobs.length + '</em> frames…';
      const runJob = async ({ label, idx, v }) => {
        markActive(idx, v);
        let result;
        try {
          const resp = await fetch('/api/edit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              referenceId, baseIndex: idx, variant: v, resolution, provider, model, googleApiKey, aspectRatio: aspectSelect.value,
              brandText: (document.getElementById('brandTextInput') || { value: '' }).value, labelOverlay: (document.getElementById('labelOverlaySelect') || { value: 'on' }).value, logoMode: (document.getElementById('logoModeSelect') || { value: 'replace' }).value,
              mode: workspace === 'free' ? 'free' : workspace === 'logo' ? 'logo' : workspace === 'apparel' ? 'apparel' : 'swap',
              logoColor: (document.getElementById('logoColorSelect') || { value: 'white' }).value,
              category: categorySelect.value, categoryLabel: categoryOther.value.trim(),
              prompt: workspace === 'free' ? freePromptInput.value.trim() : (promptInput.value || '').trim(),
            }),
          });
          result = await resp.json();
        } catch (e) { result = { status: 'FAILED', error: e.message }; }
        done++;
        renderCellResult(idx, v, label, result, aspectSelect.value, resolution);
        if (result.status === 'COMPLETED') { ok++; finished.push({ label: label + '-' + v, url: result.imageUrl }); }
        setStatus('Developed ' + done + ' of ' + jobs.length + '…');
      };
      if (runModeSelect.value === 'parallel') await Promise.all(jobs.map(runJob));
      else for (const j of jobs) await runJob(j);
      sheetSub.textContent = ok + ' of ' + jobs.length + ' frames developed.';
      if (finished.length) { downloadAllBtn.hidden = false; downloadAllBtn.onclick = () => downloadAll(finished); setStatus('Done — ' + ok + ' of ' + jobs.length + ' ready.', 'is-ok'); }
      else setStatus('All frames failed — check the errors above.', 'is-error');
    } catch (err) {
      setStatus(err.message || 'Something went wrong.', 'is-error');
    } finally {
      generateBtn.disabled = false;
    }
  }

  applyWorkspace('angles');
})();