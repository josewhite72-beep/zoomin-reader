// zoomin-reader — Lectura en voz alta de globos y cajas de texto
// Dos modos: sin internet (Tesseract.js local) y con internet (IA con visión: Gemini o Groq)
// JoséWhite's PanaMentorLabs

const abs = (p) => new URL(p, location.href).href;
const LETTER = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/;
export const AI_DEFAULT_MODEL = { gemini: 'gemini-flash-latest', groq: 'qwen/qwen3.8-27b' };

let ctx;            // contexto que entrega app.js
let state = 'idle'; // idle | busy | speaking
let queue = [], qi = 0, runId = 0;
let current = null; // { blocks, source, region }
let hlBlock = null;

const $ = (s) => document.querySelector(s);

/* =========================================================
   INICIO
   ========================================================= */
export function initVoz(c) {
  ctx = c;
  $('#btnSpeak').onclick = () => (state === 'idle' ? readVisible() : stop());
  $('#vsClose').onclick = () => closeSheet();
  $('#vsPlay').onclick = () => {
    if (state === 'speaking') { stop(); return; }
    const blocks = blocksFromSheet();
    if (blocks.length) speakBlocks(blocks, 0);
  };
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => ctx.onVoicesChanged?.();
}

export const isActive = () => state !== 'idle';

/* =========================================================
   ZONA VISIBLE (en píxeles de la imagen original)
   ========================================================= */
function visibleRegion() {
  const { img, s, tx, ty, bw, vw, vh } = ctx.view();
  const nw = img.naturalWidth, nh = img.naturalHeight, k = nw / bw;
  const x0 = Math.max(0, (-tx / s) * k), y0 = Math.max(0, (-ty / s) * k);
  const x1 = Math.min(nw, ((vw - tx) / s) * k), y1 = Math.min(nh, ((vh - ty) / s) * k);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, nw, nh };
}

function cropCanvas(r, minLong, maxLong) {
  const { img } = ctx.view();
  const long = Math.max(r.w, r.h);
  const sc = Math.min(3, Math.max(minLong / long, Math.min(1, maxLong / long)));
  const c = document.createElement('canvas');
  c.width = Math.round(r.w * sc); c.height = Math.round(r.h * sc);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, r.x0, r.y0, r.w, r.h, 0, 0, c.width, c.height);
  return { canvas: c, sc };
}

/* =========================================================
   FLUJO PRINCIPAL
   ========================================================= */
export async function readVisible() {
  if (!ctx.view().img.naturalWidth) return;
  stop();
  const my = ++runId;
  const settings = ctx.settings;
  const r = visibleRegion();
  if (r.w < 20 || r.h < 20) return;

  const aiReady = navigator.onLine && !!settings.aiKey;
  let mode = settings.ttsMode === 'local' ? 'local' : (aiReady ? 'ai' : 'local');
  if (settings.ttsMode === 'ai' && !aiReady) {
    ctx.toast(settings.aiKey ? 'Sin internet: uso el modo sin conexión' : 'Falta la clave de IA (Ajustes): uso el modo sin conexión');
  }

  const key = cacheKey(r, mode);
  setState('busy');
  showSheet([], mode === 'ai' ? 'Leyendo con IA…' : 'Reconociendo texto…');

  try {
    let res = await ctx.cacheGet(key).catch(() => null);
    if (!res) {
      if (mode === 'ai') {
        try { res = await recognizeAI(r); }
        catch (e) {
          if (my !== runId) return;
          ctx.toast('IA: ' + e.message + ' — uso el modo sin conexión', 4500);
          mode = 'local';
          res = await ctx.cacheGet(cacheKey(r, 'local')).catch(() => null) || await recognizeLocal(r, my);
        }
      } else {
        res = await recognizeLocal(r, my);
      }
      if (my !== runId) return;
      if (res.blocks.length) ctx.cachePut(cacheKey(r, mode), res).catch(() => {});
    }
    if (my !== runId) return;
    current = res;
    if (!res.blocks.length) {
      showSheet([], 'No encontré texto en esta zona. Acércate más al globo.');
      setState('idle');
      return;
    }
    showSheet(res.blocks, sourceLabel(res.source));
    speakBlocks(res.blocks, 0);
  } catch (e) {
    if (my !== runId) return;
    showSheet([], 'Error: ' + (e.message || e));
    setState('idle');
  }
}

