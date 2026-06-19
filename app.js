// EDM Builder — slice editor
// Pure browser app. No build step. Dependencies: JSZip (CDN).
// Supports PSD, PNG, JPG, TIFF, WebP, BMP, GIF, SVG input.
// PSD decoded via ag-psd (lazy-loaded). TIFF decoded via UTIF.js (lazy-loaded).

const state = {
  image: null,             // HTMLImageElement of the source EDM
  imageDataUrl: null,      // base64 data URL — persisted to IndexedDB
  imageName: 'edm',        // base filename for export
  projectName: '',         // user-chosen project label
  slices: [],              // [{id, x, y, w, h, href, alt, color}]
  drawing: null,           // {startX, startY} while user drags
  nextId: 1,
  annotations: [],         // [{id, x, y, text, fontSize, color, bg, bold, italic}]
  nextAnnotId: 1,
  lastSavedAt: null,
};
let toolMode = 'draw'; // 'draw' | 'text' | 'eyedropper'
let pickedColor = null; // hex string from eyedropper

// ---- Video thumbnail detection & caching ----
const thumbCache = {}; // url → { img: HTMLImageElement, status: 'loading'|'ready'|'error' }

function getVideoThumbUrl(url) {
  if (!url) return null;
  let m;
  // YouTube: various URL formats
  m = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  // Vimeo: numeric ID
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return `https://vumbnail.com/${m[1]}.jpg`;
  // Dailymotion
  m = url.match(/dailymotion\.com\/video\/([\w]+)/);
  if (m) return `https://www.dailymotion.com/thumbnail/video/${m[1]}`;
  return null;
}

function fetchThumb(url, onReady) {
  const thumbUrl = getVideoThumbUrl(url);
  if (!thumbUrl) return null;
  if (thumbCache[thumbUrl]) {
    if (thumbCache[thumbUrl].status === 'ready') return thumbCache[thumbUrl].img;
    return null;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  thumbCache[thumbUrl] = { img, status: 'loading' };
  img.onload = () => { thumbCache[thumbUrl].status = 'ready'; if (onReady) onReady(); };
  img.onerror = () => { thumbCache[thumbUrl].status = 'error'; };
  img.src = thumbUrl;
  return null;
}

function getThumbForSlice(slice) {
  if (!slice.href) return null;
  if (!slice.useThumb) return null; // opt-in per slice — default keeps the original design art
  const thumbUrl = getVideoThumbUrl(slice.href);
  if (!thumbUrl) return null;
  const entry = thumbCache[thumbUrl];
  if (entry && entry.status === 'ready') return entry.img;
  if (!entry) fetchThumb(slice.href, () => redrawOverlay());
  return null;
}
window.getVideoThumbUrl = getVideoThumbUrl;
window.getThumbForSlice = getThumbForSlice;

// ---- Autosave to IndexedDB (no size limit — handles large images) ----
const IDB_NAME = 'edm-builder';
const IDB_VERSION = 1;
const IDB_STORE = 'projects';
const IDB_KEY = 'current';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  if (!state.image || !state.imageDataUrl) return;
  try {
    const payload = {
      version: 3,
      savedAt: new Date().toISOString(),
      projectName: state.projectName,
      imageName: state.imageName,
      imageDataUrl: state.imageDataUrl,
      slices: state.slices,
      nextId: state.nextId,
      annotations: state.annotations,
      nextAnnotId: state.nextAnnotId,
      exportSettings: getExportSettingsSnapshot(),
    };
    const db = await openIDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(payload, IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
    state.lastSavedAt = payload.savedAt;
    updateSaveIndicator();
  } catch (err) {
    console.warn('Autosave failed:', err);
    updateSaveIndicator('error');
  }
}

function updateSaveIndicator(status) {
  const el = document.getElementById('saveIndicator');
  if (!el) return;
  if (status === 'error') {
    el.textContent = '⚠ Autosave failed';
    el.className = 'save-indicator error';
  } else if (state.lastSavedAt) {
    const t = new Date(state.lastSavedAt);
    el.textContent = '✓ Saved ' + t.toLocaleTimeString();
    el.className = 'save-indicator ok';
  } else {
    el.textContent = '';
    el.className = 'save-indicator';
  }
}

async function loadSavedProject() {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch (err) {
    return null;
  }
}

function restoreFromSaved(saved) {
  const img = new Image();
  img.onerror = () => {
    alert('Failed to load saved image — the project data may be corrupted.');
    console.error('restoreFromSaved: Image failed to load from saved dataURL');
  };
  img.onload = () => {
    state.image = img;
    state.imageDataUrl = saved.imageDataUrl;
    state.imageName = saved.imageName || 'edm';
    state.projectName = saved.projectName || '';
    state.slices = saved.slices || [];
    state.nextId = saved.nextId || (state.slices.length + 1);
    state.annotations = saved.annotations || [];
    state.nextAnnotId = saved.nextAnnotId || (state.annotations.length + 1);
    state.lastSavedAt = saved.savedAt;
    canvas.width = overlay.width = img.naturalWidth;
    canvas.height = overlay.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    dropZone.style.display = 'none';
    canvasWrap.classList.remove('hidden');
    exportForBtn.disabled = false;
    previewBtn.disabled = false;
    clearBtn.disabled = false;
    zoomControls.style.display = '';
    zoomIdx = 3;
    applyZoom();
    if (img.naturalWidth > canvasScroll.clientWidth - 40) fitToWidth();
    document.getElementById('projectNameInput').value = state.projectName;
    document.getElementById('exportSettings').style.display = '';
    document.getElementById('annotationsPanel').style.display = '';
    if (saved.exportSettings) restoreExportSettings(saved.exportSettings);
    if (!saved.exportSettings || !saved.exportSettings.bodyBgColor) autoDetectBodyBg();
    updateExportDimInfo();
    updateQualityBadge();
    renderSliceList();
    renderAnnotList();
    redrawOverlay();
    runLint();
    renderRowSummary();
    updateSteps();
    updateSaveIndicator();
  };
  img.src = saved.imageDataUrl;
}

async function clearSavedProject() {
  try {
    const db = await openIDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch (err) {}
  // Clean up old localStorage entry from v0.2
  try { localStorage.removeItem('edm-builder:v1:project'); } catch(e) {}
}

const colors = ['#ff9900', '#0a84ff', '#34c759', '#ff375f', '#bf5af2', '#ffd60a', '#5ac8fa', '#ff9f0a'];

// ---- Multi-format input: lazy-load external decoders ----
const _loadedScripts = {};
function loadExternalScript(url, globalName) {
  if (_loadedScripts[url]) return _loadedScripts[url];
  const p = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
      if (globalName && !window[globalName]) {
        reject(new Error(`Library loaded but ${globalName} not found on window`));
      } else {
        resolve();
      }
    };
    script.onerror = () => reject(new Error(`Failed to load library from ${url}. Check your internet connection.`));
    document.head.appendChild(script);
  });
  // Cache the promise, but clear it on failure so user can retry
  _loadedScripts[url] = p;
  p.catch(() => { delete _loadedScripts[url]; });
  return p;
}

function getFileFormat(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (ext === 'psd') return 'psd';
  if (ext === 'tif' || ext === 'tiff') return 'tiff';
  if (file.type.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif'].includes(ext)) return 'native';
  return null;
}

function showDecodeOverlay(msg) {
  const el = document.getElementById('decodeOverlay');
  if (!el) return;
  el.querySelector('.decode-msg').textContent = msg || 'Decoding…';
  el.classList.remove('hidden');
}

function hideDecodeOverlay() {
  const el = document.getElementById('decodeOverlay');
  if (el) el.classList.add('hidden');
}

// Decode PSD file → PNG data URL (lossless) via ag-psd
async function decodePSD(file) {
  if (!window.agPsd) {
    await loadExternalScript('https://cdn.jsdelivr.net/npm/ag-psd@30.1.1/dist/bundle.js', 'agPsd');
    // Initialize canvas factory for browser DOM
    window.agPsd.initializeCanvas((w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    });
  }
  const buffer = await file.arrayBuffer();
  // Pass ArrayBuffer directly — ag-psd accepts both ArrayBuffer and Uint8Array.
  // Avoids doubling memory with an unnecessary Uint8Array wrapper for large PSDs.
  const psd = window.agPsd.readPsd(buffer);
  if (!psd.canvas) throw new Error('PSD file has no composite image — please flatten layers and re-save.');
  // Convert composite canvas to lossless PNG data URL
  return new Promise((resolve, reject) => {
    psd.canvas.toBlob(blob => {
      if (!blob) { reject(new Error('Failed to render PSD composite image.')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

// Decode TIFF file → PNG data URL (lossless) via UTIF.js
async function decodeTIFF(file) {
  if (!window.UTIF) {
    await loadExternalScript('https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js', 'UTIF');
  }
  const buffer = await file.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  if (!ifds || !ifds.length) throw new Error('TIFF file contains no images.');
  UTIF.decodeImage(buffer, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const w = ifds[0].width;
  const h = ifds[0].height;
  if (!w || !h) throw new Error('TIFF image has zero width or height.');
  const expectedLen = w * h * 4;
  // Render RGBA pixel data onto a canvas (use rgba directly — safe for any typed array)
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const tctx = c.getContext('2d');
  const imgData = tctx.createImageData(w, h);
  // Ensure we copy exactly the right number of bytes (guards against offset views)
  const src = rgba.length >= expectedLen ? rgba.subarray(0, expectedLen) : rgba;
  imgData.data.set(src);
  tctx.putImageData(imgData, 0, 0);
  // Convert to lossless PNG data URL
  return c.toDataURL('image/png');
}

function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ---- DOM refs ----
const fileInput   = document.getElementById('fileInput');
const dropZone    = document.getElementById('dropZone');
const canvasWrap  = document.getElementById('canvasWrap');
const canvas      = document.getElementById('canvas');
const overlay     = document.getElementById('overlay');
const ctx         = canvas.getContext('2d');
const octx        = overlay.getContext('2d');
const sliceList   = document.getElementById('sliceList');
const sliceCount  = document.getElementById('sliceCount');
const lintList    = document.getElementById('lintList');
const exportForBtn = document.getElementById('exportForBtn');
const exportMenu   = document.getElementById('exportMenu');
const previewBtn  = document.getElementById('previewBtn');
const clearBtn    = document.getElementById('clearBtn');
const howto       = document.getElementById('howto');
const magnifierWrap = document.getElementById('magnifierWrap');
const magnifier     = document.getElementById('magnifier');
const magCtx        = magnifier.getContext('2d');
const magLabel      = document.getElementById('magLabel');
const stepEls     = [null,
  document.getElementById('step1'),
  document.getElementById('step2'),
  document.getElementById('step3'),
  document.getElementById('step4'),
];

// ---- Step indicator (highlight current step based on state) ----
function updateSteps() {
  // Reset all
  for (let i = 1; i <= 4; i++) {
    stepEls[i].classList.remove('active', 'done');
  }

  if (!state.image) {
    // Step 1 active: needs upload
    stepEls[1].classList.add('active');
    return;
  }

  stepEls[1].classList.add('done');

  if (state.slices.length === 0) {
    // Step 2 active: needs to draw a slice
    stepEls[2].classList.add('active');
    return;
  }

  stepEls[2].classList.add('done');

  // Only image slices need URLs — text-block slices don't have link inputs
  const imageSlicesWithoutUrl = state.slices.filter(s => s.type !== 'text' && !s.href).length;
  if (imageSlicesWithoutUrl > 0) {
    // Step 3 active: needs to paste URLs
    stepEls[3].classList.add('active');
    return;
  }

  stepEls[3].classList.add('done');
  // Step 4 active: ready to export
  stepEls[4].classList.add('active');
}

// Initialize stepper
updateSteps();

// ---- Project name wiring ----
const projectNameInput = document.getElementById('projectNameInput');

projectNameInput.addEventListener('input', () => {
  state.projectName = projectNameInput.value;
  scheduleSave();
});

// Note: the autosaved project is restored at boot (see bootRestore at the
// bottom of this file). clearSavedProject() remains available for explicit resets.

// ---- Zoom & pan ----
const canvasScroll = document.getElementById('canvasScroll');
const zoomControls = document.getElementById('zoomControls');
const zoomLevelEl  = document.getElementById('zoomLevel');
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
let zoomIdx = 3; // 100%

function applyZoom() {
  const z = ZOOM_LEVELS[zoomIdx];
  canvasWrap.style.transform = `scale(${z})`;
  canvasWrap.style.width = (canvas.width * z) + 'px';
  canvasWrap.style.height = (canvas.height * z) + 'px';
  zoomLevelEl.textContent = Math.round(z * 100) + '%';
}
function fitToWidth() {
  if (!state.image) return;
  const containerW = canvasScroll.clientWidth - 40;
  const ratio = containerW / canvas.width;
  // pick closest preset that doesn't exceed available width
  let idx = 0;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    if (ZOOM_LEVELS[i] <= ratio) idx = i;
  }
  zoomIdx = idx;
  applyZoom();
}
document.getElementById('zoomIn').addEventListener('click', () => {
  if (zoomIdx < ZOOM_LEVELS.length - 1) { zoomIdx++; applyZoom(); }
});
document.getElementById('zoomOut').addEventListener('click', () => {
  if (zoomIdx > 0) { zoomIdx--; applyZoom(); }
});
document.getElementById('zoomFit').addEventListener('click', fitToWidth);
document.addEventListener('keydown', e => {
  // Escape closes any open modal
  if (e.key === 'Escape') {
    if (!previewModal.classList.contains('hidden')) { previewModal.classList.add('hidden'); return; }
    if (!afterExportModal.classList.contains('hidden')) { afterExportModal.classList.add('hidden'); return; }
  }
  if (e.target.matches('input, textarea, select')) return;
  // Ctrl+Z = Undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); doUndo(); return; }
  if (e.key === '+' || e.key === '=') { if (zoomIdx < ZOOM_LEVELS.length - 1) { zoomIdx++; applyZoom(); } }
  else if (e.key === '-' || e.key === '_') { if (zoomIdx > 0) { zoomIdx--; applyZoom(); } }
  else if (e.key === '0') { fitToWidth(); }
  else if (e.key === 's' || e.key === 'S') { setToolMode('draw'); }
  else if (e.key === 't' || e.key === 'T') { setToolMode('text'); }
  else if (e.key === 'i' || e.key === 'I') { setToolMode('eyedropper'); }
});

// ---- Tool mode toggle (Slice / Text) ----
const toolModeEl = document.getElementById('toolMode');
toolModeEl.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => setToolMode(btn.dataset.tool));
});
function setToolMode(mode) {
  toolMode = mode;
  toolModeEl.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === mode));
  overlay.style.cursor = mode === 'text' ? 'text' : mode === 'eyedropper' ? 'copy' : 'crosshair';
}

// Picked color: click to copy hex
document.getElementById('pickedColor').addEventListener('click', () => {
  if (pickedColor) {
    navigator.clipboard.writeText(pickedColor).catch(() => {});
    const el = document.getElementById('pickedHex');
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1000);
  }
});

// Space-to-pan
let isSpaceDown = false;
let panState = null;
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.target.matches('input, textarea')) {
    isSpaceDown = true;
    canvasScroll.classList.add('panning');
    overlay.style.pointerEvents = 'none';
    e.preventDefault();
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    isSpaceDown = false;
    canvasScroll.classList.remove('panning', 'active');
    overlay.style.pointerEvents = '';
    panState = null;
  }
});
canvasScroll.addEventListener('mousedown', e => {
  if (!isSpaceDown) return;
  canvasScroll.classList.add('active');
  panState = { x: e.clientX, y: e.clientY, sl: canvasScroll.scrollLeft, st: canvasScroll.scrollTop };
});
document.addEventListener('mousemove', e => {
  if (!panState) return;
  canvasScroll.scrollLeft = panState.sl - (e.clientX - panState.x);
  canvasScroll.scrollTop  = panState.st - (e.clientY - panState.y);
});
document.addEventListener('mouseup', () => {
  if (panState) { panState = null; canvasScroll.classList.remove('active'); }
});

