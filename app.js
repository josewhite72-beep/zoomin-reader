// zoomin-reader — lector de cómics CBR/CBZ con zoom al tocar y lupa
// JoséWhite's PanaMentorLabs
import { createExtractorFromData } from './vendor/unrar.bundle.js';
import { initVoz, readVisible, stop as stopVoice, isActive as voiceActive, positionHighlight, closeSheet, listVoices, AI_DEFAULT_MODEL } from './voz.js';

const $ = (s) => document.querySelector(s);
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };

/* =========================================================
   AJUSTES
   ========================================================= */
const DEFAULTS = {
  zoom: 2.5, tapZoomed: 'out', loupe: 2.5, loupeSize: 200, dir: 'ltr', hintSeen: false,
  // Lectura en voz alta
  comicLang: 'es', ttsMode: 'auto', autoRead: false, ttsRate: 1, voiceURI: '',
  aiProvider: 'gemini', aiKey: '', aiModel: '', readSfx: false,
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('zr-settings') || '{}')); } catch {}
const saveSettings = () => { try { localStorage.setItem('zr-settings', JSON.stringify(settings)); } catch {} };

/* =========================================================
   INDEXEDDB (biblioteca)
   ========================================================= */
let dbP;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open('zoomin-reader', 2);
    r.onupgradeneeded = () => {
      const names = r.result.objectStoreNames;
      if (!names.contains('books')) r.result.createObjectStore('books', { keyPath: 'id' });
      if (!names.contains('files')) r.result.createObjectStore('files');
      if (!names.contains('ocr')) r.result.createObjectStore('ocr'); // texto reconocido por zona
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const getBook = (id) => idb('books', 'readonly', (s) => s.get(id));
const putBook = (b) => idb('books', 'readwrite', (s) => s.put(b));
const allBooks = () => idb('books', 'readonly', (s) => s.getAll());
const getFile = (id) => idb('files', 'readonly', (s) => s.get(id));
const putFile = (id, blob) => idb('files', 'readwrite', (s) => s.put(blob, id));
async function deleteBook(id) {
  await idb('books', 'readwrite', (s) => s.delete(id));
  await idb('files', 'readwrite', (s) => s.delete(id));
  await idb('ocr', 'readwrite', (s) => s.delete(IDBKeyRange.bound(id + '|', id + '|￿'))).catch(() => {});
}

/* =========================================================
   UTILIDADES
   ========================================================= */
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function loading(on, text = 'Abriendo…', pct = null) {
  $('#loading').hidden = !on;
  $('#loadingText').textContent = text;
  $('#progressBar').style.width = pct == null ? '0' : `${Math.round(pct * 100)}%`;
}
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function isPage(name) {
  if (!IMG_RE.test(name)) return false;
  if (/(^|\/)__MACOSX\//i.test(name)) return false;
  const base = name.split(/[\\/]/).pop();
  return !base.startsWith('.');
}
const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
const fmtMB = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';
const raf = () => new Promise((r) => setTimeout(r, 0));

function detectType(buf) {
  const u = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (u[0] === 0x52 && u[1] === 0x61 && u[2] === 0x72 && u[3] === 0x21) return 'rar';   // Rar!
  if (u[0] === 0x50 && u[1] === 0x4b) return 'zip';                                     // PK
  if (u[0] === 0x37 && u[1] === 0x7a && u[2] === 0xbc && u[3] === 0xaf) return '7z';
  return 'unknown';
}

/* =========================================================
   APERTURA DE ARCHIVOS → "book" con getBlob(i)
   ========================================================= */
let wasmP;
const getWasm = () => (wasmP ||= fetch('vendor/unrar.wasm').then((r) => {
  if (!r.ok) throw new Error('No se pudo cargar unrar.wasm');
  return r.arrayBuffer();
}));

async function openZip(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.values(zip.files).filter((f) => !f.dir && isPage(f.name)).map((f) => f.name).sort(naturalSort);
  if (!names.length) throw new Error('El archivo no contiene imágenes.');
  return {
    names,
    ready: true,
    async getBlob(i) {
      const data = await zip.file(names[i]).async('uint8array');
      return new Blob([data], { type: mimeOf(names[i]) });
    },
  };
}

async function openRar(buf, onProgress) {
  const wasmBinary = await getWasm();
  let extractor;
  try {
    extractor = await createExtractorFromData({ wasmBinary, data: buf });
  } catch (e) {
    throw new Error(/password/i.test(String(e)) ? 'El archivo tiene contraseña.' : 'No se pudo leer el RAR: ' + (e.reason || e.message || e));
  }
  const headers = [...extractor.getFileList().fileHeaders].filter((h) => !h.flags.directory && isPage(h.name));
  if (!headers.length) throw new Error('El archivo no contiene imágenes.');
  if (headers.some((h) => h.flags.encrypted)) throw new Error('El archivo tiene contraseña.');
  const names = headers.map((h) => h.name).sort(naturalSort);
  const index = new Map(names.map((n, i) => [n, i]));
  const blobs = new Array(names.length);
  const waiters = new Map();
  let done = 0, failed = null;

  const book = {
    names,
    ready: false,
    getBlob(i) {
      if (blobs[i]) return Promise.resolve(blobs[i]);
      if (failed) return Promise.reject(failed);
      return new Promise((res, rej) => {
        if (!waiters.has(i)) waiters.set(i, []);
        waiters.get(i).push({ res, rej });
      });
    },
  };

  // Extracción en segundo plano (en el orden del archivo); cada página queda disponible apenas sale.
  (async () => {
    try {
      const gen = extractor.extract({ files: (h) => !h.flags.directory && isPage(h.name) }).files;
      for (const f of gen) {
        const i = index.get(f.fileHeader.name);
        if (i != null && f.extraction) {
          blobs[i] = new Blob([f.extraction], { type: mimeOf(f.fileHeader.name) });
          (waiters.get(i) || []).forEach((w) => w.res(blobs[i]));
          waiters.delete(i);
        }
        done++;
        onProgress && onProgress(done, names.length);
        await raf(); // deja respirar a la interfaz
      }
      book.ready = true;
      onProgress && onProgress(names.length, names.length);
    } catch (e) {
      failed = new Error('Error al descomprimir: ' + (e.reason || e.message || e));
      waiters.forEach((ws) => ws.forEach((w) => w.rej(failed)));
      waiters.clear();
      toast(failed.message, 5000);
    }
  })();
  return book;
}

async function openBuffer(buf, onProgress) {
  const type = detectType(buf);
  if (type === 'rar') return openRar(buf, onProgress);
  if (type === 'zip') return openZip(buf);
  if (type === '7z') throw new Error('Los archivos .cb7 / 7z todavía no son compatibles.');
  throw new Error('Formato no reconocido. Usa archivos .cbr o .cbz.');
}

/* =========================================================
   LECTOR: estado de página y zoom
   ========================================================= */
const stage = $('#stage'), img = $('#pageImg'), loupe = $('#loupe');
let book = null, meta = null, cur = 0, loadToken = 0, curId = 'tmp';
const urlCache = new Map(); // índice -> objectURL (solo actual ± 1)

// Transformación: pantalla = t + c * s   (c = punto en la imagen a escala 1)
let vw = 0, vh = 0, bw = 0, bh = 0, s = 1, tx = 0, ty = 0;
const MAX_SCALE = 8;

function measure() {
  vw = stage.clientWidth; vh = stage.clientHeight;
  if (!img.naturalWidth) return;
  const r = Math.min(vw / img.naturalWidth, vh / img.naturalHeight);
  bw = img.naturalWidth * r; bh = img.naturalHeight * r;
  img.style.width = bw + 'px'; img.style.height = bh + 'px';
}
function clamp() {
  const w = bw * s, h = bh * s;
  tx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, tx));
  ty = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, ty));
}
function apply(anim) {
  img.style.transition = anim ? 'transform .24s cubic-bezier(.2,.8,.3,1)' : 'none';
  img.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${s})`;
  document.body.classList.toggle('zoomed', s > 1.01);
  positionHighlight();
}
function resetZoom(anim) { s = 1; clamp(); apply(anim); }
// Zoom a escala ns; si center=true el punto tocado queda en el centro de la pantalla
function zoomAt(px, py, ns, center) {
  const cx = (px - tx) / s, cy = (py - ty) / s;
  s = Math.min(MAX_SCALE, Math.max(1, ns));
  if (center) { tx = vw / 2 - cx * s; ty = vh / 2 - cy * s; }
  else { tx = px - cx * s; ty = py - cy * s; }
  clamp(); apply(true);
}

async function urlFor(i) {
  if (urlCache.has(i)) return urlCache.get(i);
  const blob = await book.getBlob(i);
  const u = URL.createObjectURL(blob);
  urlCache.set(i, u);
  return u;
}
function pruneUrls() {
  for (const [i, u] of urlCache) if (Math.abs(i - cur) > 1) { URL.revokeObjectURL(u); urlCache.delete(i); }
}
function preload(i) {
  if (i < 0 || i >= book.names.length) return;
  urlFor(i).then((u) => { const im = new Image(); im.src = u; im.decode?.().catch(() => {}); }).catch(() => {});
}

async function goTo(i, { save = true } = {}) {
  if (!book) return;
  i = Math.max(0, Math.min(book.names.length - 1, i));
  if (i !== cur) closeSheet();
  cur = i;
  const token = ++loadToken;
  updatePageUI();
  const spinT = setTimeout(() => ($('#pageSpinner').hidden = false), 150);
  try {
    const u = await urlFor(i);
    if (token !== loadToken) return;
    const tmp = new Image(); tmp.src = u;
    try { await tmp.decode(); } catch {}
    if (token !== loadToken) return;
    img.src = u;
    if (!img.complete) await new Promise((r) => (img.onload = img.onerror = r));
    measure(); resetZoom(false);
    if (i === 0 && meta && !meta.thumb) makeThumb();
  } catch (e) {
    toast(e.message || 'No se pudo cargar la página');
  } finally {
    clearTimeout(spinT);
    if (token === loadToken) $('#pageSpinner').hidden = true;
  }
  pruneUrls(); preload(i + 1); preload(i - 1);
  if (save && meta) { meta.page = i; meta.lastOpened = Date.now(); putBook(meta).catch(() => {}); }
}
const next = () => cur < book.names.length - 1 ? goTo(cur + 1) : toast('Última página');
const prev = () => cur > 0 ? goTo(cur - 1) : toast('Primera página');
// Con lectura derecha→izquierda se invierten los gestos
const forward = () => (settings.dir === 'rtl' ? prev() : next());
const backward = () => (settings.dir === 'rtl' ? next() : prev());

function updatePageUI() {
  const n = book.names.length;
  const sl = $('#pageSlider');
  sl.max = n; sl.value = cur + 1;
  sl.style.direction = settings.dir === 'rtl' ? 'rtl' : 'ltr';
  $('#pageLabel').textContent = `${cur + 1} / ${n}`;
}

async function makeThumb() {
  try {
    const c = document.createElement('canvas');
    const w = 240, h = Math.round(w * img.naturalHeight / img.naturalWidth);
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.75));
    if (blob && meta) { meta.thumb = blob; await putBook(meta); }
  } catch {}
}

/* =========================================================
   LUPA
   ========================================================= */
function showLoupe(x, y) { loupe.classList.add('on'); moveLoupe(x, y); navigator.vibrate?.(12); }
function hideLoupe() { loupe.classList.remove('on'); }
function moveLoupe(x, y) {
  const size = +settings.loupeSize, R = size / 2, m = +settings.loupe;
  const W = bw * s, H = bh * s;                // tamaño mostrado de la imagen
  const fx = (x - tx) / W, fy = (y - ty) / H;  // posición relativa dentro de la imagen
  // Se dibuja arriba del dedo para que no lo tape
  let lx = x - R, ly = y - size - 40;
  if (ly < 8) ly = y + 40;
  lx = Math.max(4, Math.min(vw - size - 4, lx));
  Object.assign(loupe.style, {
    width: size + 'px', height: size + 'px', left: lx + 'px', top: ly + 'px',
    backgroundImage: `url("${img.src}")`,
    backgroundSize: `${W * m}px ${H * m}px`,
    backgroundPosition: `${R - fx * W * m}px ${R - fy * H * m}px`,
  });
}

/* =========================================================
   GESTOS (Pointer Events: toque, arrastre, pellizco, lupa)
   ========================================================= */
const pts = new Map();
let g = null, lpTimer = 0;
const TAP_MOVE = 10, TAP_TIME = 320, LONG_PRESS = 450, SWIPE_MIN = 60;

function local(e) { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function startPinch() {
  const [a, b] = [...pts.values()];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: s, cx: (mx - tx) / s, cy: (my - ty) / s };
}

stage.addEventListener('pointerdown', (e) => {
  if (!book) return;
  stage.setPointerCapture(e.pointerId);
  const p = local(e);
  pts.set(e.pointerId, p);
  if (pts.size === 1) {
    g = { type: 'pending', sx: p.x, sy: p.y, t: performance.now(), stx: tx, sty: ty };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (g && g.type === 'pending') { g.type = 'loupe'; showLoupe(g.sx, g.sy); }
    }, LONG_PRESS);
  } else if (pts.size === 2) {
    clearTimeout(lpTimer); hideLoupe();
    startPinch();
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId) || !g) return;
  const p = local(e);
  pts.set(e.pointerId, p);

  if (g.type === 'pinch' && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    s = Math.min(MAX_SCALE, Math.max(0.7, g.s0 * d / g.d0));
    tx = mx - g.cx * s; ty = my - g.cy * s;
    apply(false);
    return;
  }
  if (g.type === 'loupe') { moveLoupe(p.x, p.y); return; }

  const dx = p.x - g.sx, dy = p.y - g.sy;
  if (g.type === 'pending' && Math.hypot(dx, dy) > TAP_MOVE) {
    clearTimeout(lpTimer);
    g.type = s > 1.01 ? 'pan' : 'swipe';
  }
  if (g.type === 'pan') {
    tx = g.stx + dx; ty = g.sty + dy; clamp(); apply(false);
  } else if (g.type === 'swipe') {
    // retroalimentación visual: la página sigue un poco al dedo
    clamp(); tx += dx * 0.35; apply(false);
  }
});

function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  const p = local(e);
  pts.delete(e.pointerId);
  clearTimeout(lpTimer);
  if (!g) return;

  if (g.type === 'pinch') {
    if (pts.size === 1) {               // queda un dedo: seguir moviendo
      const q = [...pts.values()][0];
      g = { type: 'pan', sx: q.x, sy: q.y, stx: tx, sty: ty };
      if (s < 1.01) { g.type = 'done'; }
      return;
    }
    if (s < 1.05) resetZoom(true); else { clamp(); apply(true); }
    g = null; return;
  }
  if (pts.size > 0) return;

  const dx = p.x - g.sx, dy = p.y - g.sy;
  if (g.type === 'loupe') hideLoupe();
  else if (g.type === 'pending' && performance.now() - g.t < TAP_TIME && e.type !== 'pointercancel') onTap(g.sx, g.sy);
  else if (g.type === 'swipe') {
    if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) { resetZoom(true); dx < 0 ? forward() : backward(); }
    else resetZoom(true);
  } else if (g.type === 'pan') { clamp(); apply(false); }
  g = null;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('contextmenu', (e) => e.preventDefault());

function onTap(x, y) {
  if (voiceActive()) stopVoice();
  let zoomedIn = false;
  if (s <= 1.01) { zoomAt(x, y, +settings.zoom, true); zoomedIn = true; }
  else if (settings.tapZoomed === 'move') { zoomAt(x, y, s, true); zoomedIn = true; }
  else resetZoom(true);
  // Leer automáticamente lo que quedó en pantalla tras el zoom
  if (zoomedIn && settings.autoRead) setTimeout(() => readVisible(), 320);
}

// Rueda del ratón (PC): zoom donde está el cursor
stage.addEventListener('wheel', (e) => {
  if (!book) return;
  e.preventDefault();
  const p = local(e);
  const ns = s * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
  if (ns <= 1.02) { resetZoom(true); return; }
  zoomAt(p.x, p.y, ns, false);
}, { passive: false });

window.addEventListener('resize', () => { if (book && img.naturalWidth) { measure(); resetZoom(false); } });

document.addEventListener('keydown', (e) => {
  if (!$('#reader').classList.contains('active') || $('#settingsDlg').open) return;
  if (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); settings.dir === 'rtl' ? prev() : next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); settings.dir === 'rtl' ? next() : prev(); }
  else if (e.key === 'Escape' && s > 1.01) resetZoom(true);
});

/* =========================================================
   ABRIR / CERRAR LECTOR
   ========================================================= */
async function openComic({ buf, name, id, saveBlob }) {
  loading(true, 'Leyendo archivo…');
  try {
    const onProgress = (d, n) => {
      $('#extractInfo').textContent = d < n ? `Descomprimiendo ${d}/${n}…` : '';
      if (!$('#loading').hidden) loading(true, `Descomprimiendo ${d}/${n}…`, d / n);
    };
    const b = await openBuffer(buf, onProgress);
    closeBook();
    book = b;
    curId = id;

    meta = (await getBook(id).catch(() => null)) || null;
    if (saveBlob) {
      try {
        await putFile(id, saveBlob);
        meta = meta || { id, name, size: saveBlob.size, added: Date.now(), page: 0 };
        navigator.storage?.persist?.();
      } catch { toast('No hay espacio para guardar este cómic en la biblioteca.'); }
    }
    if (meta) { meta.total = b.names.length; meta.lastOpened = Date.now(); await putBook(meta).catch(() => {}); }

    $('#bookTitle').textContent = name.replace(/\.(cb[rz7]|rar|zip)$/i, '');
    showScreen('reader');
    history.pushState({ reader: true }, '');
    measure();
    await goTo(meta?.page || 0, { save: false });
    if (meta?.page) toast(`Continuando en la página ${meta.page + 1}`);
    loading(false);
    if (!settings.hintSeen) $('#hint').hidden = false;
  } catch (e) {
    loading(false);
    toast(e.message || String(e), 5000);
  }
}

function closeBook() {
  loadToken++;
  closeSheet();
  urlCache.forEach((u) => URL.revokeObjectURL(u)); urlCache.clear();
  img.removeAttribute('src');
  book = null; meta = null; cur = 0; s = 1;
  document.body.classList.remove('zoomed');
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === name));
}

function leaveReader() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  closeBook();
  showScreen('library');
  renderLibrary();
}
window.addEventListener('popstate', () => { if ($('#reader').classList.contains('active')) leaveReader(); });
$('#btnBack').onclick = () => history.back();

/* =========================================================
   BIBLIOTECA
   ========================================================= */
const thumbUrls = [];
async function renderLibrary() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u)); thumbUrls.length = 0;
  let books = [];
  try { books = await allBooks(); } catch {}
  books.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  const grid = $('#bookGrid');
  grid.innerHTML = '';
  $('#emptyMsg').hidden = books.length > 0;
  for (const b of books) {
    const el = document.createElement('div');
    el.className = 'book';
    el.setAttribute('role', 'button');
    const cover = document.createElement('img');
    cover.className = 'cover'; cover.alt = '';
    if (b.thumb) { const u = URL.createObjectURL(b.thumb); thumbUrls.push(u); cover.src = u; }
    const pct = b.total ? Math.round(((b.page || 0) + 1) / b.total * 100) : 0;
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.innerHTML = `<div class="name"></div><div class="prog"></div><div class="bar-prog"><i style="width:${pct}%"></i></div>`;
    metaEl.querySelector('.name').textContent = b.name.replace(/\.(cb[rz7]|rar|zip)$/i, '');
    metaEl.querySelector('.prog').textContent = b.total ? `Pág. ${(b.page || 0) + 1} de ${b.total} · ${fmtMB(b.size)}` : fmtMB(b.size);
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.setAttribute('aria-label', 'Eliminar');
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`¿Eliminar "${b.name}" de la biblioteca?`)) return;
      await deleteBook(b.id); renderLibrary();
    };
    el.append(cover, metaEl, del);
    el.onclick = async () => {
      loading(true, 'Cargando de la biblioteca…');
      try {
        const blob = await getFile(b.id);
        if (!blob) throw new Error('No se encontró el archivo guardado.');
        const buf = await blob.arrayBuffer();
        await openComic({ buf, name: b.name, id: b.id, saveBlob: null });
      } catch (e) { loading(false); toast(e.message); }
    };
    grid.append(el);
  }
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage }) => {
      $('#storageInfo').textContent = usage ? `(${fmtMB(usage)} usados)` : '';
    }).catch(() => {});
  }
}

$('#btnOpen').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const id = `${file.name}|${file.size}`;
  loading(true, `Leyendo ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    await openComic({ buf, name: file.name, id, saveBlob: $('#chkSave').checked ? file : null });
  } catch (err) { loading(false); toast(err.message); }
};