function cacheKey(r, mode) {
  const q = (v, t) => Math.round((v / t) * 50); // rejilla de 2 %
  const s = ctx.settings;
  return [ctx.bookId(), ctx.page(), q(r.x0, r.nw), q(r.y0, r.nh), q(r.x1, r.nw), q(r.y1, r.nh), mode, s.comicLang, mode === 'ai' ? s.aiProvider + (s.readSfx ? '+sfx' : '') : ''].join('|');
}
const sourceLabel = (src) => src === 'local' ? 'Sin internet' : `IA · ${src}`;

/* =========================================================
   MODO SIN INTERNET: Tesseract.js
   ========================================================= */
let tessP = null, worker = null, workerLang = null;
function loadTesseract() {
  return (tessP ||= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const sc = document.createElement('script');
    sc.src = 'vendor/tesseract/tesseract.min.js';
    sc.onload = () => res(window.Tesseract);
    sc.onerror = () => { tessP = null; rej(new Error('No se pudo cargar el motor de lectura')); };
    document.head.append(sc);
  }));
}
async function getWorker(lang) {
  const code = lang === 'en' ? 'eng' : 'spa';
  if (worker && workerLang === code) return worker;
  if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  const T = await loadTesseract();
  setStatus('Preparando el lector (solo la primera vez)…');
  worker = await T.createWorker(code, 1, {
    workerPath: abs('vendor/tesseract/worker.min.js'),
    corePath: abs('vendor/tesseract/'),
    langPath: abs('vendor/tesseract/lang'),
    gzip: false,
    logger: (m) => {
      if (m.status === 'recognizing text') setStatus(`Reconociendo texto… ${Math.round(m.progress * 100)}%`);
      else if (/loading/.test(m.status)) setStatus('Preparando el lector (solo la primera vez)…');
    },
  });
  await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
  workerLang = code;
  return worker;
}

// Escalado Lanczos-3 de un canal (Float32). Solo para agrandar: el bilineal del navegador
// emborrona las letras pequeñas y el OCR empeora mucho.
function lanczosUp(src, w, h, W, H) {
  const A = 3;
  const kern = (x) => {
    if (x === 0) return 1;
    if (x <= -A || x >= A) return 0;
    const px = Math.PI * x;
    return (A * Math.sin(px) * Math.sin(px / A)) / (px * px);
  };
  const weights = (inN, outN) => {
    const sc = outN / inN, idx = new Int32Array(outN * 2 * A), wt = new Float32Array(outN * 2 * A);
    for (let o = 0; o < outN; o++) {
      const c = (o + 0.5) / sc - 0.5, i0 = Math.floor(c) - A + 1;
      let sum = 0;
      for (let k = 0; k < 2 * A; k++) { const v = kern(c - (i0 + k)); wt[o * 2 * A + k] = v; sum += v; }
      for (let k = 0; k < 2 * A; k++) { idx[o * 2 * A + k] = Math.min(inN - 1, Math.max(0, i0 + k)); wt[o * 2 * A + k] /= sum; }
    }
    return { idx, wt };
  };
  const T = 2 * A;
  const X = weights(w, W), tmp = new Float32Array(W * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < W; x++) {
      let v = 0; const o = x * T;
      for (let k = 0; k < T; k++) v += src[row + X.idx[o + k]] * X.wt[o + k];
      tmp[y * W + x] = v;
    }
  }
  const Y = weights(h, H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const o = y * T;
    for (let k = 0; k < T; k++) {
      const wv = Y.wt[o + k]; if (!wv) continue;
      const row = Y.idx[o + k] * W, dst = y * W;
      for (let x = 0; x < W; x++) out[dst + x] += tmp[row + x] * wv;
    }
  }
  return out;
}