// ---- Image loading ----
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = ''; // reset so same file can be re-selected
});

['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
  e.preventDefault(); dropZone.classList.add('dragover');
}));
['dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', e => {
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

// Brief, non-blocking success notification toast (auto-dismisses).
function showToast(msg, ms = 4500) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
    'display:flex;align-items:center;gap:11px;' +
    'background:#ffffff;color:#0f172a;padding:13px 20px 13px 16px;border-radius:12px;' +
    'border:1px solid #d1fadf;border-left:5px solid #10b981;' +
    'font:500 13px Inter,-apple-system,Segoe UI,Arial,sans-serif;' +
    'box-shadow:0 10px 34px rgba(16,185,129,.22);z-index:9999;max-width:560px;' +
    'opacity:0;transition:opacity .25s ease;';
  const icon = document.createElement('span');
  icon.textContent = '✓';
  icon.style.cssText = 'flex-shrink:0;width:24px;height:24px;border-radius:50%;' +
    'background:#10b981;color:#fff;font-weight:700;font-size:14px;' +
    'display:flex;align-items:center;justify-content:center;';
  const text = document.createElement('span');
  text.textContent = msg;
  t.appendChild(icon); t.appendChild(text);
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, ms);
}

// Auto-downscale oversized images on import so the editor stays responsive and
// exports don't fail. Email output is ≤800px wide, so a working copy capped at
// ~1500px wide preserves full visual quality. Returns the originals untouched
// for normal-sized images. Draws directly to the target-size canvas, so no
// giant intermediate canvas is ever allocated.
function downscaleIfHuge(img, dataUrl) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const MAX_W = 1500, MAX_H = 10000, MAX_AREA = 16000000;
  const scale = Math.min(1, MAX_W / w, MAX_H / h, Math.sqrt(MAX_AREA / (w * h)));
  if (!(scale < 1)) return Promise.resolve({ image: img, dataUrl, scaled: false });

  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  // Keep alpha for formats that support it; matte others on white so a JPEG
  // re-encode never turns transparent areas black.
  const keepsAlpha = /^data:image\/(png|webp|gif)/i.test(dataUrl || '');
  if (!keepsAlpha) { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, tw, th); }
  cx.drawImage(img, 0, 0, w, h, 0, 0, tw, th);
  const outUrl = keepsAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);

  return new Promise((resolve) => {
    const ni = new Image();
    ni.onload = () => resolve({ image: ni, dataUrl: outUrl, scaled: true, from: [w, h], to: [tw, th] });
    ni.onerror = () => resolve({ image: img, dataUrl, scaled: false }); // fall back to original
    ni.src = outUrl;
  });
}

async function loadFile(file) {
  const fmt = getFileFormat(file);
  if (!fmt) {
    alert('Unsupported file format.\n\nSupported: PSD, PNG, JPG, TIFF, WebP, BMP, GIF, SVG.');
    return;
  }
  // Uploading a new image supersedes any pending "restore previous project" offer.
  const rb = document.getElementById('restoreBanner');
  if (rb) rb.remove();

  state.imageName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/gi, '_') || 'edm';
  let dataUrl;

  try {
    if (fmt === 'psd') {
      showDecodeOverlay('Decoding PSD file — loading Photoshop decoder…');
      dataUrl = await decodePSD(file);
      hideDecodeOverlay();
    } else if (fmt === 'tiff') {
      showDecodeOverlay('Decoding TIFF file — loading TIFF decoder…');
      dataUrl = await decodeTIFF(file);
      hideDecodeOverlay();
    } else {
      // Native browser format — read directly as data URL (lossless)
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsDataURL(file);
      });
    }
  } catch (err) {
    hideDecodeOverlay();
    alert('Failed to decode file: ' + err.message);
    console.error('File decode error:', err);
    return;
  }

  // Load decoded data into Image element (full resolution, no quality loss)
  const img = new Image();
  img.onerror = () => {
    alert('Failed to load image — the file may be corrupted or unsupported.');
  };
  img.onload = async () => {
    // Auto-downscale very large images so the editor stays responsive and
    // exports don't fail. No-op for normal-sized images.
    const fit = await downscaleIfHuge(img, dataUrl);
    const baseImg = fit.image;
    state.image = baseImg;
    state.imageDataUrl = fit.dataUrl;
    state.slices = [];
    state.nextId = 1;
    canvas.width = overlay.width = baseImg.naturalWidth;
    canvas.height = overlay.height = baseImg.naturalHeight;
    ctx.drawImage(baseImg, 0, 0);
    dropZone.classList.add('hidden') || (dropZone.style.display = 'none');
    canvasWrap.classList.remove('hidden');
    exportForBtn.disabled = false;
    previewBtn.disabled = false;
    clearBtn.disabled = false;
    zoomControls.style.display = '';
    zoomIdx = 3;
    applyZoom();
    // Auto-fit if image is too wide for the workspace
    if (img.naturalWidth > canvasScroll.clientWidth - 40) fitToWidth();
    document.getElementById('exportSettings').style.display = '';
    document.getElementById('annotationsPanel').style.display = '';
    state.annotations = [];
    state.nextAnnotId = 1;
    autoDetectBodyBg();
    updateExportDimInfo();
    updateQualityBadge();
    scheduleSave();
    renderSliceList();
    renderAnnotList();
    runLint();
    renderRowSummary();
    updateSteps();
    if (fit.scaled) {
      showToast(`Image loaded. Optimized for fast editing (${fit.from[0]}×${fit.from[1]} → ${fit.to[0]}×${fit.to[1]} px) — export quality is unaffected.`);
    }
  };
  img.src = dataUrl;
}

// ---- Slice drawing on overlay ----
// Prevent browser from natively dragging the canvas image
canvas.addEventListener('dragstart', e => e.preventDefault());
overlay.addEventListener('dragstart', e => e.preventDefault());

// ---- Cursor tracking, edge snapping, crosshair guides ----
let cursorPos = null; // {x, y} in image coordinates — drives crosshair + coordinate display
const SNAP_DIST = 10; // pixels — snap to guides when within this distance
let activeSnapLines = { x: [], y: [] }; // currently snapped guide positions for visual feedback

function collectGuides(excludeSlice) {
  const xGuides = [0, overlay.width];
  const yGuides = [0, overlay.height];
  for (const s of state.slices) {
    if (s === excludeSlice) continue;
    xGuides.push(s.x, s.x + s.w);
    yGuides.push(s.y, s.y + s.h);
  }
  return { xGuides, yGuides };
}

function snapAxis(val, guides, axis) {
  let best = val, bestDist = SNAP_DIST + 1;
  for (const g of guides) {
    const d = Math.abs(val - g);
    if (d < bestDist) { bestDist = d; best = g; }
  }
  if (axis && best !== val) activeSnapLines[axis].push(best);
  return best;
}

function snapToEdge(x, y, excludeSlice) {
  activeSnapLines = { x: [], y: [] };
  const { xGuides, yGuides } = collectGuides(excludeSlice);
  return { x: snapAxis(x, xGuides, 'x'), y: snapAxis(y, yGuides, 'y') };
}

// ---- Undo stack (Ctrl+Z) ----
const undoStack = [];
const UNDO_MAX = 30;
function pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify(state.slices)));
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}
function doUndo() {
  if (!undoStack.length) return;
  state.slices = undoStack.pop();
  renderSliceList();
  redrawOverlay();
  runLint();
  renderRowSummary();
  updateSteps();
  scheduleSave();
}

// ---- Slice hit-testing for move & resize ----
let hoveredSlice = null;   // slice under cursor
let hoveredHandle = null;  // 'tl'|'tr'|'bl'|'br'|'move'|null
let editAction = null;     // active move/resize operation

function getHandleRadius() {
  return 8 / ZOOM_LEVELS[zoomIdx]; // consistent ~8px on screen regardless of zoom
}

function hitTestSlice(px, py) {
  const hr = getHandleRadius();

  // Check corners first (highest priority — resize handles)
  for (let i = state.slices.length - 1; i >= 0; i--) {
    const s = state.slices[i];
    const corners = [
      { handle: 'tl', cx: s.x,       cy: s.y },
      { handle: 'tr', cx: s.x + s.w, cy: s.y },
      { handle: 'bl', cx: s.x,       cy: s.y + s.h },
      { handle: 'br', cx: s.x + s.w, cy: s.y + s.h },
    ];
    for (const c of corners) {
      if (Math.abs(px - c.cx) <= hr * 1.5 && Math.abs(py - c.cy) <= hr * 1.5) {
        return { slice: s, handle: c.handle };
      }
    }
  }
  // Move: ONLY the label badge (#N / T tag at top-left of each slice)
  // This prevents edge zones from interfering with drawing new slices nearby.
  for (let i = state.slices.length - 1; i >= 0; i--) {
    const s = state.slices[i];
    const badgeW = 28 / ZOOM_LEVELS[zoomIdx];
    const badgeH = 20 / ZOOM_LEVELS[zoomIdx];
    if (px >= s.x && px <= s.x + badgeW && py >= s.y && py <= s.y + badgeH) {
      return { slice: s, handle: 'move' };
    }
  }
  return null;
}

function getHandleCursor(handle) {
  switch (handle) {
    case 'tl': case 'br': return 'nwse-resize';
    case 'tr': case 'bl': return 'nesw-resize';
    case 'move': return 'move';
    default: return 'crosshair';
  }
}

function updateCoordsDisplay() {
  const el = document.getElementById('cursorCoords');
  if (!el) return;
  if (!cursorPos) { el.textContent = ''; return; }
  el.textContent = `${Math.round(cursorPos.x)}, ${Math.round(cursorPos.y)} px`;
}

// ---- Magnifier loupe — cursor-bound zoom scope for precise slice placement ----
const MAG_SIZE = 150;  // canvas pixel size
const MAG_ZOOM = 5;    // magnification factor
const MAG_SRC  = MAG_SIZE / MAG_ZOOM; // 30px source area
const MAG_GAP  = 22;   // gap between cursor and magnifier edge
const MAG_FULL = MAG_SIZE + 4; // canvas + border total
let cursorClientX = 0, cursorClientY = 0; // raw mouse coords for positioning

function updateMagnifier() {
  if (!cursorPos || !state.image) {
    magnifierWrap.style.display = 'none';
    return;
  }
  magnifierWrap.style.display = '';

  // ── Position the magnifier near the cursor ──
  const canvasArea = canvasScroll.parentElement;  // .canvas-area
  const areaRect   = canvasArea.getBoundingClientRect();
  // Cursor position relative to .canvas-area
  const relX = cursorClientX - areaRect.left;
  const relY = cursorClientY - areaRect.top;
  const areaW = areaRect.width;
  const areaH = areaRect.height;

  // Default: top-right of cursor
  let magLeft = relX + MAG_GAP;
  let magTop  = relY - MAG_FULL - MAG_GAP;

  // Flip horizontally if too close to right edge
  if (magLeft + MAG_FULL > areaW - 4) {
    magLeft = relX - MAG_FULL - MAG_GAP;
  }
  // Flip vertically if too close to top edge (toolbar area)
  if (magTop < 40) {
    magTop = relY + MAG_GAP;
  }
  // Final clamp: keep within canvas-area bounds
  magLeft = Math.max(4, Math.min(areaW - MAG_FULL - 4, magLeft));
  magTop  = Math.max(40, Math.min(areaH - MAG_FULL - 4, magTop));

  magnifierWrap.style.left = magLeft + 'px';
  magnifierWrap.style.top  = magTop  + 'px';

  // ── Draw magnified content ──
  const cx = Math.round(cursorPos.x);
  const cy = Math.round(cursorPos.y);
  const half = MAG_SRC / 2;

  // Read from the source image canvas (full resolution)
  magCtx.fillStyle = '#1f2329';
  magCtx.fillRect(0, 0, MAG_SIZE, MAG_SIZE);
  magCtx.imageSmoothingEnabled = false; // Pixel-grid: show individual pixels
  magCtx.drawImage(canvas, cx - half, cy - half, MAG_SRC, MAG_SRC, 0, 0, MAG_SIZE, MAG_SIZE);

  // Draw existing slice edges that cross through the magnified area
  state.slices.forEach(s => {
    magCtx.strokeStyle = s.color;
    magCtx.lineWidth = 2;
    const lx = (s.x - (cx - half)) * MAG_ZOOM;
    const ly = (s.y - (cy - half)) * MAG_ZOOM;
    const lw = s.w * MAG_ZOOM;
    const lh = s.h * MAG_ZOOM;
    magCtx.strokeRect(lx, ly, lw, lh);
  });

  // Drawing-in-progress rectangle
  if (state.drawing) {
    const d = state.drawing;
    const rx = Math.min(d.startX, d.curX);
    const ry = Math.min(d.startY, d.curY);
    const rw = Math.abs(d.curX - d.startX);
    const rh = Math.abs(d.curY - d.startY);
    magCtx.strokeStyle = '#fff';
    magCtx.lineWidth = 2;
    magCtx.setLineDash([4, 3]);
    const lx = (rx - (cx - half)) * MAG_ZOOM;
    const ly = (ry - (cy - half)) * MAG_ZOOM;
    magCtx.strokeRect(lx, ly, rw * MAG_ZOOM, rh * MAG_ZOOM);
    magCtx.setLineDash([]);
  }

  // Center crosshair (shows exact cursor pixel)
  const ctr = MAG_SIZE / 2;
  magCtx.strokeStyle = 'rgba(255, 153, 0, 0.8)';
  magCtx.lineWidth = 1;
  magCtx.beginPath();
  magCtx.moveTo(ctr, 0); magCtx.lineTo(ctr, MAG_SIZE);
  magCtx.moveTo(0, ctr); magCtx.lineTo(MAG_SIZE, ctr);
  magCtx.stroke();

  // Center pixel highlight box
  magCtx.strokeStyle = '#fff';
  magCtx.lineWidth = 1;
  magCtx.strokeRect(ctr - MAG_ZOOM / 2, ctr - MAG_ZOOM / 2, MAG_ZOOM, MAG_ZOOM);
}

// Hover crosshair (only when NOT drawing — drawing uses document-level tracking)
overlay.addEventListener('mousemove', e => {
  if (state.drawing || editAction) return; // onDrawingMove / onEditMove handles this
  cursorClientX = e.clientX;
  cursorClientY = e.clientY;
  const p = getOverlayCoords(e);
  cursorPos = { x: Math.max(0, Math.min(overlay.width, p.x)), y: Math.max(0, Math.min(overlay.height, p.y)) };
  updateCoordsDisplay();

  // Hit-test for move/resize cursor (only in draw mode)
  if (toolMode === 'draw') {
    const hit = hitTestSlice(cursorPos.x, cursorPos.y);
    hoveredSlice = hit ? hit.slice : null;
    hoveredHandle = hit ? hit.handle : null;
    overlay.style.cursor = hit ? getHandleCursor(hit.handle) : 'crosshair';
  }

  redrawOverlay();
});
overlay.addEventListener('mouseleave', () => {
  if (state.drawing) return;
  cursorPos = null;
  updateCoordsDisplay();
  redrawOverlay();
});

