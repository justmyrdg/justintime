import * as pdfjsLib from '/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

const $ = sel => document.querySelector(sel);
const icon = name => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

// Keep the viewer below the toolbar even when the toolbar wraps onto two lines.
const toolbar = $('.toolbar');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
}).observe(toolbar);

/* =====================================================================
   PDF VIEWER + PEN
   ===================================================================== */

const viewer = $('#viewer');
const pagesEl = $('#pages');
const thumbsEl = $('#thumbs');
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const THUMB_W = 150;
const SHAPES = ['line', 'arrow', 'rect'];
const INK_TOOLS = ['pen', 'highlighter', ...SHAPES];
const LINE_H = 1.25;
const textFont = size => `500 ${size}px "Segoe UI", system-ui, sans-serif`;
const round2 = v => Math.round(v * 100) / 100;

let pdfDoc = null;
let pdfFile = null;      // the opened File, kept for export (pdf.js takes ownership of the bytes it is given)
let docKey = null;
let scale = store.get('pdf:scale', 1.25);
let pages = [];          // { index, key, pdfPage (null = blank page), base: {width,height}, wrap, num, pdfCanvas, inkCanvas, renderedScale, task, thumb }
let ink = {};            // page key -> [stroke]; PDF pages use their 0-based number ("0", "1", …), blank pages "b…"
let undoStack = [];
let redoStack = [];
let presenting = null;   // { index, scale, cardMin } while in presentation mode
let shownPage = -1;      // page highlighted in the thumbnails

const pen = {
  tool: 'hand',
  color: '#111111',
  size: 3,
};

const dpr = () => window.devicePixelRatio || 1;
const pageByKey = key => pages.find(p => p.key === key);

async function openPdf(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('Please choose a PDF file.');
    return;
  }
  commitText();
  if (presenting) exitPresent();
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    if (pdfDoc) await pdfDoc.destroy();
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    console.error(err);
    alert('Could not open this PDF: ' + err.message);
    return;
  }
  pdfFile = file;
  docKey = `ink:${file.name}:${file.size}`;
  ink = store.get(docKey, {});
  undoStack = [];
  redoStack = [];
  $('#docName').textContent = file.name;
  $('#docName').title = file.name;
  $('#emptyState').classList.add('hidden');
  document.title = file.name + ' – Jas in Time';
  await buildPages();
  addRecent(file);
}

// Page order including inserted blank pages: PDF pages as "0", "1", …; blank pages as { key, width, height }.
function loadLayout() {
  const n = pdfDoc.numPages;
  const fallback = Array.from({ length: n }, (_, i) => String(i));
  const saved = store.get(docKey + ':layout', null);
  if (!Array.isArray(saved)) return fallback;
  const pdfKeys = saved.filter(e => typeof e === 'string');
  const valid = pdfKeys.length === n && new Set(pdfKeys).size === n && pdfKeys.every(k => /^\d+$/.test(k) && +k < n);
  if (!valid) return fallback;
  return saved.filter(e => typeof e === 'string' || (e && /^b\w+$/.test(e.key) && e.width > 0 && e.height > 0));
}

function saveLayout() {
  if (!docKey) return;
  const blanks = pages.some(p => !p.pdfPage);
  if (!blanks) { try { localStorage.removeItem(docKey + ':layout'); } catch { /* blocked */ } return; }
  store.set(docKey + ':layout', pages.map(p => (p.pdfPage ? p.key : { key: p.key, width: p.base.width, height: p.base.height })));
}

async function buildPages() {
  pageObserver.disconnect();
  thumbObserver.disconnect();
  pagesEl.innerHTML = '';
  thumbsEl.innerHTML = '';
  pages = [];
  for (const entry of loadLayout()) {
    if (typeof entry === 'string') {
      const pdfPage = await pdfDoc.getPage(+entry + 1);
      const vp = pdfPage.getViewport({ scale: 1 });
      pages.push(makePage(entry, pdfPage, { width: vp.width, height: vp.height }));
    } else {
      pages.push(makePage(entry.key, null, { width: entry.width, height: entry.height }));
    }
  }
  renumberPages();
  layout();
  viewer.scrollTop = 0;
  updateCurrentPage();
}

function makePage(key, pdfPage, base) {
  const wrap = document.createElement('div');
  wrap.className = 'page' + (pdfPage ? '' : ' blank');
  const pdfCanvas = document.createElement('canvas');
  const inkCanvas = document.createElement('canvas');
  inkCanvas.className = 'ink';
  const num = document.createElement('span');
  num.className = 'page-num';
  wrap.append(pdfCanvas, inkCanvas, num);
  const p = { index: 0, key, pdfPage, base, wrap, num, pdfCanvas, inkCanvas, renderedScale: 0, task: null };
  if (!pdfPage) {
    const del = document.createElement('button');
    del.className = 'page-del';
    del.title = 'Delete this blank page';
    del.innerHTML = icon('x');
    del.addEventListener('click', () => deleteBlankPage(p));
    wrap.append(del);
  }
  attachInkHandlers(p);
  p.thumb = makeThumb(p);
  pageObserver.observe(wrap);
  thumbObserver.observe(p.thumb.el);
  return p;
}

function renumberPages() {
  pages.forEach((p, i) => {
    p.index = i;
    p.wrap.dataset.index = i;
    p.thumb.el.dataset.index = i;
    p.num.textContent = p.pdfPage ? i + 1 : `${i + 1} · whiteboard`;
    p.thumb.label.textContent = i + 1;
    p.thumb.el.classList.remove('current');
    pagesEl.append(p.wrap);
    thumbsEl.append(p.thumb.el);
  });
  shownPage = -1;
  $('#pageCount').textContent = '/ ' + pages.length;
  $('#pageInput').max = pages.length;
}

function sizePage(p) {
  const w = Math.floor(p.base.width * scale);
  const h = Math.floor(p.base.height * scale);
  p.wrap.style.width = w + 'px';
  p.wrap.style.height = h + 'px';
  p.inkCanvas.width = Math.floor(w * dpr());
  p.inkCanvas.height = Math.floor(h * dpr());
  drawInk(p);
  if (p.visible) renderPdfPage(p);
}

function layout() {
  pages.forEach(sizePage);
  $('#zoomLabel').textContent = Math.round(scale * 100) + '%';
}