/* =========================================================
   BARRAS, AJUSTES, PANTALLA COMPLETA
   ========================================================= */
$('#btnPrev').onclick = () => (settings.dir === 'rtl' ? next() : prev());
$('#btnNext').onclick = () => (settings.dir === 'rtl' ? prev() : next());
$('#pageSlider').oninput = (e) => ($('#pageLabel').textContent = `${e.target.value} / ${book.names.length}`);
$('#pageSlider').onchange = (e) => goTo(+e.target.value - 1);

$('#btnFull').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => toast('Pantalla completa no disponible'));
};

const dlg = $('#settingsDlg');
const fields = {
  setZoom: 'zoom', setTapZoomed: 'tapZoomed', setLoupe: 'loupe', setLoupeSize: 'loupeSize', setDir: 'dir',
  setComicLang: 'comicLang', setTtsMode: 'ttsMode', setAutoRead: 'autoRead', setTtsRate: 'ttsRate', setVoice: 'voiceURI',
  setAiProvider: 'aiProvider', setAiKey: 'aiKey', setAiModel: 'aiModel', setReadSfx: 'readSfx',
};
function fillVoices() {
  const sel = $('#setVoice');
  const vs = listVoices(settings.comicLang);
  sel.innerHTML = '<option value="">Automática</option>' +
    vs.map((v) => `<option value="${v.voiceURI.replace(/"/g, '&quot;')}">${v.name} (${v.lang})</option>`).join('');
  sel.value = vs.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
}
function syncAiFields() {
  $('#setAiModel').placeholder = AI_DEFAULT_MODEL[settings.aiProvider] || '';
  $('#aiKeyHelp').innerHTML = settings.aiProvider === 'groq'
    ? 'Clave gratis en <b>console.groq.com</b> → API Keys'
    : 'Clave gratis en <b>aistudio.google.com</b> → Get API key';
}
function openSettings() {
  for (const [id, k] of Object.entries(fields)) {
    const el = $('#' + id);
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else if (id !== 'setVoice') el.value = String(settings[k] ?? '');
  }
  fillVoices(); syncAiFields();
  dlg.showModal();
}
for (const [id, k] of Object.entries(fields)) {
  const el = $('#' + id);
  el.onchange = () => {
    settings[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (id === 'setComicLang') { settings.voiceURI = ''; fillVoices(); }
    if (id === 'setTtsMode') syncAiToggle();
    if (id === 'setAiProvider') { settings.aiModel = ''; $('#setAiModel').value = ''; syncAiFields(); }
    saveSettings();
    if (book) updatePageUI();
  };
}
// Selector rápido junto a la bocina: Con IA (automático, con respaldo local) / Sin IA
function syncAiToggle() {
  const on = settings.ttsMode !== 'local';
  const b = $('#btnAiToggle');
  b.textContent = on ? '🤖 IA' : '📴 Sin IA';
  b.classList.toggle('on', on);
}
$('#btnAiToggle').onclick = () => {
  if (voiceActive()) stopVoice();
  settings.ttsMode = settings.ttsMode === 'local' ? 'auto' : 'local';
  saveSettings(); syncAiToggle();
  if (settings.ttsMode === 'local') toast('Modo sin IA: se lee en el teléfono, sin internet');
  else if (!settings.aiKey) toast('Modo IA: falta tu clave en ⚙ Ajustes (mientras tanto leo sin IA)', 4000);
  else toast(navigator.onLine ? 'Modo IA activado' : 'Modo IA: sin internet ahora, leeré sin IA');
};
syncAiToggle();
$('#btnTestVoice').onclick = () => {
  if (!('speechSynthesis' in window)) return toast('Este navegador no tiene voz');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(settings.comicLang === 'en' ? 'Hello! This is how I will read your comics.' : '¡Hola! Así voy a leer tus cómics.');
  const v = listVoices(settings.comicLang).find((x) => x.voiceURI === settings.voiceURI);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = settings.comicLang === 'en' ? 'en-US' : 'es-ES';
  u.rate = +settings.ttsRate || 1;
  speechSynthesis.speak(u);
};
$('#btnSettings').onclick = openSettings;
$('#btnSettingsLib').onclick = openSettings;
$('#btnShowHint').onclick = () => { dlg.close(); if (book) $('#hint').hidden = false; else toast('Abre un cómic para ver las instrucciones'); };
$('#btnHintOk').onclick = () => { $('#hint').hidden = true; settings.hintSeen = true; saveSettings(); };

/* =========================================================
   INICIO
   ========================================================= */
initVoz({
  settings,
  toast,
  view: () => ({ img, s, tx, ty, bw, bh, vw, vh }),
  bookId: () => curId,
  page: () => cur,
  cacheGet: (k) => idb('ocr', 'readonly', (st) => st.get(k)),
  cachePut: (k, v) => idb('ocr', 'readwrite', (st) => st.put(v, k)),
  onVoicesChanged: () => { if (dlg.open) fillVoices(); },
});
renderLibrary();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  });
  // Cuando se instala una versión nueva, recargar una vez para usarla (sin interrumpir la lectura)
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    if ($('#reader').classList.contains('active')) toast('Versión nueva lista: se aplicará al volver a la biblioteca', 4000);
    else location.reload();
  });
}