// Prepara dos imágenes en blanco y negro listas para el OCR.
// Las letras de cómic casi siempre son blanco puro o negro puro: un umbral global por color
// funciona mejor que uno adaptativo.  light = texto claro (cajas de color); dark = texto oscuro (globos).
function prepareOCR(r) {
  const { img } = ctx.view();
  const long = Math.max(r.w, r.h);
  const sc = Math.min(3, 3000 / long);           // agrandar hasta ~3000 px (máx. 3×)
  const baseSc = Math.min(1, sc);                // si la zona es enorme, reducir con el navegador
  const w = Math.max(1, Math.round(r.w * baseSc)), h = Math.max(1, Math.round(r.h * baseSc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, r.x0, r.y0, r.w, r.h, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let mn = new Float32Array(w * h), mx = new Float32Array(w * h);
  for (let i = 0, p = 0; i < mn.length; i++, p += 4) {
    const R = d[p], G = d[p + 1], B = d[p + 2];
    mn[i] = Math.min(R, G, B); mx[i] = Math.max(R, G, B);
  }
  let W = w, H = h;
  if (sc > 1.05) {
    W = Math.round(r.w * sc); H = Math.round(r.h * sc);
    mn = lanczosUp(mn, w, h, W, H); mx = lanczosUp(mx, w, h, W, H);
  }
  const L = Math.max(120, Math.round(Math.min(W, H) / 12)); // largo mínimo de un borde de caja
  const make = (test) => {
    const ink = new Uint8Array(W * H);
    for (let i = 0; i < ink.length; i++) ink[i] = test(i) ? 1 : 0;
    // Borrar bordes de cajas y viñetas: tramos rectos de tinta muy largos (las letras nunca los tienen).
    // Si se dejan, Tesseract a veces toma la caja como imagen y se salta el texto.
    const kill = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x <= W; x++) {
        if (x < W && ink[y * W + x]) run++;
        else { if (run >= L) for (let k = x - run; k < x; k++) kill[y * W + k] = 1; run = 0; }
      }
    }
    for (let x = 0; x < W; x++) {
      let run = 0;
      for (let y = 0; y <= H; y++) {
        if (y < H && ink[y * W + x]) run++;
        else { if (run >= L) for (let k = y - run; k < y; k++) kill[k * W + x] = 1; run = 0; }
      }
    }
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const og = out.getContext('2d'); const id = og.createImageData(W, H); const o = id.data;
    for (let i = 0, p = 0; i < W * H; i++, p += 4) { const v = ink[i] && !kill[i] ? 0 : 255; o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255; }
    og.putImageData(id, 0, 0);
    return out;
  };
  return {
    sc: W / r.w,
    light: make((i) => mn[i] > 165),
    dark: make((i) => mx[i] < 90),
  };
}