async function renderPdfPage(p) {
  if (!p.pdfPage || p.renderedScale === scale * dpr()) return;
  if (p.task) { p.task.cancel(); p.task = null; }
  const targetScale = scale * dpr();
  const vp = p.pdfPage.getViewport({ scale: targetScale });
  // Render off-screen first so the old image stays visible until the new one is ready.
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  const task = p.pdfPage.render({ canvasContext: off.getContext('2d'), viewport: vp });
  p.task = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
    return;
  }
  if (p.task !== task) return;
  p.task = null;
  p.pdfCanvas.width = off.width;
  p.pdfCanvas.height = off.height;
  p.pdfCanvas.getContext('2d').drawImage(off, 0, 0);
  p.renderedScale = targetScale;
}

const pageObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const p = pages[+entry.target.dataset.index];
    if (!p) continue;
    p.visible = entry.isIntersecting;
    if (p.visible) renderPdfPage(p);
  }
}, { root: viewer, rootMargin: '800px 0px' });

function setScale(newScale, anchor) {
  commitText();
  newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  if (!pdfDoc || Math.abs(newScale - scale) < 0.001) { scale = newScale; return; }
  // Keep the point under the anchor (or the view center) steady while zooming.
  const rect = viewer.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : viewer.clientWidth / 2;
  const ay = anchor ? anchor.y - rect.top : viewer.clientHeight / 2;
  const ratio = newScale / scale;
  const contentX = viewer.scrollLeft + ax;
  const contentY = viewer.scrollTop + ay;
  scale = newScale;
  store.set('pdf:scale', scale);
  layout();
  viewer.scrollLeft = contentX * ratio - ax;
  viewer.scrollTop = contentY * ratio - ay;
}

function fitWidth() {
  if (!pages.length || presenting) return;
  const maxW = Math.max(...pages.map(p => p.base.width));
  setScale((viewer.clientWidth - 48) / maxW);
}

function currentPageIndex() {
  if (presenting) return presenting.index;
  const mid = viewer.scrollTop + viewer.clientHeight / 3;
  let best = 0;
  for (const p of pages) {
    if (p.wrap.offsetTop <= mid) best = p.index;
    else break;
  }
  return best;
}

function updateCurrentPage() {
  if (!pages.length) return;
  const i = currentPageIndex();
  $('#pageInput').value = i + 1;
  $('#dockPage').textContent = `${i + 1} / ${pages.length}`;
  if (i === shownPage) return;
  pages[shownPage]?.thumb.el.classList.remove('current');
  shownPage = i;
  pages[i].thumb.el.classList.add('current');
  if (!thumbsEl.classList.contains('hidden')) pages[i].thumb.el.scrollIntoView({ block: 'nearest' });
}

function goToPage(n) {
  if (!pages.length) return;
  n = Math.max(1, Math.min(pages.length, n));
  if (presenting) return showPresentPage(n - 1);
  viewer.scrollTop = pages[n - 1].wrap.offsetTop - 12;
  updateCurrentPage();
}

/* ----- Thumbnails ----- */

function makeThumb(p) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'thumb';
  const box = document.createElement('div');
  box.className = 'thumb-page';
  const w = THUMB_W;
  const h = Math.round((THUMB_W * p.base.height) / p.base.width);
  box.style.width = w + 'px';
  box.style.height = h + 'px';
  const pdfCanvas = document.createElement('canvas');
  const inkCanvas = document.createElement('canvas');
  inkCanvas.width = Math.floor(w * dpr());
  inkCanvas.height = Math.floor(h * dpr());
  box.append(pdfCanvas, inkCanvas);
  const label = document.createElement('span');
  label.className = 'thumb-num';
  el.append(box, label);
  el.addEventListener('click', () => goToPage(p.index + 1));
  return { el, pdfCanvas, inkCanvas, label, scale: w / p.base.width, rendered: false };
}

function renderThumb(p) {
  const t = p.thumb;
  if (t.rendered) return;
  t.rendered = true;
  drawThumbInk(p);
  if (!p.pdfPage) return;
  const vp = p.pdfPage.getViewport({ scale: t.scale * dpr() });
  t.pdfCanvas.width = Math.floor(vp.width);
  t.pdfCanvas.height = Math.floor(vp.height);
  p.pdfPage.render({ canvasContext: t.pdfCanvas.getContext('2d'), viewport: vp }).promise
    .catch(err => { t.rendered = false; if (err?.name !== 'RenderingCancelledException') console.error(err); });
}

function drawThumbInk(p) {
  const t = p.thumb;
  if (!t?.rendered) return;
  const ctx = t.inkCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, t.inkCanvas.width, t.inkCanvas.height);
  ctx.setTransform(t.scale * dpr(), 0, 0, t.scale * dpr(), 0, 0);
  for (const s of ink[p.key] || []) drawStroke(ctx, s);
}

const thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const p = pages[+entry.target.dataset.index];
    if (p && entry.isIntersecting) renderThumb(p);
  }
}, { root: thumbsEl, rootMargin: '400px 0px' });

function setThumbsOpen(open) {
  thumbsEl.classList.toggle('hidden', !open);
  document.body.classList.toggle('thumbs-open', open);
  $('#thumbsToggle').classList.toggle('active', open);
  store.set('pdf:thumbs', open);
  shownPage = -1;
  updateCurrentPage();
}

/* ----- Blank whiteboard pages ----- */

function insertBlankPage() {
  if (!pages.length) return;
  commitText();
  const cur = pages[currentPageIndex()];
  const p = makePage('b' + Date.now().toString(36), null, { ...cur.base });
  pages.splice(cur.index + 1, 0, p);
  renumberPages();
  sizePage(p);
  saveLayout();
  goToPage(p.index + 1);
}

function deleteBlankPage(p) {
  if ((ink[p.key] || []).length && !confirm(`Delete whiteboard page ${p.index + 1} and its drawings?`)) return;
  commitText();
  pageObserver.unobserve(p.wrap);
  thumbObserver.unobserve(p.thumb.el);
  p.wrap.remove();
  p.thumb.el.remove();
  pages.splice(p.index, 1);
  delete ink[p.key];
  undoStack = undoStack.filter(h => h.page !== p.key);
  redoStack = redoStack.filter(h => h.page !== p.key);
  saveInk();
  renumberPages();
  saveLayout();
  if (presenting) showPresentPage(Math.min(presenting.index, pages.length - 1));
  else updateCurrentPage();
}

/* ----- Ink drawing ----- */