function getOverlayCoords(e) {
  const rect = overlay.getBoundingClientRect();
  const scaleX = overlay.width / rect.width;
  const scaleY = overlay.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

// ---- Auto-scroll while drawing near edges ----
let autoScrollRAF = null;
let lastDrawEvent = null;
const SCROLL_EDGE = 50;  // px from edge that triggers scroll
const SCROLL_SPEED = 14; // px per frame

function autoScrollLoop() {
  if (!state.drawing || !lastDrawEvent) {
    autoScrollRAF = null;
    return;
  }
  const scrollRect = canvasScroll.getBoundingClientRect();
  const e = lastDrawEvent;
  let dy = 0, dx = 0;

  // Vertical auto-scroll
  if (e.clientY > scrollRect.bottom - SCROLL_EDGE) {
    dy = SCROLL_SPEED * Math.min(3, (e.clientY - (scrollRect.bottom - SCROLL_EDGE)) / SCROLL_EDGE);
  } else if (e.clientY < scrollRect.top + SCROLL_EDGE) {
    dy = -SCROLL_SPEED * Math.min(3, ((scrollRect.top + SCROLL_EDGE) - e.clientY) / SCROLL_EDGE);
  }
  // Horizontal auto-scroll
  if (e.clientX > scrollRect.right - SCROLL_EDGE) {
    dx = SCROLL_SPEED * Math.min(3, (e.clientX - (scrollRect.right - SCROLL_EDGE)) / SCROLL_EDGE);
  } else if (e.clientX < scrollRect.left + SCROLL_EDGE) {
    dx = -SCROLL_SPEED * Math.min(3, ((scrollRect.left + SCROLL_EDGE) - e.clientX) / SCROLL_EDGE);
  }

  if (dx !== 0 || dy !== 0) {
    canvasScroll.scrollLeft += dx;
    canvasScroll.scrollTop += dy;
    // Recalculate drawing coords after scroll (overlay moved in viewport)
    const raw = getOverlayCoords(e);
    const p = snapToEdge(raw.x, raw.y);
    state.drawing.curX = Math.max(0, Math.min(overlay.width, p.x));
    state.drawing.curY = Math.max(0, Math.min(overlay.height, p.y));
    cursorPos = { x: state.drawing.curX, y: state.drawing.curY };
    redrawOverlay();
  }

  autoScrollRAF = requestAnimationFrame(autoScrollLoop);
}

// ---- Drawing: mousedown on overlay, then track on document for full drag range ----
overlay.addEventListener('mousedown', e => {
  if (!state.image || isSpaceDown) return;
  e.preventDefault(); // prevent native image drag / selection

  // EYEDROPPER MODE: click to pick color from source image
  if (toolMode === 'eyedropper') {
    const raw = getOverlayCoords(e);
    const px = Math.round(Math.max(0, Math.min(canvas.width - 1, raw.x)));
    const py = Math.round(Math.max(0, Math.min(canvas.height - 1, raw.y)));
    let hex;
    try {
      const pixel = ctx.getImageData(px, py, 1, 1).data;
      hex = '#' + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.warn('Eyedropper: canvas context lost', err);
      return;
    }
    pickedColor = hex;
    // Update toolbar swatch
    const swatch = document.getElementById('pickedSwatch');
    const hexEl = document.getElementById('pickedHex');
    const container = document.getElementById('pickedColor');
    swatch.style.background = hex;
    hexEl.textContent = hex;
    container.style.display = '';
    // Also update any "apply picked" buttons in annotation list
    renderAnnotList();
    return;
  }

  // TEXT MODE: drag to draw a text box (same as slice drawing, but creates text-block slice)
  // Falls through to the same drawing logic below — mode is stored in state.drawing

  // DRAW / TEXT MODE: check move/resize on existing slice first, then new draw
  cursorClientX = e.clientX;
  cursorClientY = e.clientY;
  const raw = getOverlayCoords(e);
  const hit = hitTestSlice(raw.x, raw.y);

  if (hit && (hit.handle === 'move' || hit.handle.length === 2)) {
    // --- Start MOVE or RESIZE ---
    pushUndo();
    const s = hit.slice;
    editAction = {
      type: hit.handle === 'move' ? 'move' : 'resize',
      slice: s,
      handle: hit.handle,
      startX: raw.x,
      startY: raw.y,
      origX: s.x, origY: s.y, origW: s.w, origH: s.h,
    };
    cursorPos = { x: raw.x, y: raw.y };
    document.addEventListener('mousemove', onEditMove);
    document.addEventListener('mouseup', onEditEnd);
    return;
  }

  // --- Start NEW slice / text-box drawing ---
  const p = snapToEdge(raw.x, raw.y);
  state.drawing = { startX: p.x, startY: p.y, curX: p.x, curY: p.y, mode: toolMode };
  cursorPos = { x: p.x, y: p.y };
  updateCoordsDisplay();
  lastDrawEvent = e;
  document.addEventListener('mousemove', onDrawingMove);
  document.addEventListener('mouseup', onDrawingEnd);
  autoScrollRAF = requestAnimationFrame(autoScrollLoop);
});

function onDrawingMove(e) {
  if (!state.drawing) return;
  e.preventDefault();
  lastDrawEvent = e;
  cursorClientX = e.clientX;
  cursorClientY = e.clientY;
  const raw = getOverlayCoords(e);
  const p = snapToEdge(raw.x, raw.y);
  state.drawing.curX = Math.max(0, Math.min(overlay.width, p.x));
  state.drawing.curY = Math.max(0, Math.min(overlay.height, p.y));
  cursorPos = { x: state.drawing.curX, y: state.drawing.curY };
  updateCoordsDisplay();
  redrawOverlay();
}

function onDrawingEnd(e) {
  document.removeEventListener('mousemove', onDrawingMove);
  document.removeEventListener('mouseup', onDrawingEnd);
  if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
  activeSnapLines = { x: [], y: [] };
  lastDrawEvent = null;
  cursorPos = null;
  updateCoordsDisplay();

  if (!state.drawing) return;
  const d = state.drawing;
  const x = Math.round(Math.min(d.startX, d.curX));
  const y = Math.round(Math.min(d.startY, d.curY));
  const w = Math.round(Math.abs(d.curX - d.startX));
  const h = Math.round(Math.abs(d.curY - d.startY));
  const drawMode = d.mode || 'draw';
  state.drawing = null;
  if (w < 8 || h < 8) { redrawOverlay(); return; } // ignore tiny clicks
  pushUndo(); // snapshot before adding new slice
  const color = colors[(state.nextId - 1) % colors.length];
  const isTextBox = drawMode === 'text';
  const newSlice = {
    id: state.nextId++,
    x, y, w, h,
    href: '',
    alt: '',
    type: isTextBox ? 'text' : 'image',
    text: '',
    textStyle: { fontSize: 16, color: '#ffffff', bg: 'transparent', align: 'left', bold: false, italic: false },
    color,
  };
  state.slices.push(newSlice);
  renderSliceList();
  redrawOverlay();
  runLint();
  renderRowSummary();
  updateSteps();
  scheduleSave();

  // If text mode: immediately open inline editor on the canvas
  if (isTextBox) {
    showInlineEditor(newSlice);
  }
}

// ---- Move / Resize handlers ----
function onEditMove(e) {
  if (!editAction) return;
  e.preventDefault();
  cursorClientX = e.clientX;
  cursorClientY = e.clientY;
  const raw = getOverlayCoords(e);
  const px = Math.max(0, Math.min(overlay.width, raw.x));
  const py = Math.max(0, Math.min(overlay.height, raw.y));
  cursorPos = { x: px, y: py };
  updateCoordsDisplay();

  const a = editAction;
  const s = a.slice;
  const dx = px - a.startX;
  const dy = py - a.startY;

  activeSnapLines = { x: [], y: [] };
  if (a.type === 'move') {
    // Move: shift origin, snap to neighbor edges, clamp to canvas
    let nx = Math.round(a.origX + dx);
    let ny = Math.round(a.origY + dy);
    const { xGuides, yGuides } = collectGuides(s);
    nx = snapAxis(nx, xGuides, 'x');
    ny = snapAxis(ny, yGuides, 'y');
    const nr = snapAxis(nx + a.origW, xGuides, 'x');
    const nb = snapAxis(ny + a.origH, yGuides, 'y');
    if (nr !== nx + a.origW) nx = nr - a.origW;
    if (nb !== ny + a.origH) ny = nb - a.origH;
    nx = Math.max(0, Math.min(overlay.width - a.origW, nx));
    ny = Math.max(0, Math.min(overlay.height - a.origH, ny));
    s.x = nx; s.y = ny;
  } else {
    // Resize: adjust based on which corner handle, snap edges to neighbors
    const h = a.handle;
    let nx = a.origX, ny = a.origY, nw = a.origW, nh = a.origH;
    const { xGuides, yGuides } = collectGuides(s);

    if (h === 'tl') {
      nx = snapAxis(Math.round(a.origX + dx), xGuides, 'x');
      ny = snapAxis(Math.round(a.origY + dy), yGuides, 'y');
      nw = a.origX + a.origW - nx;
      nh = a.origY + a.origH - ny;
    } else if (h === 'tr') {
      ny = snapAxis(Math.round(a.origY + dy), yGuides, 'y');
      nw = snapAxis(Math.round(a.origX + a.origW + dx), xGuides, 'x') - a.origX;
      nh = a.origY + a.origH - ny;
    } else if (h === 'bl') {
      nx = snapAxis(Math.round(a.origX + dx), xGuides, 'x');
      nw = a.origX + a.origW - nx;
      nh = snapAxis(Math.round(a.origY + a.origH + dy), yGuides, 'y') - a.origY;
    } else if (h === 'br') {
      nw = snapAxis(Math.round(a.origX + a.origW + dx), xGuides, 'x') - a.origX;
      nh = snapAxis(Math.round(a.origY + a.origH + dy), yGuides, 'y') - a.origY;
    }

    // Enforce minimum size 8×8 and clamp to canvas
    if (nw < 8) { if (h === 'tl' || h === 'bl') nx = a.origX + a.origW - 8; nw = 8; }
    if (nh < 8) { if (h === 'tl' || h === 'tr') ny = a.origY + a.origH - 8; nh = 8; }
    nx = Math.max(0, nx);
    ny = Math.max(0, ny);
    if (nx + nw > overlay.width) nw = overlay.width - nx;
    if (ny + nh > overlay.height) nh = overlay.height - ny;

    s.x = nx; s.y = ny; s.w = nw; s.h = nh;
  }
  redrawOverlay();
}

function onEditEnd() {
  document.removeEventListener('mousemove', onEditMove);
  document.removeEventListener('mouseup', onEditEnd);
  activeSnapLines = { x: [], y: [] };
  if (!editAction) return;
  const s = editAction.slice;
  // If nothing actually changed, pop the undo entry
  const a = editAction;
  if (s.x === a.origX && s.y === a.origY && s.w === a.origW && s.h === a.origH) {
    undoStack.pop();
  }
  editAction = null;
  hoveredSlice = null;
  hoveredHandle = null;
  cursorPos = null;
  overlay.style.cursor = 'crosshair';
  updateCoordsDisplay();
  renderSliceList();
  redrawOverlay();
  runLint();
  renderRowSummary();
  scheduleSave();
}

// ---- Inline text editor on canvas ----
const inlineTextEdit = document.getElementById('inlineTextEdit');
let editingSliceId = null;

function showInlineEditor(slice) {
  editingSliceId = slice.id;
  const te = inlineTextEdit;
  te.style.left   = slice.x + 'px';
  te.style.top    = slice.y + 'px';
  te.style.width  = slice.w + 'px';
  te.style.height = slice.h + 'px';
  // Apply text styling
  const ts = slice.textStyle;
  te.style.fontSize   = ts.fontSize + 'px';
  te.style.lineHeight = (ts.fontSize * 1.4) + 'px';
  te.style.color      = ts.color;
  te.style.background = ts.bg || 'rgba(255,255,255,0.95)';
  te.style.fontWeight = ts.bold ? 'bold' : 'normal';
  te.style.fontStyle  = ts.italic ? 'italic' : 'normal';
  te.style.textAlign  = ts.align || 'left';
  te.value = slice.text || '';
  te.style.display = 'block';
  // Small delay so the canvas mouseup doesn't steal focus
  setTimeout(() => te.focus(), 50);
}

function hideInlineEditor() {
  if (editingSliceId == null) return;
  const slice = state.slices.find(s => s.id === editingSliceId);
  if (slice) {
    slice.text = inlineTextEdit.value;
    renderSliceList();
    redrawOverlay();
    scheduleSave();
  }
  editingSliceId = null;
  inlineTextEdit.style.display = 'none';
  inlineTextEdit.value = '';
}

// Live-sync sidebar style changes → inline editor (while it's open)
function syncInlineEditorStyle() {
  if (editingSliceId == null) return;
  const slice = state.slices.find(s => s.id === editingSliceId);
  if (!slice) return;
  const ts = slice.textStyle;
  const te = inlineTextEdit;
  te.style.fontSize   = ts.fontSize + 'px';
  te.style.lineHeight = (ts.fontSize * 1.4) + 'px';
  te.style.color      = ts.color;
  te.style.background = ts.bg || 'rgba(255,255,255,0.95)';
  te.style.fontWeight = ts.bold ? 'bold' : 'normal';
  te.style.fontStyle  = ts.italic ? 'italic' : 'normal';
  te.style.textAlign  = ts.align || 'left';
}

// Save text on blur or Escape — but NOT when clicking sidebar controls
let _blurAllowed = true;
inlineTextEdit.addEventListener('blur', () => {
  // Delay so we can check if focus went to a sidebar control
  setTimeout(() => {
    if (!_blurAllowed) { _blurAllowed = true; return; }
    const active = document.activeElement;
    const inSidebar = active && active.closest && active.closest('.sidebar');
    if (inSidebar && editingSliceId != null) {
      // User clicked a sidebar style control — keep editor open, just sync text
      const slice = state.slices.find(s => s.id === editingSliceId);
      if (slice) slice.text = inlineTextEdit.value;
      return;
    }
    hideInlineEditor();
  }, 80);
});
inlineTextEdit.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); _blurAllowed = true; inlineTextEdit.blur(); }
});

// Double-click overlay to edit existing text-block slices
overlay.addEventListener('dblclick', e => {
  if (!state.image) return;
  const raw = getOverlayCoords(e);
  // Find topmost text-block slice at this position
  for (let i = state.slices.length - 1; i >= 0; i--) {
    const s = state.slices[i];
    if (s.type !== 'text') continue;
    if (raw.x >= s.x && raw.x <= s.x + s.w && raw.y >= s.y && raw.y <= s.y + s.h) {
      showInlineEditor(s);
      return;
    }
  }
});