// Acomodo propio: Tesseract a veces junta dos cajas que están lado a lado en una sola línea.
// 1) cada línea se corta donde hay un hueco grande entre palabras (segmentos)
// 2) los segmentos se agrupan en cajas por cercanía vertical y solape horizontal
function blocksFromWords(data, sc, r, pol) {
  const letterRe = new RegExp(LETTER.source, 'g');
  const segs = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const ln of p.lines || []) {
    const words = (ln.words || []).filter((w) => (w.text || '').trim()).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!words.length) continue;
    const hs = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const lh = Math.max(8, hs[Math.floor(hs.length / 2)]);
    let cur = null;
    const flush = () => { if (cur) segs.push(cur); cur = null; };
    for (const w of words) {
      if (cur && w.bbox.x0 - cur.x1 > lh * 1.6) flush();
      if (!cur) cur = { words: [], confs: [], x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, h: lh };
      cur.words.push(w.text.trim()); cur.confs.push(w.confidence);
      cur.x1 = Math.max(cur.x1, w.bbox.x1); cur.y0 = Math.min(cur.y0, w.bbox.y0); cur.y1 = Math.max(cur.y1, w.bbox.y1);
    }
    flush();
  }
  // filtrar segmentos dudosos (ruido del dibujo, títulos estilizados)
  const good = segs.filter((sg) => {
    const text = sg.words.join(' ');
    const letters = (text.match(letterRe) || []).length;
    const conf = sg.confs.reduce((a, b) => a + b, 0) / sg.confs.length;
    sg.text = text; sg.conf = conf;
    return letters >= 2 && conf >= 40 && letters >= text.replace(/\s/g, '').length * 0.6;
  }).sort((a, b) => a.y0 - b.y0);

  const boxes = [];
  for (const sg of good) {
    let best = null, bestGap = Infinity;
    for (const bx of boxes) {
      const last = bx.segs[bx.segs.length - 1];
      const gap = sg.y0 - last.y1;
      const h = Math.max(last.h, sg.h);
      if (gap < -h * 0.5 || gap > h * 1.8) continue;
      const ov = Math.min(last.x1, sg.x1) - Math.max(last.x0, sg.x0);
      if (ov < Math.min(last.x1 - last.x0, sg.x1 - sg.x0) * 0.3) continue;
      const openSentence = !/[.!?…»”"]$/.test(last.text) || /-$/.test(last.text);
      if (gap > h * 0.8 && !openSentence) continue; // probablemente otra caja
      if (gap < bestGap) { best = bx; bestGap = gap; }
    }
    if (best) {
      best.segs.push(sg);
      best.x0 = Math.min(best.x0, sg.x0); best.x1 = Math.max(best.x1, sg.x1); best.y1 = Math.max(best.y1, sg.y1);
    } else boxes.push({ segs: [sg], x0: sg.x0, y0: sg.y0, x1: sg.x1, y1: sg.y1 });
  }
  return boxes.map((bx) => {
    const confs = bx.segs.flatMap((x) => x.confs);
    return {
      lines: bx.segs.map((x) => x.text), pol,
      conf: confs.reduce((a, b) => a + b, 0) / confs.length,
      rect: { x0: r.x0 + bx.x0 / sc, y0: r.y0 + bx.y0 / sc, x1: r.x0 + bx.x1 / sc, y1: r.y0 + bx.y1 / sc },
    };
  }).filter((b) => {
    const words = b.lines.join(' ').split(/\s+/).filter((w) => (w.match(letterRe) || []).length >= 2);
    return b.conf >= 60 && (words.length >= 2 || b.conf >= 85);
  });
}

async function recognizeLocal(r, my) {
  const w = await getWorker(ctx.settings.comicLang);
  setStatus('Preparando la imagen…');
  await new Promise((res) => setTimeout(res, 30));
  const prep = prepareOCR(r), sc = prep.sc;
  const found = [];
  for (const pol of ['light', 'dark']) {
    if (my !== runId) break;
    setStatus(`Reconociendo texto… (${pol === 'light' ? '1' : '2'}/2)`);
    const { data } = await w.recognize(prep[pol], {}, { blocks: true, text: false });
    found.push(...blocksFromWords(data, sc, r, pol));
    if (window.__zrDebug) window.__zrDebug.push({ pol, raw: (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => Math.round(l.confidence) + ' | ' + l.words.map((w) => w.text + ':' + Math.round(w.confidence)).join(' ')))) });
  }
  // quitar duplicados entre las dos pasadas
  const kept = [];
  for (const p of found.sort((a, b) => b.conf * b.lines.join('').length - a.conf * a.lines.join('').length)) {
    if (!kept.some((k) => overlap(k.rect, p.rect) > 0.4)) kept.push(p);
  }
  const blocks = orderBlocks(kept).map((p) => ({ text: cleanText(p.lines, ctx.settings.comicLang), rect: p.rect, type: 'texto' }))
    .filter((b) => b.text.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '').length >= 3);
  return { blocks, source: 'local' };
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const area = (q) => (q.x1 - q.x0) * (q.y1 - q.y0);
  return inter / Math.min(area(a), area(b) || 1);
}