function drawStroke(ctx, s) {
  const pts = s.pts;
  if (!pts.length) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'text') {
    ctx.font = textFont(s.size);
    ctx.textBaseline = 'top';
    s.text.split('\n').forEach((line, i) => ctx.fillText(line, pts[0][0], pts[0][1] + i * s.size * LINE_H));
  } else if (SHAPES.includes(s.tool)) {
    const [[x0, y0], [x1, y1]] = pts;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    if (s.tool === 'rect') {
      ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.stroke();
    } else if (s.tool === 'line') {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else {
      // Arrow: shaft stops inside the head so the round cap doesn't poke through the tip.
      const a = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.min(Math.max(s.width * 4, 10), Math.hypot(x1 - x0, y1 - y0) * 0.6);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - Math.cos(a) * head * 0.6, y1 - Math.sin(a) * head * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45));
      ctx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
      ctx.closePath();
      ctx.fill();
    }
  } else if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
    ctx.stroke();
  } else if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], (s.width * pressureFactor(pts[0][2])) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Smooth pen: quadratic curves through midpoints, width varies with pressure.
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = i > 1 ? mid(pts[i - 2], pts[i - 1]) : pts[0];
      const [cx, cy] = pts[i - 1];
      const [x1, y1] = i < pts.length - 1 ? mid(pts[i - 1], pts[i]) : pts[i];
      ctx.lineWidth = s.width * pressureFactor(pts[i][2]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const pressureFactor = p => (p === undefined || p === null ? 1 : 0.4 + p * 1.2);

function drawInk(p, extra) {
  const ctx = p.inkCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, p.inkCanvas.width, p.inkCanvas.height);
  // Strokes are stored in PDF units (scale 1), so they survive zooming.
  ctx.setTransform(scale * dpr(), 0, 0, scale * dpr(), 0, 0);
  for (const s of ink[p.key] || []) drawStroke(ctx, s);
  if (extra) drawStroke(ctx, extra);
}

function saveInk() {
  if (docKey) store.set(docKey, ink);
}

function inkChanged(key) {
  const p = pageByKey(key);
  if (p) { drawInk(p); drawThumbInk(p); }
  saveInk();
}

function pushHistory(key, before) {
  undoStack.push({ page: key, before, after: (ink[key] || []).slice() });
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  inkChanged(key);
}

function undo() {
  commitText();
  const h = undoStack.pop();
  if (!h) return;
  ink[h.page] = h.before.slice();
  redoStack.push(h);
  inkChanged(h.page);
}

function redo() {
  commitText();
  const h = redoStack.pop();
  if (!h) return;
  ink[h.page] = h.after.slice();
  undoStack.push(h);
  inkChanged(h.page);
}

function clearCurrentPage() {
  if (!pages.length) return;
  commitText();
  const p = pages[currentPageIndex()];
  if (!(ink[p.key] || []).length) return;
  if (!confirm(`Clear all ink on page ${p.index + 1}?`)) return;
  const before = ink[p.key].slice();
  ink[p.key] = [];
  pushHistory(p.key, before);
}

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

const measureCtx = document.createElement('canvas').getContext('2d');

function textBounds(s) {
  measureCtx.font = textFont(s.size);
  const lines = s.text.split('\n');
  const w = Math.max(...lines.map(l => measureCtx.measureText(l).width));
  return { x: s.pts[0][0], y: s.pts[0][1], w, h: lines.length * s.size * LINE_H };
}

function strokeHit(s, x, y, radius) {
  if (s.tool === 'text') {
    const b = textBounds(s);
    return x >= b.x - radius && x <= b.x + b.w + radius && y >= b.y - radius && y <= b.y + b.h + radius;
  }
  const r = radius + s.width / 2;
  let pts = s.pts;
  if (s.tool === 'rect') {
    const [[x0, y0], [x1, y1]] = pts;
    pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  }
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= r;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1], pts[i]) <= r) return true;
  }
  return false;
}

// Shift: lines/arrows snap to 45° steps, rectangles become squares.
function shapeEnd(tool, [x0, y0], [x, y], snap) {
  if (!snap) return [x, y];
  const dx = x - x0;
  const dy = y - y0;
  if (tool === 'rect') {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d];
  }
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = Math.hypot(dx, dy);
  return [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len];
}

function attachInkHandlers(p) {
  const c = p.inkCanvas;
  let active = null; // { pointerId, stroke?, before, erased }

  const toPdf = e => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
  };
  const pressureOf = e => (e.pointerType === 'pen' ? e.pressure : undefined);

  const eraseAt = (x, y) => {
    const list = ink[p.key] || [];
    const radius = (pen.size * 3) / scale;
    const kept = list.filter(s => !strokeHit(s, x, y, radius));
    if (kept.length !== list.length) {
      ink[p.key] = kept;
      active.erased = true;
      drawInk(p);
    }
  };

  c.addEventListener('pointerdown', e => {
    if (pen.tool === 'hand' || pen.tool === 'laser' || active) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    const [x, y] = toPdf(e);
    if (pen.tool === 'text') {
      commitText();
      const hit = (ink[p.key] || []).findLast(s => s.tool === 'text' && strokeHit(s, x, y, 2 / scale));
      openTextEditor(p, x, y, hit);
      return;
    }
    c.setPointerCapture(e.pointerId);
    active = { pointerId: e.pointerId, before: (ink[p.key] || []).slice(), erased: false };
    if (pen.tool === 'eraser') {
      eraseAt(x, y);
    } else {
      const hl = pen.tool === 'highlighter';
      const shape = SHAPES.includes(pen.tool);
      active.stroke = {
        tool: pen.tool,
        color: pen.color,
        width: (hl ? pen.size * 5 : pen.size) / scale,
        pts: shape ? [[x, y], [x, y]] : [hl ? [x, y] : [x, y, pressureOf(e)]],
      };
      drawInk(p, active.stroke);
    }
  });

  c.addEventListener('pointermove', e => {
    if (!active || e.pointerId !== active.pointerId) return;
    const s = active.stroke;
    if (s && SHAPES.includes(s.tool)) {
      s.pts[1] = shapeEnd(s.tool, s.pts[0], toPdf(e), e.shiftKey);
      drawInk(p, s);
      return;
    }
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = toPdf(ev);
      if (pen.tool === 'eraser') eraseAt(x, y);
      else if (s) {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 0.4 / scale) continue;
        s.pts.push(s.tool === 'highlighter' ? [x, y] : [x, y, pressureOf(ev)]);
      }
    }
    if (s) drawInk(p, s);
  });

  const finish = e => {
    if (!active || e.pointerId !== active.pointerId) return;
    const s = active.stroke;
    if (s) {
      // A click with a shape tool (no drag) draws nothing.
      const tooSmall = SHAPES.includes(s.tool) && Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]) < 2 / scale;
      if (!tooSmall) {
        // Round coordinates to keep saved annotations small.
        s.pts = s.pts.map(pt => pt.map(v => (v === undefined ? v : round2(v))));
        ink[p.key] = [...(ink[p.key] || []), s];
        pushHistory(p.key, active.before);
      }
      drawInk(p);
    } else if (active.erased) {
      pushHistory(p.key, active.before);
    }
    active = null;
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
}