// Group slices into rows the same way the exporter will (Y-overlap with 8px tolerance).
// Returns an array of rows; each row is an array of slices sorted left-to-right.
function computeRows() {
  if (state.slices.length === 0) return [];
  const sorted = [...state.slices].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  const tolerance = 8;
  sorted.forEach(s => {
    const row = rows.find(r => {
      const top = Math.min(...r.map(x => x.y));
      const bot = Math.max(...r.map(x => x.y + x.h));
      return s.y < bot - tolerance && s.y + s.h > top + tolerance;
    });
    if (row) row.push(s);
    else rows.push([s]);
  });
  rows.forEach(r => r.sort((a, b) => a.x - b.x));
  return rows;
}

function redrawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // --- Crosshair guide lines (precision aid) ---
  if (cursorPos && state.image) {
    octx.save();
    octx.lineWidth = 1;
    if (state.drawing) {
      // During drawing: orange guides at START point (anchor), white at current
      const d = state.drawing;
      octx.strokeStyle = 'rgba(255, 153, 0, 0.55)';
      octx.setLineDash([6, 4]);
      octx.beginPath();
      octx.moveTo(d.startX, 0); octx.lineTo(d.startX, overlay.height);
      octx.moveTo(0, d.startY); octx.lineTo(overlay.width, d.startY);
      octx.stroke();
      octx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      octx.beginPath();
      octx.moveTo(cursorPos.x, 0); octx.lineTo(cursorPos.x, overlay.height);
      octx.moveTo(0, cursorPos.y); octx.lineTo(overlay.width, cursorPos.y);
      octx.stroke();
    } else {
      // Hover: single orange crosshair at cursor
      octx.strokeStyle = 'rgba(255, 153, 0, 0.4)';
      octx.setLineDash([6, 4]);
      octx.beginPath();
      octx.moveTo(cursorPos.x, 0); octx.lineTo(cursorPos.x, overlay.height);
      octx.moveTo(0, cursorPos.y); octx.lineTo(overlay.width, cursorPos.y);
      octx.stroke();
    }
    octx.setLineDash([]);
    octx.restore();
  }

  // --- Snap guide lines (cyan lines across canvas when edges align) ---
  if (activeSnapLines.x.length || activeSnapLines.y.length) {
    octx.save();
    octx.lineWidth = 1;
    octx.strokeStyle = 'rgba(0, 210, 255, 0.7)';
    octx.setLineDash([4, 3]);
    const uniqueX = [...new Set(activeSnapLines.x)];
    const uniqueY = [...new Set(activeSnapLines.y)];
    for (const gx of uniqueX) {
      octx.beginPath();
      octx.moveTo(gx, 0);
      octx.lineTo(gx, overlay.height);
      octx.stroke();
    }
    for (const gy of uniqueY) {
      octx.beginPath();
      octx.moveTo(0, gy);
      octx.lineTo(overlay.width, gy);
      octx.stroke();
    }
    octx.setLineDash([]);
    octx.restore();
  }

  // --- Row indicators: dotted connector + "R#" badge for each row ---
  const rows = computeRows();
  rows.forEach((row, idx) => {
    if (row.length < 2) return; // Only show indicator when row has multiple cells
    const top = Math.min(...row.map(s => s.y));
    const bot = Math.max(...row.map(s => s.y + s.h));
    const left = Math.min(...row.map(s => s.x));
    const right = Math.max(...row.map(s => s.x + s.w));
    const midY = (top + bot) / 2;

    // Faint horizontal band behind the row
    octx.fillStyle = 'rgba(0, 150, 255, 0.06)';
    octx.fillRect(left - 6, top - 4, (right - left) + 12, (bot - top) + 8);

    // Dotted connecting line between slice centers
    octx.strokeStyle = 'rgba(0, 130, 220, 0.7)';
    octx.lineWidth = 2;
    octx.setLineDash([6, 5]);
    octx.beginPath();
    octx.moveTo(left, midY);
    octx.lineTo(right, midY);
    octx.stroke();
    octx.setLineDash([]);

    // Row badge on the right edge: "R1 · 3 cells"
    const badgeText = `R${idx + 1} · ${row.length} cells`;
    octx.font = 'bold 13px Arial';
    const textW = octx.measureText(badgeText).width + 14;
    octx.fillStyle = 'rgba(0, 130, 220, 0.95)';
    octx.fillRect(right + 8, midY - 12, textW, 22);
    octx.fillStyle = '#fff';
    octx.fillText(badgeText, right + 15, midY + 4);
  });

  // --- Slice rectangles (drawn on top of row indicators) ---
  state.slices.forEach(s => {
    // Text-block slices: render solid background + text preview on canvas
    if (s.type === 'text') {
      const ts = s.textStyle;
      // Background fill
      octx.fillStyle = ts.bg || '#ffffff';
      octx.fillRect(s.x, s.y, s.w, s.h);
      // Render text content (word-wrapped)
      if (s.text && editingSliceId !== s.id) {
        octx.save();
        octx.beginPath();
        octx.rect(s.x, s.y, s.w, s.h);
        octx.clip();
        const bold = ts.bold ? 'bold ' : '';
        const italic = ts.italic ? 'italic ' : '';
        octx.font = `${italic}${bold}${ts.fontSize}px Arial`;
        octx.fillStyle = ts.color || '#1f2329';
        octx.textBaseline = 'top';
        const pad = 8;
        const maxW = s.w - pad * 2;
        const lineH = ts.fontSize * 1.4;
        // Simple word-wrap
        const words = s.text.split(/\n/).flatMap((line, i, arr) => {
          const w = line.split(/\s+/).filter(Boolean);
          return i < arr.length - 1 ? [...w, '\n'] : w;
        });
        const lines = [];
        let curLine = '';
        words.forEach(word => {
          if (word === '\n') { lines.push(curLine); curLine = ''; return; }
          const test = curLine ? curLine + ' ' + word : word;
          if (octx.measureText(test).width > maxW && curLine) {
            lines.push(curLine);
            curLine = word;
          } else {
            curLine = test;
          }
        });
        if (curLine) lines.push(curLine);
        lines.forEach((line, i) => {
          let lx = s.x + pad;
          if (ts.align === 'center') lx = s.x + (s.w - octx.measureText(line).width) / 2;
          else if (ts.align === 'right') lx = s.x + s.w - pad - octx.measureText(line).width;
          octx.fillText(line, lx, s.y + pad + i * lineH);
        });
        octx.restore();
      }
      // "T" badge instead of "#N" for text blocks
      octx.fillStyle = s.color;
      octx.fillRect(s.x, s.y, 22, 18);
      octx.fillStyle = '#fff';
      octx.font = 'bold 12px Arial';
      octx.fillText('T', s.x + 5, s.y + 13);
    } else {
      // Image slice: check for video thumbnail overlay
      const thumb = getThumbForSlice(s);
      if (thumb) {
        octx.save();
        octx.beginPath();
        octx.rect(s.x, s.y, s.w, s.h);
        octx.clip();
        // Cover-fit the thumbnail into the slice area
        const tAR = thumb.naturalWidth / thumb.naturalHeight;
        const sAR = s.w / s.h;
        let dx, dy, dw, dh;
        if (tAR > sAR) {
          dh = s.h; dw = s.h * tAR;
          dx = s.x + (s.w - dw) / 2; dy = s.y;
        } else {
          dw = s.w; dh = s.w / tAR;
          dx = s.x; dy = s.y + (s.h - dh) / 2;
        }
        octx.drawImage(thumb, dx, dy, dw, dh);
        // Semi-transparent overlay so slice border/badge still visible
        octx.fillStyle = 'rgba(0,0,0,0.15)';
        octx.fillRect(s.x, s.y, s.w, s.h);
        // Play icon in center
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        const pr = Math.min(s.w, s.h) * 0.12;
        octx.beginPath();
        octx.arc(cx, cy, pr + 4, 0, Math.PI * 2);
        octx.fillStyle = 'rgba(0,0,0,0.55)';
        octx.fill();
        octx.beginPath();
        octx.moveTo(cx - pr * 0.4, cy - pr * 0.6);
        octx.lineTo(cx - pr * 0.4, cy + pr * 0.6);
        octx.lineTo(cx + pr * 0.6, cy);
        octx.closePath();
        octx.fillStyle = '#fff';
        octx.fill();
        octx.restore();
      } else {
        // No thumbnail: semi-transparent fill
        octx.fillStyle = s.color + '22';
        octx.fillRect(s.x, s.y, s.w, s.h);
      }
      // "#N" label badge
      octx.fillStyle = s.color;
      octx.fillRect(s.x, s.y, 24, 18);
      octx.fillStyle = '#fff';
      octx.font = 'bold 12px Arial';
      octx.fillText('#' + s.id, s.x + 3, s.y + 13);
    }
    // Border (both types)
    octx.lineWidth = 2;
    octx.strokeStyle = s.color;
    octx.strokeRect(s.x, s.y, s.w, s.h);

    // Resize handles — show on hovered or actively edited slice
    const isActive = (hoveredSlice && hoveredSlice.id === s.id) ||
                     (editAction && editAction.slice.id === s.id);
    if (isActive) {
      const hr = getHandleRadius();
      const corners = [
        { cx: s.x, cy: s.y },
        { cx: s.x + s.w, cy: s.y },
        { cx: s.x, cy: s.y + s.h },
        { cx: s.x + s.w, cy: s.y + s.h },
      ];
      corners.forEach(c => {
        octx.fillStyle = '#fff';
        octx.fillRect(c.cx - hr, c.cy - hr, hr * 2, hr * 2);
        octx.strokeStyle = s.color;
        octx.lineWidth = 2;
        octx.strokeRect(c.cx - hr, c.cy - hr, hr * 2, hr * 2);
      });
    }
  });
  if (state.drawing) {
    const d = state.drawing;
    const rx = Math.min(d.startX, d.curX);
    const ry = Math.min(d.startY, d.curY);
    const rw = Math.abs(d.curX - d.startX);
    const rh = Math.abs(d.curY - d.startY);

    // Selection rectangle — text mode gets a filled background preview
    if (d.mode === 'text') {
      octx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      octx.fillRect(rx, ry, rw, rh);
      if (rw > 40 && rh > 20) {
        octx.fillStyle = 'rgba(0,0,0,0.3)';
        octx.font = '14px Arial';
        octx.textBaseline = 'top';
        octx.fillText('Text box — release to type', rx + 8, ry + 8);
      }
    }
    octx.lineWidth = 2;
    octx.strokeStyle = d.mode === 'text' ? '#ff9900' : '#fff';
    octx.setLineDash([5, 4]);
    octx.strokeRect(rx, ry, rw, rh);
    octx.setLineDash([]);

    // Dimension label + start position badge
    if (rw > 4 || rh > 4) {
      // --- W × H label below the rectangle ---
      octx.font = 'bold 12px Arial';
      const dimText = `${Math.round(rw)} × ${Math.round(rh)}`;
      const dtw = octx.measureText(dimText).width + 12;
      let dlx = rx, dly = ry + rh + 8;
      if (dly + 20 > overlay.height) dly = ry - 24; // flip above if near bottom
      octx.fillStyle = 'rgba(0,0,0,0.8)';
      octx.fillRect(dlx, dly, dtw, 20);
      octx.fillStyle = '#ff9900';
      octx.fillText(dimText, dlx + 6, dly + 15);

      // --- Start position badge (green if snapped to edge, orange otherwise) ---
      const atEdge = d.startX <= 1 || d.startX >= overlay.width - 1 ||
                     d.startY <= 1 || d.startY >= overlay.height - 1;
      octx.font = '11px Arial';
      const posText = atEdge ? `✓ ${Math.round(d.startX)}, ${Math.round(d.startY)}`
                             : `${Math.round(d.startX)}, ${Math.round(d.startY)}`;
      const ptw = octx.measureText(posText).width + 10;
      const px = d.startX < overlay.width / 2 ? d.startX + 6 : d.startX - ptw - 4;
      const py = d.startY < overlay.height / 2 ? d.startY + 18 : d.startY - 8;
      octx.fillStyle = atEdge ? 'rgba(76,175,80,0.9)' : 'rgba(0,0,0,0.7)';
      octx.fillRect(px, py - 11, ptw, 16);
      octx.fillStyle = '#fff';
      octx.fillText(posText, px + 5, py + 2);
    }
  }

  // --- Annotations (text labels placed by user — supports multiline) ---
  if (state.annotations && state.annotations.length) {
    state.annotations.forEach(a => {
      octx.save();
      const bold = a.bold ? 'bold ' : '';
      const italic = a.italic ? 'italic ' : '';
      octx.font = `${italic}${bold}${a.fontSize}px Arial`;
      octx.textBaseline = 'top';
      const pad = 6;
      const lines = (a.text || '').split('\n');
      const lineH = a.fontSize * 1.4;
      const maxW = Math.max(...lines.map(l => octx.measureText(l).width));
      const tw = maxW + pad * 2;
      const th = lineH * lines.length + pad * 2;
      // Background pill
      if (a.bg && a.bg !== 'transparent') {
        octx.fillStyle = a.bg;
        const r = 4;
        const bx = a.x - pad, by = a.y - pad;
        octx.beginPath();
        octx.moveTo(bx + r, by);
        octx.lineTo(bx + tw - r, by);
        octx.arcTo(bx + tw, by, bx + tw, by + r, r);
        octx.lineTo(bx + tw, by + th - r);
        octx.arcTo(bx + tw, by + th, bx + tw - r, by + th, r);
        octx.lineTo(bx + r, by + th);
        octx.arcTo(bx, by + th, bx, by + th - r, r);
        octx.lineTo(bx, by + r);
        octx.arcTo(bx, by, bx + r, by, r);
        octx.closePath();
        octx.fill();
      }
      // Text — draw each line
      octx.fillStyle = a.color || '#ffffff';
      lines.forEach((line, i) => {
        octx.fillText(line, a.x, a.y + i * lineH);
      });
      // Selection ring
      octx.strokeStyle = 'rgba(255,153,0,0.5)';
      octx.lineWidth = 1;
      octx.setLineDash([3, 3]);
      octx.strokeRect(a.x - pad - 1, a.y - pad - 1, tw + 2, th + 2);
      octx.setLineDash([]);
      octx.restore();
    });
  }

  // Update magnifier loupe
  updateMagnifier();
}