function orderBlocks(list) {
  const rtl = ctx.settings.dir === 'rtl';
  return list.slice().sort((a, b) => {
    const A = a.rect, B = b.rect;
    const ov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    const minH = Math.min(A.y1 - A.y0, B.y1 - B.y0);
    if (ov > minH * 0.3) return rtl ? B.x0 - A.x0 : A.x0 - B.x0; // misma franja: por columna
    return A.y0 - B.y0;
  });
}

/* =========================================================
   LIMPIEZA DE TEXTO
   ========================================================= */
export function cleanText(lines, lang) {
  let out = '';
  for (let ln of lines) {
    ln = ln.trim();
    if (!ln) continue;
    if (!out) { out = ln; continue; }
    // palabra cortada con guion al final de la línea (no el "--" de pausa)
    if (/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]-$/.test(out) && !/--$/.test(out)) out = out.slice(0, -1) + ln;
    else out += ' ' + ln;
  }
  // restos de bordes y signos sueltos que deja el OCR
  out = out.replace(/[|¦]/g, ' ').replace(/(^|\s)[;:,.'"“”*_~=+<>]+(?=\s|$)/g, ' ').replace(/(\s—)+\s*$/, '');
  out = out.replace(/\s*-{2,}\s*/g, ' — ').replace(/\s+([,.;:!?…])/g, '$1').replace(/([¡¿])\s+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  out = out.replace(/^—\s*/, '').replace(/\s*—$/, '…');
  return fixCase(out, lang);
}

function fixCase(t, lang) {
  const letters = t.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || [];
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (!letters.length || upper / letters.length < 0.7) return t;
  t = t.toLowerCase();
  t = t.replace(/(^|[.!?]\s+|[¡¿])([a-záéíóúüñ])/g, (m, a, b) => a + b.toUpperCase());
  if (lang === 'en') t = t.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|ve|d)\b/g, "I'$1");
  return t;
}

/* =========================================================
   MODO CON INTERNET: IA con visión
   ========================================================= */
function aiPrompt() {
  const s = ctx.settings;
  const langName = s.comicLang === 'en' ? 'inglés' : 'español';
  const order = s.dir === 'rtl' ? 'de derecha a izquierda y de arriba abajo (manga)' : 'de izquierda a derecha y de arriba abajo';
  return `Eres un lector de cómics. La imagen es un fragmento de una página de un cómic en ${langName}.
Transcribe el texto de las cajas de narración, globos de diálogo y globos de pensamiento, en el orden natural de lectura (${order}).
Reglas:
- Escribe el texto en ${langName} con mayúsculas y minúsculas normales (mayúscula al inicio de oración y en nombres propios), con tildes correctas.
- Une las palabras cortadas con guion al final de una línea.
- ${s.readSfx ? 'Incluye las onomatopeyas y efectos de sonido como tipo "efecto".' : 'NO incluyas onomatopeyas ni efectos de sonido.'}
- NO incluyas títulos, logotipos, créditos ni números de página.
- Si un texto está cortado por el borde de la imagen, inclúyelo igual con lo que se lea.
- Si identificas quién habla, pon su nombre en "speaker"; si no, usa null. Para narración usa type "narracion".
Responde SOLO con JSON válido, sin explicaciones, con este formato:
{"blocks":[{"type":"narracion|dialogo|pensamiento|efecto","speaker":null,"text":"...","box":[ymin,xmin,ymax,xmax]}]}
donde box son coordenadas normalizadas de 0 a 1000 dentro de esta imagen.`;
}

async function fetchJSON(url, opts, ms = 45000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    if (!r.ok) {
      const msg = j?.error?.message || txt.slice(0, 160) || r.statusText;
      throw new Error(`${r.status} ${msg}`);
    }
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('la IA tardó demasiado');
    if (e instanceof TypeError) throw new Error('sin conexión con el servicio');
    throw e;
  } finally { clearTimeout(t); }
}