/* ----- Text boxes ----- */

let textEdit = null; // { p, ta, x, y, size, color, before }

function openTextEditor(p, x, y, existing) {
  const size = existing ? existing.size : (10 + pen.size * 2) / scale;
  const color = existing ? existing.color : pen.color;
  const before = (ink[p.key] || []).slice();
  if (existing) {
    [x, y] = existing.pts[0];
    ink[p.key] = before.filter(s => s !== existing);
    drawInk(p);
  } else {
    y = Math.max(0, y - (size * LINE_H) / 2); // put the click in the middle of the first line
  }
  const px = size * scale;
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.spellcheck = false;
  ta.value = existing ? existing.text : '';
  ta.style.left = x * scale + 'px';
  ta.style.top = y * scale + 'px';
  ta.style.font = textFont(px);
  ta.style.lineHeight = LINE_H;
  ta.style.color = color;
  const fit = () => {
    measureCtx.font = textFont(px);
    const lines = ta.value.split('\n');
    ta.style.width = Math.max(px * 2, ...lines.map(l => measureCtx.measureText(l).width)) + px + 'px';
    ta.style.height = lines.length * px * LINE_H + 'px';
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
  });
  ta.addEventListener('blur', () => commitText());
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  p.wrap.append(ta);
  fit();
  textEdit = { p, ta, x, y, size, color, before };
  setTimeout(() => ta.focus());
}

function commitText() {
  if (!textEdit) return;
  const { p, ta, x, y, size, color, before } = textEdit;
  textEdit = null;
  ta.remove();
  const text = ta.value.replace(/\s+$/, '');
  if (text) {
    ink[p.key] = [...(ink[p.key] || []), { tool: 'text', color, size: round2(size), width: 0, text, pts: [[round2(x), round2(y)]] }];
  }
  if (text || (ink[p.key] || []).length !== before.length) pushHistory(p.key, before);
  else drawInk(p);
}

function cancelText() {
  if (!textEdit) return;
  const { p, ta, before } = textEdit;
  textEdit = null;
  ta.remove();
  ink[p.key] = before;
  drawInk(p);
}

/* ----- Laser pointer ----- */

const laserCanvas = $('#laserCanvas');
const LASER_FADE = 450; // ms a trail point stays visible
const laser = { trail: [], pos: null, raf: 0 };

function sizeLaser() {
  laserCanvas.width = Math.floor(window.innerWidth * dpr());
  laserCanvas.height = Math.floor(window.innerHeight * dpr());
}

function drawLaser() {
  laser.raf = 0;
  const ctx = laserCanvas.getContext('2d');
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const now = performance.now();
  laser.trail = laser.trail.filter(pt => now - pt[2] < LASER_FADE);
  const tr = laser.trail;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  for (let i = 1; i < tr.length; i++) {
    const k = 1 - (now - tr[i][2]) / LASER_FADE;
    ctx.strokeStyle = `rgba(255, 40, 40, ${k * 0.75})`;
    ctx.lineWidth = 2 + k * 5;
    ctx.beginPath();
    ctx.moveTo(tr[i - 1][0], tr[i - 1][1]);
    ctx.lineTo(tr[i][0], tr[i][1]);
    ctx.stroke();
  }
  if (laser.pos) {
    const [x, y] = laser.pos;
    ctx.shadowColor = 'rgba(255, 0, 0, .9)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ff2b2b';
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, .85)';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (tr.length) laser.raf = requestAnimationFrame(drawLaser);
}

const kickLaser = () => { if (!laser.raf) laser.raf = requestAnimationFrame(drawLaser); };

viewer.addEventListener('pointermove', e => {
  if (pen.tool !== 'laser') return;
  laser.pos = [e.clientX, e.clientY];
  laser.trail.push([e.clientX, e.clientY, performance.now()]);
  kickLaser();
});
viewer.addEventListener('pointerleave', () => {
  if (!laser.pos) return;
  laser.pos = null;
  kickLaser();
});

/* ----- Presentation mode ----- */

function enterPresent() {
  if (!pages.length || presenting) return;
  commitText();
  presenting = { index: currentPageIndex(), scale, cardMin: card.classList.contains('minimized') };
  document.body.classList.add('present');
  setMinimized(true);
  showPresentPage(presenting.index);
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function exitPresent() {
  if (!presenting) return;
  commitText();
  const { index, scale: oldScale, cardMin } = presenting;
  presenting = null;
  pages[index]?.wrap.classList.remove('shown');
  document.body.classList.remove('present');
  setMinimized(cardMin);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  scale = oldScale;
  layout();
  goToPage(index + 1);
}

function fitPresent() {
  if (!presenting) return;
  const p = pages[presenting.index];
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
    Math.min((viewer.clientWidth - 24) / p.base.width, (viewer.clientHeight - 24) / p.base.height)));
  if (Math.abs(s - scale) > 0.001) { scale = s; layout(); }
}

function showPresentPage(i) {
  commitText();
  i = Math.max(0, Math.min(pages.length - 1, i));
  pages[presenting.index]?.wrap.classList.remove('shown');
  presenting.index = i;
  pages[i].wrap.classList.add('shown');
  fitPresent();
  renderPdfPage(pages[i]);
  updateCurrentPage();
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && presenting) exitPresent();
  else if (presenting) setTimeout(fitPresent, 50);
});

/* ----- Export annotated PDF ----- */

let pdfLibPromise = null;
function loadPdfLib() {
  pdfLibPromise ??= import('/pdflib/pdf-lib.esm.min.js').catch(err => {
    pdfLibPromise = null;
    throw new Error('Could not load pdf-lib — run "npm install" and restart the server. (' + err.message + ')');
  });
  return pdfLibPromise;
}