// ---- Slice list (sidebar) ----
function renderSliceList() {
  sliceCount.textContent = state.slices.length;
  sliceList.innerHTML = '';
  if (state.slices.length === 0) {
    howto.style.display = '';
    return;
  }
  howto.style.display = 'none';
  state.slices.forEach(s => {
    const li = document.createElement('li');
    li.className = 'slice-item';
    const isText = s.type === 'text';
    li.innerHTML = `
      <div class="row">
        <span class="swatch" style="background:${s.color}"></span>
        <span class="name">Slice #${s.id}</span>
        <span class="coords">${s.w}×${s.h}</span>
        <button class="remove" data-id="${s.id}" title="Remove slice">✕</button>
      </div>
      <div class="type-toggle">
        <label class="type-opt ${!isText ? 'active' : ''}"><input type="radio" name="type-${s.id}" value="image" data-id="${s.id}" ${!isText ? 'checked' : ''}> Image slice</label>
        <label class="type-opt ${isText ? 'active' : ''}"><input type="radio" name="type-${s.id}" value="text" data-id="${s.id}" ${isText ? 'checked' : ''}> Text block</label>
      </div>
      ${isText ? `
        <textarea class="text-content" placeholder="Type the text that should appear in this region…" data-id="${s.id}">${escapeHtml(s.text || '')}</textarea>
        <div class="text-style-row">
          <input type="number" class="ts-size" data-id="${s.id}" value="${s.textStyle.fontSize}" min="8" max="72" title="Font size (px)">
          <input type="color" class="ts-color" data-id="${s.id}" value="${s.textStyle.color}" title="Text color">
          <input type="color" class="ts-bg" data-id="${s.id}" value="${s.textStyle.bg}" title="Background color">
          <button class="ts-btn ${s.textStyle.bold ? 'on' : ''}" data-id="${s.id}" data-prop="bold"><b>B</b></button>
          <button class="ts-btn ${s.textStyle.italic ? 'on' : ''}" data-id="${s.id}" data-prop="italic"><i>I</i></button>
          <select class="ts-align" data-id="${s.id}">
            <option value="left" ${s.textStyle.align === 'left' ? 'selected' : ''}>Left</option>
            <option value="center" ${s.textStyle.align === 'center' ? 'selected' : ''}>Center</option>
            <option value="right" ${s.textStyle.align === 'right' ? 'selected' : ''}>Right</option>
          </select>
        </div>
      ` : `
        <input type="url" class="slice-href" placeholder="Link URL (https://...) — leave empty for non-clickable" value="${escapeAttr(s.href)}" data-id="${s.id}">
        <input type="text" class="slice-alt" placeholder="Alt text — describes the image (for accessibility & image-blocked clients)" value="${escapeAttr(s.alt)}" data-id="${s.id}">
        <label class="thumb-opt" data-id="${s.id}" style="display:${getVideoThumbUrl(s.href) ? 'flex' : 'none'};align-items:center;gap:6px;font-size:11px;color:#475569;margin-top:6px;cursor:pointer;">
          <input type="checkbox" class="slice-usethumb" data-id="${s.id}" ${s.useThumb ? 'checked' : ''}>
          🎬 Replace this area with the video's thumbnail (off = keep your design)
        </label>
      `}
    `;
    sliceList.appendChild(li);
  });
  // URL inputs
  sliceList.querySelectorAll('.slice-href').forEach(inp => {
    inp.addEventListener('input', e => {
      const slice = state.slices.find(s => s.id == e.target.dataset.id);
      if (slice) {
        slice.href = e.target.value.trim();
        fetchThumb(slice.href, () => redrawOverlay());
        const lbl = sliceList.querySelector(`.thumb-opt[data-id="${slice.id}"]`);
        if (lbl) lbl.style.display = getVideoThumbUrl(slice.href) ? 'flex' : 'none';
        runLint(); updateSteps(); scheduleSave(); redrawOverlay();
      }
    });
  });
  // Video thumbnail opt-in
  sliceList.querySelectorAll('.slice-usethumb').forEach(cb => {
    cb.addEventListener('change', e => {
      const slice = state.slices.find(s => s.id == e.target.dataset.id);
      if (slice) {
        slice.useThumb = e.target.checked;
        if (slice.useThumb) fetchThumb(slice.href, () => redrawOverlay());
        redrawOverlay(); scheduleSave();
      }
    });
  });
  // Alt inputs
  sliceList.querySelectorAll('.slice-alt').forEach(inp => {
    inp.addEventListener('input', e => {
      const slice = state.slices.find(s => s.id == e.target.dataset.id);
      if (slice) { slice.alt = e.target.value; scheduleSave(); }
    });
  });
  // Type radio toggle
  sliceList.querySelectorAll('input[type="radio"]').forEach(r => {
    r.addEventListener('change', e => {
      const slice = state.slices.find(s => s.id == e.target.dataset.id);
      if (slice) { slice.type = e.target.value; renderSliceList(); runLint(); updateSteps(); scheduleSave(); }
    });
  });
  // Text content
  sliceList.querySelectorAll('.text-content').forEach(t => {
    t.addEventListener('input', e => {
      const slice = state.slices.find(s => s.id == e.target.dataset.id);
      if (slice) { slice.text = e.target.value; runLint(); updateSteps(); scheduleSave(); }
    });
  });
  // Text style controls — all sync to inline editor in real-time
  sliceList.querySelectorAll('.ts-size').forEach(i => i.addEventListener('input', e => {
    const slice = state.slices.find(s => s.id == e.target.dataset.id);
    if (slice) { slice.textStyle.fontSize = parseInt(e.target.value, 10) || 16; syncInlineEditorStyle(); redrawOverlay(); scheduleSave(); }
  }));
  sliceList.querySelectorAll('.ts-color').forEach(i => i.addEventListener('input', e => {
    const slice = state.slices.find(s => s.id == e.target.dataset.id);
    if (slice) { slice.textStyle.color = e.target.value; syncInlineEditorStyle(); redrawOverlay(); scheduleSave(); }
  }));
  sliceList.querySelectorAll('.ts-bg').forEach(i => i.addEventListener('input', e => {
    const slice = state.slices.find(s => s.id == e.target.dataset.id);
    if (slice) { slice.textStyle.bg = e.target.value; syncInlineEditorStyle(); redrawOverlay(); scheduleSave(); }
  }));
  sliceList.querySelectorAll('.ts-btn').forEach(b => b.addEventListener('click', e => {
    const btn = e.currentTarget;
    const slice = state.slices.find(s => s.id == btn.dataset.id);
    if (slice) { slice.textStyle[btn.dataset.prop] = !slice.textStyle[btn.dataset.prop]; syncInlineEditorStyle(); renderSliceList(); redrawOverlay(); scheduleSave(); }
  }));
  sliceList.querySelectorAll('.ts-align').forEach(s => s.addEventListener('change', e => {
    const slice = state.slices.find(x => x.id == e.target.dataset.id);
    if (slice) { slice.textStyle.align = e.target.value; syncInlineEditorStyle(); redrawOverlay(); scheduleSave(); }
  }));
  sliceList.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = parseInt(e.target.dataset.id, 10);
      pushUndo(); // snapshot before delete (Ctrl+Z will restore)
      state.slices = state.slices.filter(s => s.id !== id);
      renderSliceList();
      redrawOverlay();
      runLint();
      renderRowSummary();
      updateSteps();
      scheduleSave();
    });
  });
}

// ---- Row summary (sidebar) ----
function renderRowSummary() {
  const rows = computeRows();
  const summaryBox = document.getElementById('rowSummary');
  const summaryList = document.getElementById('rowSummaryList');
  if (state.slices.length === 0) {
    summaryBox.style.display = 'none';
    return;
  }
  summaryBox.style.display = '';
  summaryList.innerHTML = rows.map((row, idx) => {
    const pips = row.map(s => `<span class="pip" style="background:${s.color}" title="Slice #${s.id}"></span>`).join('');
    const label = row.length === 1
      ? `1 cell (full width)`
      : `${row.length} cells side-by-side`;
    return `<li><b>Row ${idx + 1}</b> — ${label} <span class="row-cells">${pips}</span></li>`;
  }).join('');
}

// ---- Annotation list (sidebar) ----
function renderAnnotList() {
  const panel = document.getElementById('annotationsPanel');
  const list = document.getElementById('annotList');
  const countEl = document.getElementById('annotCount');
  const hint = document.getElementById('annotHowto');
  countEl.textContent = state.annotations.length;

  list.innerHTML = '';
  if (state.annotations.length === 0) {
    hint.style.display = '';
    return;
  }
  hint.style.display = 'none';

  state.annotations.forEach(a => {
    const li = document.createElement('li');
    li.className = 'annot-item';
    // For the background color picker, convert rgba to hex if needed (color inputs need hex)
    let bgHex = '#000000';
    try {
      if (a.bg && a.bg.startsWith('#')) {
        bgHex = a.bg.length === 4 ? '#' + a.bg[1]+a.bg[1]+a.bg[2]+a.bg[2]+a.bg[3]+a.bg[3] : a.bg;
      } else if (a.bg && a.bg.startsWith('rgb')) {
        const m = a.bg.match(/(\d+)/g);
        if (m) bgHex = '#' + [m[0],m[1],m[2]].map(v => parseInt(v).toString(16).padStart(2,'0')).join('');
      }
    } catch(e) {}

    li.innerHTML = `
      <div class="annot-row">
        <span class="annot-label">Label #${a.id}</span>
        <span class="annot-pos">${a.x}, ${a.y}</span>
        <button class="remove" data-id="${a.id}" title="Remove label">✕</button>
      </div>
      <textarea class="annot-text" data-id="${a.id}" rows="2" placeholder="Label text (supports multiple lines)…">${escapeHtml(a.text)}</textarea>
      <div class="annot-style-row">
        <input type="number" class="as-size" data-id="${a.id}" value="${a.fontSize}" min="8" max="120" title="Font size (px)">
        <input type="color" class="as-color" data-id="${a.id}" value="${a.color}" title="Text color">
        ${pickedColor ? `<button class="as-pick" data-id="${a.id}" data-target="color" title="Apply picked ${pickedColor}">🎨</button>` : ''}
        <input type="color" class="as-bg" data-id="${a.id}" value="${bgHex}" title="Background color">
        ${pickedColor ? `<button class="as-pick" data-id="${a.id}" data-target="bg" title="Apply picked ${pickedColor}">🎨</button>` : ''}
        <button class="as-btn ${a.bold ? 'on' : ''}" data-id="${a.id}" data-prop="bold" title="Bold"><b>B</b></button>
        <button class="as-btn ${a.italic ? 'on' : ''}" data-id="${a.id}" data-prop="italic" title="Italic"><i>I</i></button>
      </div>
    `;
    list.appendChild(li);
  });

  // Wire events: text textarea (multiline)
  list.querySelectorAll('.annot-text').forEach(inp => {
    inp.addEventListener('input', e => {
      const ann = state.annotations.find(a => a.id == e.target.dataset.id);
      if (ann) { ann.text = e.target.value; redrawOverlay(); scheduleSave(); }
    });
  });
  // Apply picked color buttons
  list.querySelectorAll('.as-pick').forEach(btn => {
    btn.addEventListener('click', e => {
      const b = e.currentTarget;
      const ann = state.annotations.find(a => a.id == b.dataset.id);
      if (ann && pickedColor) {
        if (b.dataset.target === 'color') ann.color = pickedColor;
        else ann.bg = pickedColor;
        renderAnnotList(); redrawOverlay(); scheduleSave();
      }
    });
  });
  // Font size
  list.querySelectorAll('.as-size').forEach(inp => {
    inp.addEventListener('input', e => {
      const ann = state.annotations.find(a => a.id == e.target.dataset.id);
      if (ann) { ann.fontSize = parseInt(e.target.value, 10) || 18; redrawOverlay(); scheduleSave(); }
    });
  });
  // Text color
  list.querySelectorAll('.as-color').forEach(inp => {
    inp.addEventListener('input', e => {
      const ann = state.annotations.find(a => a.id == e.target.dataset.id);
      if (ann) { ann.color = e.target.value; redrawOverlay(); scheduleSave(); }
    });
  });
  // Background color
  list.querySelectorAll('.as-bg').forEach(inp => {
    inp.addEventListener('input', e => {
      const ann = state.annotations.find(a => a.id == e.target.dataset.id);
      if (ann) { ann.bg = e.target.value; redrawOverlay(); scheduleSave(); }
    });
  });
  // Bold / Italic toggle
  list.querySelectorAll('.as-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const b = e.currentTarget;
      const ann = state.annotations.find(a => a.id == b.dataset.id);
      if (ann) { ann[b.dataset.prop] = !ann[b.dataset.prop]; renderAnnotList(); redrawOverlay(); scheduleSave(); }
    });
  });
  // Remove
  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', e => {
      const id = parseInt(e.target.dataset.id, 10);
      state.annotations = state.annotations.filter(a => a.id !== id);
      renderAnnotList();
      redrawOverlay();
      scheduleSave();
    });
  });
}

// ---- Lint checks ----
function runLint() {
  const issues = [];
  if (!state.image) {
    lintList.innerHTML = '<li class="lint-ok">No image loaded.</li>';
    return;
  }
  const eo = getExportSettings();
  const exportWidth = eo.targetWidth || state.image.naturalWidth;
  if (exportWidth > 700) {
    issues.push({ level: 'warn', msg: `Export width ${exportWidth}px — Outlook may clip beyond 640px. ${eo.targetWidth ? '' : 'Set Output width to 640px in Export settings below.'}` });
  }
  if (state.slices.length === 0) {
    issues.push({ level: 'warn', msg: 'No slices yet. Draw at least one rectangle.' });
  }
  const imgSlices = state.slices.filter(s => s.type !== 'text');
  const withLink = imgSlices.filter(s => s.href);
  const withoutLink = imgSlices.filter(s => !s.href);
  if (withoutLink.length > 0 && withLink.length > 0) {
    const linkedIds = withLink.map(s => `#${s.id}`).join(', ');
    const unlinkedIds = withoutLink.map(s => `#${s.id}`).join(', ');
    issues.push({ level: 'warn', msg: `Links: slice ${linkedIds} linked — slice ${unlinkedIds} NOT linked (will display but not be clickable).` });
  } else if (withoutLink.length > 0) {
    issues.push({ level: 'warn', msg: `${withoutLink.length} image slice(s) have no link — they will display but not be clickable.` });
  }
  state.slices.forEach(s => {
    if (s.href && !/^https?:\/\//i.test(s.href)) {
      issues.push({ level: 'err', msg: `Slice #${s.id} link must start with https:// or http://` });
    }
  });
  // Info about overlapping slices (auto-grid handles them, so it's just a note)
  let overlapCount = 0;
  for (let i = 0; i < state.slices.length; i++) {
    for (let j = i + 1; j < state.slices.length; j++) {
      const a = state.slices[i], b = state.slices[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        overlapCount++;
      }
    }
  }
  if (overlapCount > 0) {
    issues.push({ level: 'info', msg: `${overlapCount} overlapping slice pair(s) — the newer slice takes priority in the overlap zone. This is handled automatically.` });
  }
  if (issues.length === 0) {
    lintList.innerHTML = '<li class="lint-ok">All checks pass — ready to export.</li><li class="lint-ok">Dark mode safe — slices render seamlessly on light and dark backgrounds.</li>';
  } else {
    lintList.innerHTML = issues.map(i =>
      `<li class="lint-${i.level === 'err' ? 'err' : i.level === 'info' ? 'info' : 'warn'}">${i.msg}</li>`
    ).join('');
  }
}

// ---- Clear ----
clearBtn.addEventListener('click', () => {
  if (!confirm('Remove all slices and text labels?')) return;
  state.slices = [];
  state.nextId = 1;
  state.annotations = [];
  state.nextAnnotId = 1;
  renderSliceList();
  renderAnnotList();
  redrawOverlay();
  runLint();
  renderRowSummary();
  updateSteps();
  scheduleSave();
});

// ---- Export settings panel (Photoshop-style Save-for-Web controls) ----
const esWidthPresets  = document.getElementById('esWidthPresets');
const esFmtToggle     = document.getElementById('esFmtToggle');
const esQualityRow    = document.getElementById('esQualityRow');
const esQualitySlider = document.getElementById('esQualitySlider');
const esQualityVal    = document.getElementById('esQualityVal');
const esOutputToggle  = document.getElementById('esOutputToggle');
const esDimInfo       = document.getElementById('esDimInfo');
const esDefaultLink   = document.getElementById('esDefaultLink');
const esBodyBgColor   = document.getElementById('esBodyBgColor');
const esBodyBgHex     = document.getElementById('esBodyBgHex');
const esBodyBgAuto    = document.getElementById('esBodyBgAuto');