async function recognizeAI(r) {
  const s = ctx.settings;
  const provider = s.aiProvider || 'gemini';
  const model = (s.aiModel || '').trim() || AI_DEFAULT_MODEL[provider];
  const { canvas } = cropCanvas(r, 900, 1600);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  const b64 = dataUrl.split(',')[1];
  setStatus(`Leyendo con IA (${provider === 'groq' ? 'Groq' : 'Gemini'})…`);

  let text;
  if (provider === 'groq') {
    const j = await fetchJSON('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.aiKey}` },
      body: JSON.stringify({
        model, temperature: 0, max_completion_tokens: 3000,
        messages: [{ role: 'user', content: [{ type: 'text', text: aiPrompt() }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      }),
    });
    text = j?.choices?.[0]?.message?.content || '';
  } else {
    const j = await fetchJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.aiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: aiPrompt() }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });
    text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  const parsed = parseAI(text);
  const blocks = parsed.map((b) => {
    let rect = null;
    if (Array.isArray(b.box) && b.box.length === 4 && b.box.every((v) => typeof v === 'number')) {
      const [y0, x0, y1, x1] = b.box.map((v) => Math.max(0, Math.min(1000, v)) / 1000);
      if (x1 > x0 && y1 > y0) rect = { x0: r.x0 + x0 * r.w, y0: r.y0 + y0 * r.h, x1: r.x0 + x1 * r.w, y1: r.y0 + y1 * r.h };
    }
    return { text: String(b.text || '').replace(/\s+/g, ' ').trim(), rect, type: b.type || 'texto', speaker: b.speaker || null };
  }).filter((b) => b.text && (s.readSfx || b.type !== 'efecto'));
  return { blocks, source: provider === 'groq' ? 'Groq' : 'Gemini' };
}

function parseAI(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  const as = t.indexOf('['), zs = t.lastIndexOf(']');
  let obj = null;
  try { if (a >= 0 && z > a) obj = JSON.parse(t.slice(a, z + 1)); } catch {}
  if (!obj) { try { if (as >= 0 && zs > as) obj = { blocks: JSON.parse(t.slice(as, zs + 1)) }; } catch {} }
  if (!obj) throw new Error('respuesta no válida de la IA');
  return Array.isArray(obj) ? obj : (obj.blocks || []);
}

/* =========================================================
   VOZ (speechSynthesis)
   ========================================================= */
export function listVoices(lang) {
  if (!('speechSynthesis' in window)) return [];
  const pre = lang === 'en' ? 'en' : 'es';
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(pre));
}
function pickVoice() {
  const s = ctx.settings;
  const vs = listVoices(s.comicLang);
  return vs.find((v) => v.voiceURI === s.voiceURI) || vs.find((v) => v.localService) || vs[0] || null;
}

const PITCHES = [1.15, 0.8, 1.3, 0.7, 1.05, 0.9, 1.22];
function assignPitches(blocks) {
  const map = new Map();
  for (const b of blocks) {
    if (b.type === 'narracion' || !b.speaker) { b.pitch = 1; b.rateMul = b.type === 'narracion' ? 0.95 : 1; continue; }
    const key = b.speaker.toLowerCase();
    if (!map.has(key)) map.set(key, PITCHES[map.size % PITCHES.length]);
    b.pitch = map.get(key); b.rateMul = 1;
  }
}

function splitSentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]+["»”]?|[^.!?…]+$/g) || [text];
  const out = [];
  for (let p of parts) {
    p = p.trim(); if (!p) continue;
    while (p.length > 220) { // Chrome corta textos largos
      let cut = p.lastIndexOf(',', 200); if (cut < 80) cut = p.lastIndexOf(' ', 200);
      out.push(p.slice(0, cut + 1)); p = p.slice(cut + 1).trim();
    }
    out.push(p);
  }
  return out;
}