async function inkPng(p) {
  const k = Math.min(3, 4000 / Math.max(p.base.width, p.base.height));
  const c = document.createElement('canvas');
  c.width = Math.ceil(p.base.width * k);
  c.height = Math.ceil(p.base.height * k);
  const ctx = c.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const s of ink[p.key]) drawStroke(ctx, s);
  const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportPdf() {
  if (!pdfDoc || !pdfFile) { alert('Open a PDF first.'); return; }
  commitText();
  const btn = $('#exportBtn');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Exporting…';
  try {
    const { PDFDocument, degrees } = await loadPdfLib();
    const src = await PDFDocument.load(await pdfFile.arrayBuffer(), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pages.filter(p => p.pdfPage).map(p => +p.key));
    let next = 0;
    for (const p of pages) {
      const page = p.pdfPage ? out.addPage(copied[next++]) : out.addPage([p.base.width, p.base.height]);
      if (!(ink[p.key] || []).length) continue;
      const img = await out.embedPng(await inkPng(p));
      // Ink is stored in the page's displayed orientation; map it back onto the unrotated page.
      const { x, y, width: W, height: H } = page.getCropBox();
      const rot = ((page.getRotation().angle % 360) + 360) % 360;
      const at = { 90: [x + W, y], 180: [x + W, y + H], 270: [x, y + H] }[rot] || [x, y];
      page.drawImage(img, {
        x: at[0],
        y: at[1],
        width: p.base.width,
        height: p.base.height,
        rotate: degrees([90, 180, 270].includes(rot) ? rot : 0),
      });
    }
    const bytes = await out.save();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = pdfFile.name.replace(/\.pdf$/i, '') + ' (annotated).pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    console.error(err);
    alert('Export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    label.textContent = 'Export';
  }
}

/* ----- Recently opened PDFs (kept in IndexedDB so they reopen with one click) ----- */

const RECENT_MAX = 8;

function recentTx(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('index-card', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('recent', { keyPath: 'id' });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('recent', mode);
      const r = fn(tx.objectStore('recent'));
      tx.oncomplete = () => { db.close(); resolve(r?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function listRecent() {
  try {
    const all = await recentTx('readonly', s => s.getAll());
    return (all || []).sort((a, b) => b.opened - a.opened);
  } catch { return []; }
}

async function addRecent(file) {
  try {
    await recentTx('readwrite', s => s.put({ id: `${file.name}:${file.size}`, name: file.name, size: file.size, opened: Date.now(), file }));
    const old = (await listRecent()).slice(RECENT_MAX);
    if (old.length) await recentTx('readwrite', s => old.forEach(r => s.delete(r.id)));
  } catch (err) {
    console.warn('Could not save to the recent list', err);
  }
  renderRecent();
}

function formatWhen(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return 'Today ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

async function renderRecent() {
  const list = await listRecent();
  const menu = $('#recentMenu');
  const empty = $('#recentEmpty');
  menu.innerHTML = '';
  empty.innerHTML = '';
  if (!list.length) {
    menu.innerHTML = '<div class="menu-empty">No recent PDFs yet</div>';
    return;
  }
  const title = document.createElement('div');
  title.className = 'recent-title';
  title.textContent = 'Recent';
  empty.append(title);
  list.forEach((r, i) => {
    for (const [target, cls] of [[menu, 'menu-item'], [empty, 'recent-item']]) {
      if (target === empty && i >= 5) continue;
      const b = document.createElement('button');
      b.className = cls;
      b.title = r.name;
      b.innerHTML = icon('file-text') + '<span class="r-name"></span><span class="r-when"></span>';
      b.querySelector('.r-name').textContent = r.name;
      b.querySelector('.r-when').textContent = formatWhen(r.opened);
      b.addEventListener('click', () => { $('#recentMenu').classList.add('hidden'); openPdf(r.file); });
      target.append(b);
    }
  });
  const clear = document.createElement('button');
  clear.className = 'menu-item menu-clear';
  clear.innerHTML = icon('trash') + '<span class="r-name">Clear list</span>';
  clear.addEventListener('click', async () => {
    await recentTx('readwrite', s => s.clear()).catch(() => {});
    $('#recentMenu').classList.add('hidden');
    renderRecent();
  });
  menu.append(clear);
}

$('#recentBtn').addEventListener('click', () => $('#recentMenu').classList.toggle('hidden'));
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.menu-wrap')) $('#recentMenu').classList.add('hidden');
});

/* ----- Toolbar wiring ----- */

function setTool(tool) {
  if (tool !== 'text') commitText();
  pen.tool = tool;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  const cl = document.body.classList;
  cl.toggle('hand', tool === 'hand');
  cl.toggle('drawing', INK_TOOLS.includes(tool));
  cl.toggle('erasing', tool === 'eraser');
  cl.toggle('texting', tool === 'text');
  cl.toggle('lasering', tool === 'laser');
  if (tool !== 'laser') {
    laser.pos = null;
    laser.trail = [];
    drawLaser();
  }
}

function setColor(color) {
  pen.color = color;
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === color));
  if (textEdit) {
    textEdit.color = color;
    textEdit.ta.style.color = color;
    textEdit.ta.focus();
  } else if (['hand', 'eraser', 'laser'].includes(pen.tool)) setTool('pen');
}

document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('.swatch').forEach(s => s.addEventListener('click', () => setColor(s.dataset.color)));
// Keep the text box focused when picking a color.
document.querySelectorAll('.swatch').forEach(s => s.addEventListener('pointerdown', e => textEdit && e.preventDefault()));
$('#customColor').addEventListener('input', e => setColor(e.target.value));
$('#sizeInput').addEventListener('input', e => { pen.size = +e.target.value; });
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#clearPageBtn').addEventListener('click', clearCurrentPage);
$('#zoomIn').addEventListener('click', () => setScale(scale * 1.2));
$('#zoomOut').addEventListener('click', () => setScale(scale / 1.2));
$('#fitWidth').addEventListener('click', fitWidth);
$('#prevPage').addEventListener('click', () => goToPage(currentPageIndex()));
$('#nextPage').addEventListener('click', () => goToPage(currentPageIndex() + 2));
$('#pageInput').addEventListener('change', e => goToPage(+e.target.value));
$('#addBlank').addEventListener('click', insertBlankPage);
$('#thumbsToggle').addEventListener('click', () => setThumbsOpen(thumbsEl.classList.contains('hidden')));
$('#exportBtn').addEventListener('click', exportPdf);
$('#presentBtn').addEventListener('click', enterPresent);
$('#dockPrev').addEventListener('click', () => goToPage(currentPageIndex()));
$('#dockNext').addEventListener('click', () => goToPage(currentPageIndex() + 2));
$('#dockUndo').addEventListener('click', undo);
$('#dockBlank').addEventListener('click', insertBlankPage);
$('#dockExit').addEventListener('click', exitPresent);
$('#fileInput').addEventListener('change', e => { openPdf(e.target.files[0]); e.target.value = ''; });
viewer.addEventListener('scroll', updateCurrentPage, { passive: true });

let lastWheelFlip = 0;
viewer.addEventListener('wheel', e => {
  if (presenting) {
    // One page per wheel gesture.
    e.preventDefault();
    const now = performance.now();
    if (Math.abs(e.deltaY) < 4 || now - lastWheelFlip < 350) return;
    lastWheelFlip = now;
    goToPage(presenting.index + 1 + Math.sign(e.deltaY));
    return;
  }
  if (!e.ctrlKey) return;
  e.preventDefault();
  setScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
}, { passive: false });

let resizeTimer;
window.addEventListener('resize', () => {
  sizeLaser();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (presenting) fitPresent();
    else if (pages.length) layout();
    clampCard();
  }, 150);
});