// Toggle helpers for button groups
function wireToggle(container, cls) {
  container.querySelectorAll('.' + cls).forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.' + cls).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}
wireToggle(esWidthPresets, 'es-preset');
wireToggle(esFmtToggle, 'es-fmt');
wireToggle(esOutputToggle, 'es-out');

// Width preset also updates dimension info + shows/hides custom row
const esCustomRow    = document.getElementById('esCustomRow');
const esCustomWidth  = document.getElementById('esCustomWidth');
const esCustomHeight = document.getElementById('esCustomHeight');

esWidthPresets.addEventListener('click', () => {
  const active = esWidthPresets.querySelector('.es-preset.active');
  esCustomRow.style.display = (active && active.dataset.width === 'custom') ? '' : 'none';
  updateExportDimInfo();
  updateQualityBadge();
  scheduleSave();
});
esCustomWidth.addEventListener('input', () => { updateExportDimInfo(); updateQualityBadge(); scheduleSave(); });
esCustomHeight.addEventListener('input', () => { updateExportDimInfo(); updateQualityBadge(); scheduleSave(); });
if (esDefaultLink) esDefaultLink.addEventListener('input', () => { scheduleSave(); });

if (esBodyBgColor) esBodyBgColor.addEventListener('input', () => {
  if (esBodyBgHex) esBodyBgHex.value = esBodyBgColor.value;
  scheduleSave();
});
if (esBodyBgHex) esBodyBgHex.addEventListener('input', () => {
  const v = esBodyBgHex.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v) && esBodyBgColor) esBodyBgColor.value = v;
  scheduleSave();
});
function autoDetectBodyBg() {
  if (!state.image) return;
  const img = state.image;
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const samples = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    [0, Math.floor(h / 2)], [w - 1, Math.floor(h / 2)],
  ];
  const colors = samples.map(([x, y]) => {
    const d = cx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  const avg = [0, 1, 2].map(i => Math.round(colors.reduce((s, c) => s + c[i], 0) / colors.length));
  const hex = '#' + avg.map(v => v.toString(16).padStart(2, '0')).join('');
  if (esBodyBgColor) esBodyBgColor.value = hex;
  if (esBodyBgHex) esBodyBgHex.value = hex;
  c.width = c.height = 1;
}
if (esBodyBgAuto) esBodyBgAuto.addEventListener('click', () => {
  autoDetectBodyBg();
  scheduleSave();
});
const esBodyBgNone = document.getElementById('esBodyBgNone');
if (esBodyBgNone) esBodyBgNone.addEventListener('click', () => {
  if (esBodyBgColor) esBodyBgColor.value = '#ffffff';
  if (esBodyBgHex) esBodyBgHex.value = '';
  scheduleSave();
});

// Format toggle: show/hide JPEG quality slider
esFmtToggle.addEventListener('click', () => {
  const activeFmt = esFmtToggle.querySelector('.es-fmt.active');
  esQualityRow.style.display = activeFmt && activeFmt.dataset.fmt === 'jpeg' ? '' : 'none';
  updateQualityBadge();
  scheduleSave();
});

// Output type toggle
esOutputToggle.addEventListener('click', () => { scheduleSave(); });

// Cloudinary CDN settings
const esCloudName = document.getElementById('esCloudName');
const esUploadPreset = document.getElementById('esUploadPreset');
const esCloudinaryEnabled = document.getElementById('esCloudinaryEnabled');
const esCloudinaryTest = document.getElementById('esCloudinaryTest');

if (esCloudName) esCloudName.addEventListener('input', () => { scheduleSave(); });
if (esUploadPreset) esUploadPreset.addEventListener('input', () => { scheduleSave(); });
if (esCloudinaryEnabled) esCloudinaryEnabled.addEventListener('change', () => { scheduleSave(); });
if (esCloudinaryTest) esCloudinaryTest.addEventListener('click', async () => {
  const cn = esCloudName ? esCloudName.value.trim() : '';
  const up = esUploadPreset ? esUploadPreset.value.trim() : '';
  if (!cn || !up) { alert('Enter both Cloud Name and Upload Preset first.'); return; }
  esCloudinaryTest.disabled = true;
  esCloudinaryTest.textContent = 'Testing…';
  try {
    const url = await window.EDMExporter.testCloudinary(cn, up);
    esCloudinaryTest.textContent = 'Connected ✓';
    esCloudinaryTest.style.color = '#1b8a2d';
    setTimeout(() => { esCloudinaryTest.textContent = 'Test connection'; esCloudinaryTest.style.color = ''; esCloudinaryTest.disabled = false; }, 3000);
  } catch (err) {
    alert('Connection failed: ' + err.message + '\n\nMake sure:\n1. Cloud name is correct\n2. Upload preset exists and is set to "Unsigned"');
    esCloudinaryTest.textContent = 'Test connection';
    esCloudinaryTest.disabled = false;
  }
});

// Quality slider
esQualitySlider.addEventListener('input', () => {
  esQualityVal.textContent = esQualitySlider.value + '%';
  updateQualityBadge();
  scheduleSave();
});

function updateExportDimInfo() {
  if (!state.image) { esDimInfo.textContent = ''; return; }
  const origW = state.image.naturalWidth;
  const origH = state.image.naturalHeight;
  const activePreset = esWidthPresets.querySelector('.es-preset.active');
  const target = activePreset ? activePreset.dataset.width : '640';
  if (target === 'original') {
    esDimInfo.textContent = `Original: ${origW} × ${origH}px — no resize`;
  } else if (target === 'custom') {
    const cw = parseInt(esCustomWidth.value, 10) || origW;
    const ch = parseInt(esCustomHeight.value, 10) || 0;
    if (ch > 0) {
      const cappedW = Math.min(cw, origW);
      esDimInfo.textContent = cw > origW
        ? `${origW} × ${origH} → ${cappedW} × ${ch}px (custom height, width capped — won't upscale)`
        : `${origW} × ${origH} → ${cw} × ${ch}px (custom)`;
    } else {
      const scale = Math.min(1, cw / origW);
      const outW = Math.round(origW * scale);
      const outH = Math.round(origH * scale);
      esDimInfo.textContent = cw > origW
        ? `Original ${origW}px already ≤ ${cw}px — no resize needed`
        : `${origW} × ${origH} → ${outW} × ${outH}px (${Math.round(scale * 100)}%)`;
    }
  } else {
    const tw = parseInt(target, 10);
    if (origW <= tw) {
      esDimInfo.textContent = `Original ${origW}px already ≤ ${tw}px — no resize needed`;
    } else {
      const scale = tw / origW;
      const outH = Math.round(origH * scale);
      esDimInfo.textContent = `${origW} × ${origH} → ${tw} × ${outH}px (${Math.round(scale * 100)}%)`;
    }
  }
}

// Quality indicator badge — shows "Lossless" / "High" / etc.
function updateQualityBadge() {
  const badge = document.getElementById('esQualityBadge');
  const dot = document.getElementById('qualityDot');
  const label = document.getElementById('qualityLabel');
  if (!badge || !state.image) { if (badge) badge.style.display = 'none'; return; }
  badge.style.display = '';
  const es = getExportSettings();
  const noScale = !es.targetWidth || es.targetWidth >= state.image.naturalWidth;
  const isPng = es.format === 'png';
  const noCustomH = !es.targetHeight;
  // Describe the resize component
  const sizeDesc = noScale && noCustomH
    ? 'at original resolution'
    : es.targetHeight
      ? `scaled to ${es.targetWidth || 'original width'} × ${es.targetHeight}px`
      : `scaled to ${es.targetWidth}px`;
  if (isPng && noScale && noCustomH) {
    dot.className = 'quality-dot lossless';
    label.textContent = 'Lossless — PNG at original resolution, pixel-perfect quality.';
  } else if (isPng) {
    dot.className = 'quality-dot high';
    label.textContent = `High quality — PNG (lossless compression), ${sizeDesc}. No encoding loss.`;
  } else if (!isPng && noScale && noCustomH) {
    const q = Math.round((es.quality || 0.92) * 100);
    dot.className = q >= 95 ? 'quality-dot lossless' : 'quality-dot high';
    label.textContent = `JPEG ${q}% ${sizeDesc}. ${q >= 95 ? 'Near-lossless.' : 'Slight compression.'}`;
  } else {
    const q = Math.round((es.quality || 0.92) * 100);
    dot.className = 'quality-dot high';
    label.textContent = `JPEG ${q}%, ${sizeDesc}. Good quality.`;
  }
}

function getExportSettings() {
  const activeWidth  = esWidthPresets.querySelector('.es-preset.active');
  const activeFmt    = esFmtToggle.querySelector('.es-fmt.active');
  const activeOutput = esOutputToggle.querySelector('.es-out.active');

  const widthVal = activeWidth ? activeWidth.dataset.width : '640';
  let targetWidth;
  let targetHeight = null;
  if (widthVal === 'original') {
    targetWidth = null;
  } else if (widthVal === 'custom') {
    targetWidth = parseInt(esCustomWidth.value, 10) || null;
    const ch = parseInt(esCustomHeight.value, 10);
    if (ch > 0) targetHeight = ch;
  } else {
    targetWidth = parseInt(widthVal, 10);
  }
  const format = activeFmt ? activeFmt.dataset.fmt : 'png';
  const quality = format === 'jpeg' ? (parseInt(esQualitySlider.value, 10) / 100) : undefined;
  const outputType = activeOutput ? activeOutput.dataset.out : 'html+images';

  const defaultLink = esDefaultLink ? esDefaultLink.value.trim() : '';
  const bodyBgColor = esBodyBgHex ? esBodyBgHex.value.trim() : '';
  const cloudinaryEnabled = esCloudinaryEnabled ? esCloudinaryEnabled.checked : false;
  const cloudName = esCloudName ? esCloudName.value.trim() : '';
  const uploadPreset = esUploadPreset ? esUploadPreset.value.trim() : '';
  return { targetWidth, targetHeight, format, quality, outputType, defaultLink, bodyBgColor, cloudinaryEnabled, cloudName, uploadPreset };
}

// Snapshot export settings for save/load — captures which buttons/values are active.
function getExportSettingsSnapshot() {
  const activeWidth  = esWidthPresets.querySelector('.es-preset.active');
  const activeFmt    = esFmtToggle.querySelector('.es-fmt.active');
  const activeOutput = esOutputToggle.querySelector('.es-out.active');
  return {
    widthPreset: activeWidth ? activeWidth.dataset.width : '640',
    customWidth: esCustomWidth.value,
    customHeight: esCustomHeight.value,
    format: activeFmt ? activeFmt.dataset.fmt : 'png',
    quality: esQualitySlider.value,
    outputType: activeOutput ? activeOutput.dataset.out : 'html+images',
    defaultLink: esDefaultLink ? esDefaultLink.value : '',
    bodyBgColor: esBodyBgHex ? esBodyBgHex.value : '',
    cloudName: esCloudName ? esCloudName.value : '',
    uploadPreset: esUploadPreset ? esUploadPreset.value : '',
    cloudinaryEnabled: esCloudinaryEnabled ? esCloudinaryEnabled.checked : false,
  };
}

// Restore export settings from a saved snapshot.
function restoreExportSettings(es) {
  if (!es) return;
  // Width preset
  esWidthPresets.querySelectorAll('.es-preset').forEach(b => {
    b.classList.toggle('active', b.dataset.width === es.widthPreset);
  });
  esCustomRow.style.display = es.widthPreset === 'custom' ? '' : 'none';
  if (es.customWidth) esCustomWidth.value = es.customWidth;
  if (es.customHeight) esCustomHeight.value = es.customHeight;
  // Format
  esFmtToggle.querySelectorAll('.es-fmt').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === es.format);
  });
  esQualityRow.style.display = es.format === 'jpeg' ? '' : 'none';
  if (es.quality) { esQualitySlider.value = es.quality; esQualityVal.textContent = es.quality + '%'; }
  // Output type
  esOutputToggle.querySelectorAll('.es-out').forEach(b => {
    b.classList.toggle('active', b.dataset.out === es.outputType);
  });
  // Default link
  if (esDefaultLink && es.defaultLink) esDefaultLink.value = es.defaultLink;
  // Body background color
  if (es.bodyBgColor) {
    if (esBodyBgColor) esBodyBgColor.value = es.bodyBgColor;
    if (esBodyBgHex) esBodyBgHex.value = es.bodyBgColor;
  }
  // Cloudinary CDN
  if (esCloudName && es.cloudName) esCloudName.value = es.cloudName;
  if (esUploadPreset && es.uploadPreset) esUploadPreset.value = es.uploadPreset;
  if (esCloudinaryEnabled) esCloudinaryEnabled.checked = !!es.cloudinaryEnabled;
}

// ---- Export dropdown ----
const dropdown = exportForBtn.parentElement;
exportForBtn.addEventListener('click', e => {
  if (exportForBtn.disabled) return;
  dropdown.classList.toggle('open');
  e.stopPropagation();
});
document.addEventListener('click', e => {
  if (!dropdown.contains(e.target)) dropdown.classList.remove('open');
});

exportMenu.querySelectorAll('.dropdown-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const fmt = btn.dataset.format;
    dropdown.classList.remove('open');
    if (!state.image) return;
    if (state.slices.length === 0) {
      if (!confirm('No slices defined — the email will be one big image with no links. Continue?')) return;
    }
    await runExport(fmt);
  });
});