function speakBlocks(blocks, from) {
  if (!('speechSynthesis' in window)) { ctx.toast('Este navegador no tiene voz (speechSynthesis)'); setState('idle'); return; }
  speechSynthesis.cancel();
  assignPitches(blocks);
  queue = [];
  blocks.forEach((b, i) => { if (i >= from) splitSentences(b.text).forEach((t) => queue.push({ t, b, i })); });
  qi = 0;
  const my = ++runId;
  setState('speaking');
  const voice = pickVoice();
  const s = ctx.settings;
  const next = () => {
    if (my !== runId) return;
    if (qi >= queue.length) { finish(); return; }
    const { t, b, i } = queue[qi++];
    const u = new SpeechSynthesisUtterance(t);
    u.lang = voice?.lang || (s.comicLang === 'en' ? 'en-US' : 'es-ES');
    if (voice) u.voice = voice;
    u.rate = (+s.ttsRate || 1) * (b.rateMul || 1);
    u.pitch = b.pitch || 1;
    u.onend = next;
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
    highlight(b, i);
    speechSynthesis.speak(u);
  };
  next();
}

function finish() {
  setState('idle');
  highlight(null, -1);
  setStatus(current ? sourceLabel(current.source) + ' · terminado' : 'Terminado');
}

export function stop() {
  runId++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  highlight(null, -1);
  if (state !== 'idle') setState('idle');
}

/* =========================================================
   INTERFAZ: hoja de texto, resaltado, botón
   ========================================================= */
function setState(s) {
  state = s;
  const b = $('#btnSpeak');
  b.textContent = s === 'idle' ? '🔊' : s === 'busy' ? '⏳' : '⏹';
  b.classList.toggle('active', s !== 'idle');
  $('#vsPlay').textContent = s === 'speaking' ? '⏹ Detener' : '▶ Leer';
}
function setStatus(t) { $('#vsStatus').textContent = t; }

function showSheet(blocks, status) {
  $('#voiceSheet').hidden = false;
  document.body.classList.add('sheet-open');
  setStatus(status);
  const list = $('#vsList');
  list.innerHTML = '';
  blocks.forEach((b, i) => {
    const el = document.createElement('div');
    el.className = 'vs-block';
    el.dataset.i = i;
    if (b.speaker) {
      const who = document.createElement('span'); who.className = 'vs-who'; who.textContent = b.speaker;
      el.append(who);
    }
    const tx = document.createElement('div');
    tx.className = 'vs-text'; tx.contentEditable = 'true'; tx.spellcheck = false; tx.textContent = b.text;
    tx.oninput = () => { b.text = tx.textContent; };
    const play = document.createElement('button');
    play.className = 'vs-from'; play.textContent = '▶'; play.setAttribute('aria-label', 'Leer desde aquí');
    play.onclick = () => speakBlocks(blocksFromSheet(), i);
    el.append(tx, play);
    list.append(el);
  });
  $('#vsPlay').disabled = !blocks.length;
}
function blocksFromSheet() {
  if (!current) return [];
  return current.blocks.filter((b) => b.text && b.text.trim());
}

function highlight(b, i) {
  hlBlock = b && b.rect ? b : null;
  document.querySelectorAll('.vs-block').forEach((el) => el.classList.toggle('reading', +el.dataset.i === i));
  const cur = document.querySelector('.vs-block.reading');
  cur?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  positionHighlight();
}

export function positionHighlight() {
  const hl = $('#readHL');
  if (!hlBlock) { hl.hidden = true; return; }
  const { img, s, tx, ty, bw } = ctx.view();
  const k = bw / img.naturalWidth;
  const r = hlBlock.rect, pad = 4;
  Object.assign(hl.style, {
    left: tx + r.x0 * k * s - pad + 'px', top: ty + r.y0 * k * s - pad + 'px',
    width: (r.x1 - r.x0) * k * s + pad * 2 + 'px', height: (r.y1 - r.y0) * k * s + pad * 2 + 'px',
  });
  hl.hidden = false;
}

export function closeSheet() {
  stop();
  $('#voiceSheet').hidden = true;
  document.body.classList.remove('sheet-open');
  current = null;
}