// Drag & drop a PDF anywhere
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropOverlay').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.add('hidden'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.add('hidden');
  openPdf(e.dataTransfer.files[0]);
});

sizeLaser();
setTool('hand');
setThumbsOpen(store.get('pdf:thumbs', false));
renderRecent();

/* =====================================================================
   INDEX CARD (students + points, stored in students.csv on the server)
   ===================================================================== */

const card = $('#card');
let students = [];
let maxPoints = 30;
let classes = [];
let currentClass = store.get('card:class', null);
let currentId = null;
let sortMode = store.get('card:sort', 'csv');
let randomBag = [];

const studentsUrl = () => `/api/classes/${encodeURIComponent(currentClass)}/students`;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showStatus(msg) {
  $('#cardStatus').textContent = msg || '';
}

/* ----- Classes (each section + subject has its own CSV and its own points) ----- */

async function loadClasses(select) {
  try {
    classes = (await api('GET', '/api/classes')).classes;
  } catch {
    showStatus('Cannot reach the server. Is "node server.js" running?');
    return;
  }
  if (select) currentClass = select;
  if (!classes.includes(currentClass)) currentClass = classes[0] ?? null;
  renderClassSelect();
  await switchClass(currentClass);
}

function renderClassSelect() {
  const sel = $('#classSelect');
  sel.innerHTML = '';
  for (const c of classes) sel.append(new Option(c, c));
  sel.append(new Option('──────────', '', false, false));
  sel.lastChild.disabled = true;
  sel.append(new Option('New class…', '__new'));
  sel.append(new Option('Rename this class…', '__rename'));
  sel.value = currentClass;
}

async function switchClass(name) {
  currentClass = name;
  store.set('card:class', name);
  currentId = store.get('card:currentId:' + name, null);
  randomBag = [];
  students = [];
  $('#classSelect').value = name;
  await loadStudents();
}

async function newClass() {
  const name = prompt('New class name (e.g. "Section A – Embedded Systems"):');
  if (!name || !name.trim()) return;
  let copyFrom = null;
  if (currentClass && students.length &&
      confirm(`Copy the ${students.length} student names from "${currentClass}"?\n(Points start at 0.)\n\nOK = copy names · Cancel = start empty`)) {
    copyFrom = currentClass;
  }
  try {
    const res = await api('POST', '/api/classes', { name: name.trim(), copyFrom });
    await loadClasses(res.name);
  } catch (err) { showStatus(err.message); }
}

async function renameClass() {
  if (!currentClass) return;
  const name = prompt('Rename class:', currentClass);
  if (!name || !name.trim() || name.trim() === currentClass) return;
  try {
    const oldKey = 'card:currentId:' + currentClass;
    const res = await api('PATCH', `/api/classes/${encodeURIComponent(currentClass)}`, { name: name.trim() });
    store.set('card:currentId:' + res.name, store.get(oldKey, null));
    await loadClasses(res.name);
  } catch (err) { showStatus(err.message); }
}

$('#classSelect').addEventListener('change', e => {
  const v = e.target.value;
  e.target.value = currentClass; // menu actions shouldn't stay selected
  if (v === '__new') newClass();
  else if (v === '__rename') renameClass();
  else if (v) switchClass(v);
});

async function loadStudents() {
  if (!currentClass) { renderCard(); return; }
  try {
    const data = await api('GET', studentsUrl());
    students = data.students;
    maxPoints = data.maxPoints;
    if (!students.some(s => s.id === currentId)) currentId = students[0]?.id ?? null;
    showStatus('');
  } catch (err) {
    showStatus(err.message === 'Failed to fetch' ? 'Cannot reach the server. Is "node server.js" running?' : err.message);
  }
  renderCard();
  await loadAttendance();
}

/* ----- Attendance (per class, per date: P / L / A / E) ----- */

const ATT = { P: 'Present', L: 'Late', A: 'Absent', E: 'Excused' };
let attendance = { date: null, day: {}, totals: {} };

// Local calendar date as YYYY-MM-DD (toISOString would use UTC and can be off by a day).
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayIso = () => isoDate(new Date());
let attDate = todayIso();

const attUrl = () => `/api/classes/${encodeURIComponent(currentClass)}/attendance`;

async function loadAttendance() {
  if (!currentClass) return;
  const cls = currentClass;
  const date = attDate;
  try {
    const data = await api('GET', `${attUrl()}?date=${date}`);
    if (cls !== currentClass || date !== attDate) return; // user switched while loading
    attendance = data;
  } catch (err) {
    showStatus('Could not load attendance: ' + err.message);
  }
  renderAttendance();
}

async function setAttendance(student, status) {
  if (!student) return;
  const old = attendance.day[student.id] || '';
  const next = old === status ? '' : status; // clicking the active status clears it
  if (next) attendance.day[student.id] = next; else delete attendance.day[student.id];
  renderAttendance();
  try {
    attendance = await api('POST', attUrl(), { date: attDate, id: student.id, status: next });
    showStatus('');
  } catch (err) {
    if (old) attendance.day[student.id] = old; else delete attendance.day[student.id];
    showStatus('Could not save attendance: ' + err.message);
  }
  renderAttendance();
}

function attButtons(student, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'att-btns';
  const cur = student ? attendance.day[student.id] : '';
  for (const [code, label] of Object.entries(ATT)) {
    const b = document.createElement('button');
    b.className = 'att-btn';
    b.dataset.s = code;
    b.textContent = code;
    b.title = label;
    b.disabled = !student;
    b.classList.toggle('on', cur === code);
    b.addEventListener('click', e => { e.stopPropagation(); onChange(code); });
    wrap.append(b);
  }
  return wrap;
}