async function runExport(fmt) {
  exportForBtn.disabled = true;
  const originalLabel = exportForBtn.textContent;
  exportForBtn.textContent = 'Generating…';
  const eo = getExportSettings();
  // Pre-export diagnostic: log all slice link status
  if (state.slices.length) {
    const linked = state.slices.filter(s => s.href);
    console.log(`[EDM Export] ${linked.length} of ${state.slices.length} slices have links:`);
    state.slices.forEach(s => {
      console.log(`  Slice #${s.id} (${Math.round(s.x)},${Math.round(s.y)} ${Math.round(s.w)}×${Math.round(s.h)}): href="${s.href || '(none)'}"`);
    });
  }
  try {
    let result;
    let cdnHandled = false;
    const cdnReady = eo.cloudinaryEnabled && eo.cloudName && eo.uploadPreset;
    if (fmt === 'singleimage') {
      // One full image (perfect on every device) + clickable video text-links.
      cdnHandled = true; // copy button handles CDN on demand; no auto dual-download
      if (cdnReady) exportForBtn.textContent = 'Uploading to CDN…';
      const res = await window.EDMExporter.exportSingleImage(state, eo, cdnReady ? { cloudName: eo.cloudName, uploadPreset: eo.uploadPreset } : {});
      _lastCdnGmailHtml = res.html || '';
      showAfterExport('singleimage', res);
    } else if (fmt === 'outlook') {
      // No prompts — the .eml just downloads. Recipient/subject are set in
      // Outlook when forwarding. Sensible defaults fill the placeholder headers.
      const from    = 'campaigns@communiqueindia.com';
      const to      = '';
      const subject = state.projectName || state.imageName || 'EDM Newsletter';
      if (cdnReady) {
        // CDN-backed .eml: hosted images, zero attachments.
        exportForBtn.textContent = 'Uploading to CDN…';
        const cloudRes = await window.EDMExporter.exportEmlCloud(state, { from, to, subject }, eo, eo.cloudName, eo.uploadPreset, (done, total) => {
          exportForBtn.textContent = `CDN ${done}/${total}…`;
        });
        cdnHandled = true;
        _lastCdnGmailHtml = cloudRes.gmailHtml || '';
        showAfterExport('outlook-cdn', cloudRes);
      } else {
        await window.EDMExporter.exportEml(state, { from, to, subject }, eo);
        showAfterExport('outlook');
      }
    } else if (fmt === 'mailchimp') {
      await window.EDMExporter.exportMailchimp(state, eo);
      showAfterExport('mailchimp');
    } else if (fmt === 'gmail') {
      // Copy-first flow: the "Copy newsletter" button uploads to CDN on demand.
      // Skip the auto dual-HTML download so there's no file to accidentally attach.
      cdnHandled = true;
      showAfterExport('gmail');
    } else if (fmt === 'ses') {
      const from    = prompt('SES From address (must be SES-verified):', 'no-reply@yourdomain.com');
      if (from === null) return;
      const to      = prompt('To address (sample — change in JSON before sending):', 'recipient@example.com');
      if (to === null) return;
      const subject = prompt('Subject line:', (state.imageName || 'EDM') + ' campaign');
      if (subject === null) return;
      await window.EDMExporter.exportSES(state, { from, to, subject }, eo);
      showAfterExport('ses');
    } else if (fmt === 'oft') {
      const from    = prompt('From address (sender):', 'campaigns@communiqueindia.com');
      if (from === null) return;
      const to      = prompt('To address:', 'recipient@example.com');
      if (to === null) return;
      const subject = prompt('Subject line:', (state.imageName || 'EDM') + ' campaign');
      if (subject === null) return;
      await window.EDMExporter.exportOft(state, { from, to, subject }, eo);
      showAfterExport('oft');
    } else if (fmt === 'raw') {
      const rawHtml = await window.EDMExporter.exportRawHtml(state, eo);
      _lastCdnGmailHtml = rawHtml || '';
      showAfterExport('raw');
    }
    // Cloudinary CDN dual export — Gmail (table) + Outlook/Apple (image map)
    if (!cdnHandled && eo.cloudinaryEnabled && eo.cloudName && eo.uploadPreset) {
      exportForBtn.textContent = 'Uploading to CDN…';
      try {
        const cdnResult = await window.EDMExporter.exportCloudinary(state, eo, eo.cloudName, eo.uploadPreset, (done, total, phase) => {
          exportForBtn.textContent = `CDN ${phase || ''} ${done}/${total}…`;
        });
        console.log(`[CDN] Uploaded ${cdnResult.imageCount} images to Cloudinary (${cdnResult.linkedSlices} linked)`);
        showCdnExportGuide(cdnResult);
      } catch (cdnErr) {
        alert('CDN upload failed: ' + cdnErr.message + '\n\nThe normal export still completed successfully.');
        console.error('[CDN] Upload error:', cdnErr);
      }
    }
  } catch (err) {
    alert('Export failed: ' + err.message);
    console.error(err);
  } finally {
    exportForBtn.disabled = false;
    exportForBtn.textContent = originalLabel;
  }
}

// ---- After-export instruction modal ----
const afterExportModal = document.getElementById('afterExportModal');
const afterExportTitle = document.getElementById('afterExportTitle');
const afterExportBody  = document.getElementById('afterExportBody');
document.getElementById('closeAfterExport').addEventListener('click', () => {
  afterExportModal.classList.add('hidden');
});

function showAfterExport(fmt, result) {
  const guides = {
    outlook: {
      title: 'Outlook export — .eml downloaded',
      body: `
        <ol style="padding-left:20px;margin:0;">
          <li>Find the <b>.eml</b> file in your Downloads folder.</li>
          <li><b>Double-click it</b> — opens in Outlook with images embedded.</li>
          <li>Click <b>Forward</b> (or Reply).</li>
          <li>Enter your real recipient(s) in the <b>To</b> field. Multiple recipients separated by <code>;</code>.</li>
          <li>Click <b>Send</b>.</li>
        </ol>
        <p style="margin-top:14px;background:#fff4e0;padding:10px 12px;border-radius:6px;border-left:3px solid #f59e0b;">
          <b>Heads up:</b> images are <b>embedded</b>, so <b>Gmail recipients will see the slice pieces as attachment chips</b>.
          To send with <b>zero attachments</b>, tick <b>“Enable CDN upload on export”</b> in Export settings, then export again — the .eml will load images from your CDN instead.
        </p>`,
    },
    'outlook-cdn': {
      title: 'Export ready — send it inline (no attachments)',
      body: `
        <div style="margin:0 0 16px;padding:12px 14px;background:#e7f8f1;border-radius:8px;border-left:4px solid #10b981;font-size:13px;">
          ✓ Images are hosted on your Cloudinary CDN — the newsletter shows <b>inline in the email body</b> with <b>no attachments</b>.
        </div>

        <div style="margin:0 0 18px;padding:16px;background:#f0f4ff;border-radius:8px;border:1px solid #c5cfe0;text-align:center;">
          <p style="margin:0 0 4px;font-weight:700;font-size:15px;">Sending from Gmail? Do this 👇</p>
          <p style="margin:0 0 12px;font-size:12px;color:#5f6368;">The easiest way — paste the newsletter straight into the email body.</p>
          <button id="outlookCdnCopyBtn" style="padding:11px 30px;font-size:15px;font-weight:600;background:#d93025;color:#fff;border:none;border-radius:8px;cursor:pointer;">📋 Copy newsletter</button>
          <p style="margin:12px 0 0;font-size:12px;color:#5f6368;">Then in Gmail: <b>Compose</b> → click in the body → <b>Ctrl+V</b> → add recipient → <b>Send</b>. The images and links appear inline.</p>
        </div>

        <p style="font-weight:600;margin:0 0 8px;font-size:13px;">Sending from Outlook (desktop) instead?</p>
        <ol style="padding-left:20px;margin:0 0 14px;font-size:13px;">
          <li><b>Double-click the .eml</b> in your Downloads — it opens as an email.</li>
          <li>Click <b>Forward</b>, add recipient(s) in <b>To</b>, click <b>Send</b>.</li>
        </ol>

        <p style="margin:0;background:#fff4e0;padding:10px 12px;border-radius:6px;border-left:3px solid #f59e0b;font-size:12px;">
          <b>Don't attach the .eml file to a new email</b> — if you do, the recipient just gets a file to download (what you saw before), not the newsletter. Use <b>Copy → Paste</b> (Gmail) or <b>open → Forward</b> (Outlook) instead. Images load from the web, so keep them on Cloudinary after sending.
        </p>`,
    },
    oft: {
      title: 'Outlook Template — .eml downloaded (convert to .oft)',
      body: `
        <p>An <code>.eml</code> file has been downloaded. To create a reusable <b>.oft template</b>:</p>
        <ol style="padding-left:20px;margin:0;">
          <li><b>Double-click the .eml</b> — it opens in Outlook.</li>
          <li>Click <b>File → Save As</b>.</li>
          <li>In the "Save as type" dropdown, choose <b>Outlook Template (*.oft)</b>.</li>
          <li>Pick a location and click <b>Save</b>.</li>
          <li>Now anytime you need to send this EDM: <b>double-click the .oft</b> → a new email opens with the template pre-filled → add recipients → Send.</li>
        </ol>
        <p style="margin-top:14px;background:#e7f5ec;padding:10px 12px;border-radius:6px;border-left:3px solid #4caf50;">
          <b>Why .oft?</b> Unlike .eml (which you forward), an .oft opens a fresh <i>new</i> Compose window every time — perfect for reusable campaign templates.
        </p>`,
    },
    mailchimp: {
      title: 'Mailchimp export — .zip downloaded',
      body: `
        <ol style="padding-left:20px;margin:0;">
          <li>Unzip the file. You'll see <code>index.html</code>, <code>images/</code>, and <code>README.txt</code>.</li>
          <li>Log in to Mailchimp → <b>Content → Content Studio</b> → drag the <code>images/</code> folder in. Note the base URL Mailchimp gives you.</li>
          <li>Open <code>index.html</code> in Notepad. Find &amp; replace <code>src="images/</code> with <code>src="https://mcusercontent.com/.../</code> (your Mailchimp base URL).</li>
          <li>In Mailchimp: <b>Campaigns → Create → Email → Regular</b>.</li>
          <li>Design step: <b>Code your own → Paste in code</b>. Paste the entire <code>index.html</code> content.</li>
          <li>Pick your audience. Click <b>Send Test</b> to yourself first.</li>
          <li>When happy, click <b>Send Now</b>.</li>
        </ol>
        <p style="margin-top:14px;background:#fff8eb;padding:10px 12px;border-radius:6px;border-left:3px solid #ff9900;">
          The footer includes <code>*|UNSUB|*</code>, <code>*|ARCHIVE|*</code>, <code>*|UPDATE_PROFILE|*</code> merge tags — Mailchimp auto-replaces these at send time. Don't edit them.
        </p>`,
    },
    singleimage: {
      title: 'Single image — looks perfect on every device',
      body: `
        <div style="margin:0 0 16px;padding:12px 14px;background:#e7f8f1;border-radius:8px;border-left:4px solid #10b981;font-size:13px;">
          ✓ Your newsletter is now <b>one image</b> — it scales to fit any phone or laptop and <b>can't misalign or stretch</b>. The video links sit as clickable text under the image, so they work in Gmail too.
        </div>
        <div style="margin:0 0 18px;padding:18px;background:#f0f4ff;border-radius:10px;border:1px solid #c5cfe0;text-align:center;">
          <p style="margin:0 0 4px;font-weight:700;font-size:16px;">Step 1 — click to copy 👇</p>
          <p style="margin:0 0 14px;font-size:12px;color:#5f6368;"><b>Nothing downloads</b> — there's no file to attach.</p>
          <button id="singleImgCopyBtn" style="padding:13px 36px;font-size:16px;font-weight:700;background:#d93025;color:#fff;border:none;border-radius:9px;cursor:pointer;">📋 Copy newsletter</button>
          <div style="margin:16px 0 0;text-align:left;font-size:13px;color:#333;background:#fff;border-radius:8px;padding:12px 14px;">
            <b>Step 2 — paste into Gmail:</b>
            <ol style="margin:6px 0 0;padding-left:20px;">
              <li>Open Gmail → <b>Compose</b></li>
              <li>Click in the body → press <b>Ctrl+V</b></li>
              <li>Add recipient → <b>Send</b></li>
            </ol>
          </div>
        </div>
        <p style="margin:0;background:#fff4e0;padding:10px 12px;border-radius:6px;border-left:3px solid #f59e0b;font-size:12px;">
          <b>Tip:</b> to rename a video link, set the slice's <b>Alt text</b> (e.g. "Watch the highlights") before exporting — that becomes the link label. Otherwise they're "Video 1, Video 2…".
        </p>`,
    },
    gmail: {
      title: 'Send via Gmail — copy & paste, no file needed',
      body: `
        <div style="margin:0 0 18px;padding:18px;background:#f0f4ff;border-radius:10px;border:1px solid #c5cfe0;text-align:center;">
          <p style="margin:0 0 4px;font-weight:700;font-size:16px;">Step 1 — click to copy 👇</p>
          <p style="margin:0 0 14px;font-size:12px;color:#5f6368;">This copies the whole newsletter. <b>Nothing is downloaded</b> — so there's no file to attach.</p>
          <button id="gmailCopyInlineBtn" style="padding:13px 36px;font-size:16px;font-weight:700;background:#d93025;color:#fff;border:none;border-radius:9px;cursor:pointer;">📋 Copy newsletter</button>
          <div style="margin:16px 0 0;text-align:left;font-size:13px;color:#333;background:#fff;border-radius:8px;padding:12px 14px;">
            <b>Step 2 — paste into Gmail:</b>
            <ol style="margin:6px 0 0;padding-left:20px;">
              <li>Open Gmail → <b>Compose</b></li>
              <li>Click inside the message body</li>
              <li>Press <b>Ctrl+V</b> — the newsletter appears inline</li>
              <li>Add your recipient → <b>Send</b></li>
            </ol>
          </div>
        </div>
        <p style="margin:0;background:#fff4e0;padding:10px 12px;border-radius:6px;border-left:3px solid #f59e0b;font-size:12px;">
          <b>Important:</b> do <b>not</b> download a file and attach it — that's what makes the images show up as attachments. Just <b>Copy → Paste</b>. The newsletter goes into the email body itself.
        </p>
        <details style="margin-top:12px;font-size:12px;color:#666;">
          <summary style="cursor:pointer;">Advanced: download files instead</summary>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px;">
            <button id="gmailDownloadEmlBtn" style="padding:8px 16px;background:#5f6368;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Download .eml (Outlook only)</button>
            <button id="gmailDownloadHtmlBtn" style="padding:8px 16px;background:#5f6368;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Download .html</button>
            <button id="gmailDownloadZipBtn" style="padding:8px 16px;background:#5f6368;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Download .zip</button>
          </div>
          <p style="margin:8px 0 0;">The <b>.eml</b> is only for the Outlook desktop app (double-click → Forward → Send — never attach it). <b>.html</b>/<b>.zip</b> are for advanced/CDN use.</p>
        </details>`,
    },
    ses: {
      title: 'AWS SES export — .zip downloaded',
      body: `
        <p>Inside the zip:</p>
        <ul style="padding-left:20px;margin:0;">
          <li><code>index.html</code> — the email with placeholder CDN URLs</li>
          <li><code>ses-request.json</code> — ready for <code>aws ses send-email --cli-input-json file://ses-request.json</code></li>
          <li><code>send.sh</code> — runnable shell script</li>
          <li><code>images/</code> — slices to upload to your CDN</li>
          <li><code>README.txt</code> — step-by-step</li>
        </ul>
        <p style="margin-top:14px;background:#fff8eb;padding:10px 12px;border-radius:6px;border-left:3px solid #ff9900;">
          You must upload <code>images/</code> to a public CDN (S3 + CloudFront) and patch the URLs in <code>index.html</code> before sending. SES does not host images for you.
        </p>`,
    },
    raw: {
      title: 'Raw HTML export — .html downloaded',
      body: `
        <p>A self-contained <code>.html</code> file with base64-embedded images:</p>
        <ul style="padding-left:20px;margin:0;">
          <li>All images are embedded inside the HTML — no separate files needed</li>
          <li>All slice links are clickable</li>
          <li>Open in any browser to preview, or paste into any email tool that accepts HTML</li>
        </ul>
        <p style="margin-top:14px;background:#e7f5ec;padding:10px 12px;border-radius:6px;border-left:3px solid #4caf50;">
          <b>To send via Gmail:</b> Click "Copy for Gmail" below, then paste (Ctrl+V) in Gmail compose.
        </p>
        <div style="margin-top:14px;padding:14px;background:#f0f4ff;border-radius:8px;border:1px solid #c5cfe0;text-align:center;">
          <button id="rawCopyGmailBtn" style="padding:8px 24px;font-size:13px;font-weight:600;background:#d93025;color:#fff;border:none;border-radius:6px;cursor:pointer;">Copy for Gmail</button>
          <p style="margin:6px 0 0;font-size:12px;color:#5f6368;">Copies HTML with image links directly to clipboard. Paste in Gmail compose.</p>
        </div>`,
    },
  };
  const g = guides[fmt];
  if (!g) return;
  afterExportTitle.textContent = g.title;
  // Build link-status banner
  let linkBanner = '';
  const _imgSlices = state.slices.filter(s => s.type !== 'text');
  const _linked = _imgSlices.filter(s => s.href);
  const _unlinked = _imgSlices.filter(s => !s.href);
  if (_imgSlices.length && _linked.length < _imgSlices.length) {
    const linkedDesc = _linked.length ? _linked.map(s => `#${s.id}`).join(', ') : 'none';
    const unlinkedDesc = _unlinked.map(s => `#${s.id}`).join(', ');
    linkBanner = `<div style="margin:0 0 14px;padding:10px 12px;background:#fff3cd;border-radius:6px;border-left:3px solid #ffc107;font-size:13px;">
      <b>Link check:</b> ${_linked.length} of ${_imgSlices.length} slices have links.
      ${_linked.length ? `Linked: slice ${linkedDesc}.` : ''}
      Not linked: slice ${unlinkedDesc}.
      <br><span style="color:#856404;">Unlinked slices will show the image but won't be clickable. Go back and add URLs to make them clickable.</span>
    </div>`;
  } else if (_imgSlices.length && _linked.length === _imgSlices.length) {
    linkBanner = `<div style="margin:0 0 14px;padding:8px 12px;background:#e7f5ec;border-radius:6px;border-left:3px solid #4caf50;font-size:13px;">
      All ${_linked.length} slices have links — all clickable areas will work.
    </div>`;
  }
  afterExportBody.innerHTML = linkBanner + g.body;
  afterExportModal.classList.remove('hidden');

  const rawCopyBtn = afterExportBody.querySelector('#rawCopyGmailBtn');
  if (rawCopyBtn) {
    rawCopyBtn.addEventListener('click', () => {
      if (!_lastCdnGmailHtml) { alert('No HTML to copy.'); return; }
      copyHtmlToClipboard(_lastCdnGmailHtml, rawCopyBtn);
    });
  }

  const outlookCdnCopyBtn = afterExportBody.querySelector('#outlookCdnCopyBtn');
  if (outlookCdnCopyBtn) {
    outlookCdnCopyBtn.addEventListener('click', () => {
      if (!_lastCdnGmailHtml) { alert('No HTML to copy.'); return; }
      copyHtmlToClipboard(_lastCdnGmailHtml, outlookCdnCopyBtn);
    });
  }

  const singleImgCopyBtn = afterExportBody.querySelector('#singleImgCopyBtn');
  if (singleImgCopyBtn) {
    singleImgCopyBtn.addEventListener('click', () => {
      if (!_lastCdnGmailHtml) { alert('No HTML to copy.'); return; }
      copyHtmlToClipboard(_lastCdnGmailHtml, singleImgCopyBtn);
    });
  }

  // Gmail copy-only path: build HTML and copy to clipboard, download nothing.
  const gmailCopyInlineBtn = afterExportBody.querySelector('#gmailCopyInlineBtn');
  if (gmailCopyInlineBtn) {
    gmailCopyInlineBtn.addEventListener('click', async () => {
      const eo = getExportSettings();
      const origText = gmailCopyInlineBtn.textContent;
      try {
        let html;
        if (eo.cloudinaryEnabled && eo.cloudName && eo.uploadPreset) {
          gmailCopyInlineBtn.disabled = true;
          gmailCopyInlineBtn.textContent = 'Uploading to CDN…';
          const res = await window.EDMExporter.buildCdnGmailHtml(state, eo, eo.cloudName, eo.uploadPreset, (done, total) => {
            gmailCopyInlineBtn.textContent = `Uploading ${done}/${total}…`;
          });
          html = res.html;
        } else {
          gmailCopyInlineBtn.textContent = 'Preparing…';
          html = await window.EDMExporter.buildHTML(state, { embedImages: true, exportOpts: eo });
        }
        gmailCopyInlineBtn.disabled = false;
        copyHtmlToClipboard(html, gmailCopyInlineBtn);
      } catch (err) {
        gmailCopyInlineBtn.disabled = false;
        gmailCopyInlineBtn.textContent = origText;
        alert('Copy failed: ' + err.message);
      }
    });
  }

  const gmailEmlBtn = afterExportBody.querySelector('#gmailDownloadEmlBtn');
  if (gmailEmlBtn) {
    gmailEmlBtn.addEventListener('click', async () => {
      gmailEmlBtn.disabled = true;
      gmailEmlBtn.textContent = 'Generating…';
      try {
        const from = prompt('From address (sender):', 'campaigns@communiqueindia.com');
        if (from === null) { gmailEmlBtn.disabled = false; gmailEmlBtn.textContent = 'Download .eml (Recommended)'; return; }
        const to = prompt('To address:', 'recipient@example.com');
        if (to === null) { gmailEmlBtn.disabled = false; gmailEmlBtn.textContent = 'Download .eml (Recommended)'; return; }
        const subject = prompt('Subject line:', (state.imageName || 'EDM') + ' campaign');
        if (subject === null) { gmailEmlBtn.disabled = false; gmailEmlBtn.textContent = 'Download .eml (Recommended)'; return; }
        await window.EDMExporter.exportEml(state, { from, to, subject }, getExportSettings());
        gmailEmlBtn.textContent = 'Downloaded ✓';
        gmailEmlBtn.style.background = '#a52714';
      } catch (err) {
        alert('Download failed: ' + err.message);
        gmailEmlBtn.textContent = 'Download .eml (Recommended)';
        gmailEmlBtn.disabled = false;
      }
    });
  }

  const gmailHtmlBtn = afterExportBody.querySelector('#gmailDownloadHtmlBtn');
  if (gmailHtmlBtn) {
    gmailHtmlBtn.addEventListener('click', async () => {
      gmailHtmlBtn.disabled = true;
      gmailHtmlBtn.textContent = 'Generating…';
      try {
        await window.EDMExporter.exportRawHtml(state, getExportSettings());
        gmailHtmlBtn.textContent = 'Downloaded ✓';
        gmailHtmlBtn.style.background = '#0d5db8';
      } catch (err) {
        alert('Download failed: ' + err.message);
        gmailHtmlBtn.textContent = 'Download .html';
        gmailHtmlBtn.disabled = false;
      }
    });
  }

  const gmailZipBtn = afterExportBody.querySelector('#gmailDownloadZipBtn');
  if (gmailZipBtn) {
    gmailZipBtn.addEventListener('click', async () => {
      gmailZipBtn.disabled = true;
      gmailZipBtn.textContent = 'Generating…';
      try {
        await window.EDMExporter.exportZip(state, getExportSettings());
        gmailZipBtn.textContent = 'Downloaded ✓';
        gmailZipBtn.style.background = '#3c4043';
      } catch (err) {
        alert('Download failed: ' + err.message);
        gmailZipBtn.textContent = 'Download .zip';
        gmailZipBtn.disabled = false;
      }
    });
  }
}