function renderAttendance() {
  const s = currentStudent();
  const isToday = attDate === todayIso();
  $('#attRowLabel').textContent = isToday ? 'Today' : formatDate(attDate);
  $('#attCurrent').replaceWith(Object.assign(attButtons(s, code => setAttendance(s, code)), { id: 'attCurrent' }));

  $('#attDate').value = attDate;
  const counts = { P: 0, L: 0, A: 0, E: 0 };
  for (const v of Object.values(attendance.day)) counts[v]++;
  const unmarked = students.length - Object.keys(attendance.day).filter(id => students.some(x => x.id === +id)).length;
  $('#attSummary').innerHTML =
    Object.entries(ATT).map(([k, label]) => `<span>${label}: <b>${counts[k]}</b></span>`).join('') +
    `<span>Not marked: <b>${unmarked}</b></span>`;

  const ul = $('#attList');
  ul.innerHTML = '';
  if (!students.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No students in this class.';
    ul.append(li);
    return;
  }
  for (const st of orderedStudents()) {
    const li = document.createElement('li');
    li.classList.toggle('current', st.id === currentId);
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = st.name;
    const t = attendance.totals[st.id] || { A: 0, L: 0 };
    const abs = document.createElement('span');
    abs.className = 's-abs';
    abs.textContent = t.A ? `${t.A} abs` : '';
    abs.title = `All dates – absent: ${t.A || 0}, late: ${t.L || 0}`;
    li.addEventListener('click', () => selectStudent(st.id));
    li.append(name, abs, attButtons(st, code => setAttendance(st, code)));
    ul.append(li);
  }
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setAttDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  attDate = iso;
  attendance = { date: iso, day: {}, totals: attendance.totals };
  renderAttendance();
  loadAttendance();
}

function shiftAttDate(days) {
  const [y, m, d] = attDate.split('-').map(Number);
  setAttDate(isoDate(new Date(y, m - 1, d + days)));
}

function toggleAttendance(force) {
  const panel = $('#attPanel');
  const show = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  $('#attToggle').classList.toggle('open', show);
  store.set('card:attOpen', show);
  if (show && !$('#listPanel').classList.contains('hidden')) toggleList(false);
  clampCard();
}

$('#attToggle').addEventListener('click', () => toggleAttendance());
$('#attDate').addEventListener('change', e => setAttDate(e.target.value));
$('#attPrevDay').addEventListener('click', () => shiftAttDate(-1));
$('#attNextDay').addEventListener('click', () => shiftAttDate(1));
$('#attToday').addEventListener('click', () => setAttDate(todayIso()));
$('#attAllPresent').addEventListener('click', async () => {
  if (!currentClass || !students.length) return;
  try {
    attendance = await api('POST', attUrl(), { date: attDate, allUnmarked: 'P' });
    showStatus('');
  } catch (err) { showStatus(err.message); }
  renderAttendance();
});

// If the app is left open overnight, move to the new day when the tab regains focus.
let lastToday = todayIso();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const t = todayIso();
  if (t !== lastToday) {
    if (attDate === lastToday) setAttDate(t);
    lastToday = t;
  }
});