let _lastCdnGmailHtml = '';

function copyHtmlToClipboard(htmlString, btn) {
  const blob = new Blob([htmlString], { type: 'text/html' });
  const item = new ClipboardItem({ 'text/html': blob });
  navigator.clipboard.write([item]).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied! Now paste in Gmail';
    btn.style.background = '#1b8a2d';
    btn.style.color = '#fff';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; btn.style.color = ''; }, 4000);
  }).catch(err => {
    alert('Clipboard copy failed: ' + err.message + '\n\nTry: Open the _gmail.html file in Chrome, Ctrl+A, Ctrl+C instead.');
  });
}

function showCdnExportGuide(cdnResult) {
  _lastCdnGmailHtml = cdnResult.gmailHtml || '';
  afterExportTitle.textContent = 'CDN Export — 2 files downloaded';
  const linked = cdnResult.linkedSlices || 0;
  const total = cdnResult.imageCount || 0;
  afterExportBody.innerHTML = `
    <div style="margin:0 0 16px;padding:12px 14px;background:#e7f5ec;border-radius:6px;border-left:3px solid #4caf50;font-size:13px;">
      Uploaded <b>${total}</b> image${total !== 1 ? 's' : ''} to Cloudinary CDN. <b>${linked}</b> clickable link${linked !== 1 ? 's' : ''} mapped.
    </div>

    <div style="margin:0 0 18px;padding:16px;background:#f0f4ff;border-radius:8px;border:1px solid #c5cfe0;text-align:center;">
      <p style="margin:0 0 10px;font-weight:600;font-size:15px;">Send via Gmail</p>
      <button id="cdnCopyGmailBtn" style="padding:10px 28px;font-size:14px;font-weight:600;background:#d93025;color:#fff;border:none;border-radius:6px;cursor:pointer;">Copy for Gmail</button>
      <p style="margin:8px 0 0;font-size:12px;color:#5f6368;">Click the button above, then open Gmail compose and press <b>Ctrl+V</b> to paste. Links will work.</p>
    </div>

    <p style="font-weight:600;margin:0 0 10px;">Also downloaded as files:</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px;">
      <tr style="background:#f0f4ff;">
        <td style="padding:10px 12px;border:1px solid #d0d3d9;font-weight:600;width:45%;">File</td>
        <td style="padding:10px 12px;border:1px solid #d0d3d9;font-weight:600;">Use for</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid #d0d3d9;"><code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;">_gmail.html</code></td>
        <td style="padding:10px 12px;border:1px solid #d0d3d9;">
          <b>Gmail / Google Workspace</b><br>
          <span style="color:#5f6368;">Table-sliced CDN images. All links work in Gmail.</span>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid #d0d3d9;"><code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;">_outlook_apple.html</code></td>
        <td style="padding:10px 12px;border:1px solid #d0d3d9;">
          <b>Outlook / Apple Mail</b><br>
          <span style="color:#5f6368;">Single seamless image + clickable hotspots. Zero gaps.</span>
        </td>
      </tr>
    </table>
    <div style="padding:10px 12px;background:#fff8e1;border-radius:6px;border-left:3px solid #ff9800;font-size:12px;color:#7a5d00;">
      <b>Tip:</b> For mixed audiences, use the "Copy for Gmail" button — it works across most clients.
    </div>`;
  afterExportModal.classList.remove('hidden');

  const copyBtn = document.getElementById('cdnCopyGmailBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (!_lastCdnGmailHtml) { alert('No HTML to copy.'); return; }
      copyHtmlToClipboard(_lastCdnGmailHtml, copyBtn);
    });
  }
}

// ---- Preview ----
const previewModal = document.getElementById('previewModal');
const previewFrame = document.getElementById('previewFrame');
const previewWarning = document.getElementById('previewWarning');
const sourceEditor = document.getElementById('sourceEditor');
const sourceCode = document.getElementById('sourceCode');
const closePreview = document.getElementById('closePreview');
const tabs = document.querySelectorAll('.preview-tabs .tab');
let currentPreviewHtml = ''; // stashed for source tab

previewBtn.addEventListener('click', () => {
  if (!state.image) return;
  showPreview('gmail');
  previewModal.classList.remove('hidden');
});
closePreview.addEventListener('click', () => previewModal.classList.add('hidden'));
tabs.forEach(t => t.addEventListener('click', () => {
  tabs.forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  showPreview(t.dataset.client);
}));

function showPreview(client) {
  const isSource = client === 'source';

  // Toggle visibility: source editor vs iframe + warning
  previewFrame.style.display = isSource ? 'none' : '';
  previewWarning.style.display = isSource ? 'none' : '';
  sourceEditor.style.display = isSource ? '' : 'none';

  try {
    const html = window.EDMExporter.buildHTML(state, { embedImages: true, client: isSource ? 'gmail' : client, exportOpts: getExportSettings() });
    currentPreviewHtml = html;

    if (isSource) {
      sourceCode.value = html;
    } else {
      previewFrame.srcdoc = html;
    }
  } catch (err) {
    console.error('Preview failed:', err);
    if (isSource) {
      sourceCode.value = '/* Error generating HTML: ' + err.message + ' */';
    } else {
      previewFrame.srcdoc = `<body style="font-family:Arial;padding:40px;color:#a32020;">
        <h2>Preview error</h2><p>${err.message}</p>
        <p style="color:#555;">Try reducing your image size (recommended: ≤640px wide) or draw fewer slices.</p></body>`;
    }
  }
}

// Source tab: Copy HTML button
document.getElementById('copySourceBtn').addEventListener('click', () => {
  const text = sourceCode.value;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copySourceBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }).catch(() => {
    // Fallback: select all so user can Ctrl+C
    sourceCode.select();
    document.execCommand('copy');
  });
});

// Source tab: Download .html button
document.getElementById('downloadSourceBtn').addEventListener('click', () => {
  const text = sourceCode.value;
  const blob = new Blob([text], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.imageName || 'edm') + '-edited.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// "Send real test" — quick path to the Gmail clipboard export with instructions
document.getElementById('sendRealTestBtn').addEventListener('click', async () => {
  previewModal.classList.add('hidden');
  await runExport('gmail');
});

// ---- Project Save / Load (download/upload .json to local disk) ----
document.getElementById('saveProjectBtn').addEventListener('click', () => {
  if (!state.image) { alert('No project to save — upload an image first.'); return; }
  const payload = {
    version: 3,
    savedAt: new Date().toISOString(),
    projectName: state.projectName,
    imageName: state.imageName,
    imageDataUrl: state.imageDataUrl,
    slices: state.slices,
    nextId: state.nextId,
    annotations: state.annotations,
    nextAnnotId: state.nextAnnotId,
    exportSettings: getExportSettingsSnapshot(),
  };
  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.projectName || state.imageName || 'edm-project') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

document.getElementById('loadProjectInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const saved = JSON.parse(ev.target.result);
      if (!saved.imageDataUrl) { alert('Invalid project file — no image data found.'); return; }
      restoreFromSaved(saved);
      // Clear the file input so the same file can be loaded again
      e.target.value = '';
    } catch (err) {
      alert('Failed to load project: ' + err.message);
    }
  };
  reader.readAsText(file);
});

// ---- Boot: offer to restore the autosaved project (don't auto-load it) ----
// Default to a clean slate so reopening the app is always ready for a new
// upload; surface a banner so a previous session can still be recovered.
function showRestoreBanner(saved) {
  const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : 'earlier';
  const name = saved.projectName || saved.imageName || 'Untitled project';
  const slices = (saved.slices || []).length;
  const bar = document.createElement('div');
  bar.id = 'restoreBanner';
  bar.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);' +
    'display:flex;align-items:center;gap:14px;background:#0f172a;color:#fff;' +
    'padding:12px 16px;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.34);' +
    'z-index:9998;font:500 13px Inter,-apple-system,Segoe UI,Arial,sans-serif;max-width:90vw;';
  bar.innerHTML =
    '<span>↩ Restore your previous project <b>' + escapeHtml(name) + '</b> (' +
    slices + ' slice' + (slices === 1 ? '' : 's') + ', saved ' + escapeHtml(when) + ')?</span>' +
    '<button id="restoreYes" style="background:linear-gradient(135deg,#ffb338,#ff8a00);color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:600;cursor:pointer;font-family:inherit;">Restore</button>' +
    '<button id="restoreNo" style="background:rgba(255,255,255,.12);color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-family:inherit;">Start new</button>';
  document.body.appendChild(bar);
  document.getElementById('restoreYes').onclick = () => { bar.remove(); restoreFromSaved(saved); };
  document.getElementById('restoreNo').onclick = () => { bar.remove(); clearSavedProject(); };
}

(async function bootRestore() {
  try {
    const saved = await loadSavedProject();
    if (saved && saved.imageDataUrl && !state.image) {
      showRestoreBanner(saved);
    }
  } catch (err) {
    console.warn('Autosave restore check failed:', err);
  }
})();