function orderedStudents() {
  const list = students.slice();
  if (sortMode === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  if (sortMode === 'points') list.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  return list;
}

// Navigation follows CSV or A–Z order; "points" order would reshuffle as you score.
function navOrder() {
  return sortMode === 'name' ? orderedStudents() : students;
}

const currentStudent = () => students.find(s => s.id === currentId) || null;

function selectStudent(id) {
  currentId = id;
  store.set('card:currentId:' + currentClass, id);
  renderCard();
}

function step(dir) {
  const list = navOrder();
  if (!list.length) return;
  const i = list.findIndex(s => s.id === currentId);
  selectStudent(list[(i + dir + list.length) % list.length].id);
}

function pickRandom() {
  if (!students.length) return;
  // Shuffle-bag: everyone gets called once before anyone repeats.
  randomBag = randomBag.filter(id => students.some(s => s.id === id));
  if (!randomBag.length) {
    randomBag = students.map(s => s.id);
    for (let i = randomBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [randomBag[i], randomBag[j]] = [randomBag[j], randomBag[i]];
    }
    if (randomBag.length > 1 && randomBag[randomBag.length - 1] === currentId) randomBag.unshift(randomBag.pop());
  }
  const nameEl = $('#studentName');
  let spins = 0;
  const spin = setInterval(() => {
    nameEl.textContent = students[Math.floor(Math.random() * students.length)].name;
    if (++spins >= 10) {
      clearInterval(spin);
      selectStudent(randomBag.pop());
    }
  }, 50);
}

async function changePoints(student, { delta, set }) {
  if (!student) return;
  const old = student.points;
  const next = Math.max(0, Math.min(maxPoints, set !== undefined ? set : old + delta));
  if (next === old) return;
  student.points = next; // optimistic
  renderCard(true);
  try {
    const updated = await api('POST', `${studentsUrl()}/${student.id}/points`, set !== undefined ? { set } : { delta });
    student.points = updated.points;
    showStatus('');
  } catch (err) {
    student.points = old;
    showStatus('Could not save points: ' + err.message);
  }
  renderCard();
}

function renderCard(bump) {
  const s = currentStudent();
  const order = navOrder();
  const pos = s ? order.findIndex(x => x.id === s.id) + 1 : 0;
  $('#cardCounter').textContent = `${pos} / ${students.length}`;
  $('#studentName').textContent = s ? s.name : (students.length ? 'Pick a student' : 'No students yet – add some below');
  $('#studentCode').textContent = s?.srcode || '';
  const pts = s ? s.points : 0;
  const pv = $('#pointsValue');
  pv.textContent = pts;
  document.querySelector('.points-max').textContent = `/ ${maxPoints}`;
  if (bump) { pv.classList.remove('bump'); void pv.offsetWidth; pv.classList.add('bump'); }
  $('#plusBtn').disabled = !s || pts >= maxPoints;

  // Progress dots are display-only: one per point.
  const dots = $('#dots');
  if (dots.children.length !== maxPoints) {
    dots.innerHTML = '';
    for (let i = 1; i <= maxPoints; i++) {
      const d = document.createElement('span');
      d.className = 'dot';
      dots.append(d);
    }
  }
  [...dots.children].forEach((d, i) => {
    d.classList.toggle('on', i < pts);
    d.classList.toggle('full', pts >= maxPoints);
  });

  renderList();
  renderAttendance();
}

function renderList() {
  const ul = $('#studentList');
  ul.innerHTML = '';
  const list = orderedStudents();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No students. Add names above or edit the class CSV in the data folder.';
    ul.append(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement('li');
    li.classList.toggle('current', s.id === currentId);
    li.title = 'Click to select · Double-click to rename';
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = s.name;
    if (s.srcode) name.title = s.srcode;
    const pts = document.createElement('span');
    pts.className = 's-pts';
    pts.textContent = `${s.points}/${maxPoints}`;
    const del = document.createElement('button');
    del.className = 's-del';
    del.title = 'Remove student';
    del.innerHTML = icon('x');
    del.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Remove ${s.name} from the class list?`)) return;
      try {
        await api('DELETE', `${studentsUrl()}/${s.id}`);
        students = students.filter(x => x.id !== s.id);
        if (currentId === s.id) currentId = students[0]?.id ?? null;
        renderCard();
      } catch (err) { showStatus(err.message); }
    });
    li.addEventListener('click', () => selectStudent(s.id));
    li.addEventListener('dblclick', async () => {
      const newName = prompt('Rename student:', s.name);
      if (!newName || !newName.trim() || newName.trim() === s.name) return;
      try {
        const updated = await api('PATCH', `${studentsUrl()}/${s.id}`, { name: newName.trim() });
        s.name = updated.name;
        renderCard();
      } catch (err) { showStatus(err.message); }
    });
    li.append(name, pts, del);
    ul.append(li);
  }
  const cur = ul.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function toggleList(force) {
  const panel = $('#listPanel');
  const show = force !== undefined ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  $('#listToggle').classList.toggle('open', show);
  store.set('card:listOpen', show);
  if (show && !$('#attPanel').classList.contains('hidden')) toggleAttendance(false);
  clampCard();
}

$('#plusBtn').addEventListener('click', () => changePoints(currentStudent(), { delta: 1 }));
$('#prevStudent').addEventListener('click', () => step(-1));
$('#nextStudent').addEventListener('click', () => step(1));
$('#randomStudent').addEventListener('click', pickRandom);
$('#studentName').addEventListener('click', () => toggleList(true));
$('#listToggle').addEventListener('click', () => toggleList());
$('#sortSelect').value = sortMode;
$('#sortSelect').addEventListener('change', e => {
  sortMode = e.target.value;
  store.set('card:sort', sortMode);
  renderCard();
});
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#addName');
  const name = input.value.trim();
  if (!name) return;
  try {
    const s = await api('POST', studentsUrl(), { name });
    students.push(s);
    input.value = '';
    selectStudent(s.id);
    showStatus('');
  } catch (err) { showStatus(err.message); }
});
$('#resetAll').addEventListener('click', async () => {
  if (!confirm('Reset EVERY student to 0 points? This cannot be undone.')) return;
  try {
    const data = await api('POST', `${studentsUrl()}/reset-all`);
    students = data.students;
    renderCard();
  } catch (err) { showStatus(err.message); }
});

/* ----- Card: drag, minimize, show/hide ----- */

function applyCardPos(pos) {
  if (!pos) return;
  card.style.left = pos.left + 'px';
  card.style.top = pos.top + 'px';
  card.style.right = 'auto';
  card.style.bottom = 'auto';
}

function clampCard() {
  if (card.style.left === '') return;
  const r = card.getBoundingClientRect();
  const left = Math.max(0, Math.min(window.innerWidth - r.width, r.left));
  const top = Math.max(0, Math.min(window.innerHeight - Math.min(r.height, 60), r.top));
  applyCardPos({ left, top });
}

(() => {
  const head = $('#cardHead');
  let drag = null;
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button, select')) return;
    const r = card.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    applyCardPos({ left: e.clientX - drag.dx, top: e.clientY - drag.dy });
    clampCard();
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    const r = card.getBoundingClientRect();
    store.set('card:pos', { left: r.left, top: r.top });
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
})();

function setMinimized(min) {
  card.classList.toggle('minimized', min);
  $('#cardMin').innerHTML = icon(min ? 'maximize' : 'minus');
  $('#cardMin').title = min ? 'Expand' : 'Minimize';
  store.set('card:min', min);
}

function setCardVisible(show) {
  card.classList.toggle('hidden-card', !show);
  store.set('card:visible', show);
  if (show) clampCard();
}

$('#cardMin').addEventListener('click', () => setMinimized(!card.classList.contains('minimized')));
$('#cardHead').addEventListener('dblclick', e => !e.target.closest('select') && setMinimized(!card.classList.contains('minimized')));
$('#toggleCard').addEventListener('click', () => setCardVisible(card.classList.contains('hidden-card')));

applyCardPos(store.get('card:pos', null));
setMinimized(store.get('card:min', false));
setCardVisible(store.get('card:visible', true));
toggleList(store.get('card:listOpen', false));
toggleAttendance(store.get('card:attOpen', false));

/* =====================================================================
   KEYBOARD SHORTCUTS
   ===================================================================== */

window.addEventListener('keydown', e => {
  const typing = e.target.closest('input, textarea, select');
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    return;
  }
  if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (presenting) {
    // Presenter remotes send PageDown/PageUp; Space/Backspace also flip slides.
    const flip = { ' ': 1, Backspace: -1, Home: -Infinity, End: Infinity }[e.key];
    if (flip !== undefined) {
      e.preventDefault();
      goToPage(Number.isFinite(flip) ? currentPageIndex() + 1 + (e.shiftKey ? -flip : flip) : flip > 0 ? pages.length : 1);
      return;
    }
    if (e.key === 'Escape') { exitPresent(); return; }
  }
  switch (e.key) {
    case 'v': case 'V': setTool('hand'); break;
    case 'p': case 'P': setTool('pen'); break;
    case 'h': case 'H': setTool('highlighter'); break;
    case 'e': case 'E': setTool('eraser'); break;
    case 'l': case 'L': setTool('laser'); break;
    case 'i': case 'I': setTool('line'); break;
    case 'a': case 'A': setTool('arrow'); break;
    case 'b': case 'B': setTool('rect'); break;
    case 't': case 'T': setTool('text'); break;
    case 's': case 'S': setThumbsOpen(thumbsEl.classList.contains('hidden')); break;
    case 'n': case 'N': insertBlankPage(); break;
    case 'f': case 'F': if (presenting) exitPresent(); else enterPresent(); break;
    case 'c': case 'C': setCardVisible(card.classList.contains('hidden-card')); break;
    case 'r': case 'R': pickRandom(); break;
    case 'ArrowRight': e.preventDefault(); step(1); break;
    case 'ArrowLeft': e.preventDefault(); step(-1); break;
    case 'ArrowUp': e.preventDefault(); changePoints(currentStudent(), { delta: 1 }); break;
    case 'ArrowDown': e.preventDefault(); changePoints(currentStudent(), { delta: -1 }); break;
    case 'PageDown': if (pages.length) { e.preventDefault(); goToPage(currentPageIndex() + 2); } break;
    case 'PageUp': if (pages.length) { e.preventDefault(); goToPage(currentPageIndex()); } break;
    default: return;
  }
});

loadClasses();
