// ── Graph (signal value over time) ────────────────────────────────────────────
// Self-contained module. All graph state + canvas rendering lives here.
//
// INTEGRATION POINTS - the only changes required in the main files:
//
//   sloppycan.js  ingestFrame(), after the J1939 hook:
//     if (window.graphIngestFrame) graphIngestFrame(frame);            // ← line A
//
//   sloppycan.js  switchViewTab():
//     + graph case (tab toggle + wrap show/hide + graphOnShow())
//
//   sloppycan.js  #frameBody contextmenu listener → window.graphContextMenu(x,y,key)
//
//   sloppycan.js  persistence: defaultWorkspaceData() adds graphSignals:[];
//     collectSettings() uses window.graphCollect(); applySettings() sets
//     window._graphPending and calls window.graphApply().
//
//   sloppycan.js  startup: window.graphScheduleSave = scheduleSave;
//
//   index.html    view-tabs: <button id="vtab-graph" …>Graph</button>
//   index.html    #graphWrap container (toolbar + canvas + legend) + #graphCtxMenu host
//   index.html    <script src="graph.js" defer></script>
//
// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.graph-toolbar {
  background:var(--bg2); border-bottom:1px solid var(--border); padding:5px 12px;
  display:flex; align-items:center; gap:7px; flex-shrink:0; flex-wrap:wrap;
}
.graph-toolbar .graph-lbl { font-family:var(--sans); font-size:11px; color:var(--text3); }
.graph-sel, .graph-toolbar select {
  background:var(--bg3); color:var(--text); border:1px solid var(--border2);
  border-radius:4px; font-family:var(--sans); font-size:12px; padding:3px 6px; outline:none;
}
.graph-sep { width:1px; height:18px; background:var(--border2); margin:0 3px; }
.graph-add-warn { color:var(--red); font-family:var(--sans); font-size:11px; }
.graph-signed-lbl {
  display:flex; align-items:center; gap:4px; font-family:var(--sans);
  font-size:11px; color:var(--text2); cursor:pointer;
}
.graph-stage { flex:1; min-height:0; position:relative; }
#graphCanvas { width:100%; height:100%; display:block; }
.graph-legend {
  flex-shrink:0; display:flex; flex-wrap:wrap; gap:6px 16px; padding:7px 12px;
  border-top:1px solid var(--border); background:var(--bg2);
  font-family:var(--sans); font-size:11px; color:var(--text2); max-height:96px; overflow-y:auto;
}
.graph-legend:empty { display:none; }
.graph-legend-item { display:flex; align-items:center; gap:6px; }
.graph-swatch { width:11px; height:11px; border-radius:2px; flex-shrink:0; }
.graph-legend-name { color:var(--text); font-weight:500; }
.graph-legend-val { font-family:var(--mono); color:var(--text2); }
.graph-pick-note {
  color:var(--text2); font-size:11px; font-style:italic; max-width:280px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; cursor:help; flex-shrink:1;
}
.graph-legend-x, .graph-legend-rescale {
  border:none; background:transparent; color:var(--text3); cursor:pointer;
  font-size:13px; line-height:1; padding:0 2px; border-radius:3px;
}
.graph-legend-x:hover { color:var(--red); background:var(--bg3); }
.graph-legend-rescale:hover { color:var(--text); background:var(--bg3); }
.graph-ctx {
  position:fixed; z-index:1000; background:var(--bg2); border:1px solid var(--border2);
  border-radius:6px; padding:4px; box-shadow:0 6px 24px rgba(0,0,0,0.4);
  font-family:var(--sans); font-size:12px;
}
.graph-ctx-item { padding:6px 12px; cursor:pointer; color:var(--text2); border-radius:4px; white-space:nowrap; }
.graph-ctx-item:hover { background:var(--bg3); color:var(--text); }
`;
  document.head.appendChild(s);
})();

// ── State ─────────────────────────────────────────────────────────────────────
// Each signal: { id, frameKey, byteIndex, width(1|2|4), endian('le'|'be'), signed,
//                colorIdx, label, curVal, vmin, vmax, buf:{t,v,head,count,cap} }
let graphSignals  = [];
let graphPaused   = false;   // freeze the view (set true automatically on pan/zoom)
let graphFrozenEnd = 0;      // right-edge time captured when paused
let graphLiveEnd  = 0;       // last wall-clock time the bus was live (freeze edge when bus drops)
let graphWindowMs = 30000;   // visible span (10s / 30s / 60s)
let graphPan      = 0;       // ms offset of the view (≤ 0 = into the past)
let graphZoom     = 1;       // time-axis zoom factor (effective window = graphWindowMs / zoom)
let graphHoverX   = null;    // cursor x in CSS px inside the canvas, or null
let graphHoverY   = null;    // cursor y in CSS px (picks the focused trace for the Y axis)
let graphDragging = false; let graphDragX = 0;
let graphDirty    = true;
let graphWasHidden = true;
let graphLastTick = 0;
let graphLastSigCount = -1;  // drives DPR re-cap when the number of signals changes
let graphColorIdx = 0;
let graphPlot     = null;    // last-draw geometry { L,R,T,B, tLo,tHi,win,tEnd }
const GRAPH_CAP   = 4096;    // samples retained per signal

// Trace palette - accent tokens + a few inspector swatch hexes; resolved fresh each draw.
const GRAPH_TRACE_VARS = ['--green', '--blue', '--amber', '--red'];
const GRAPH_TRACE_HEX  = ['#a78bfa', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#818cf8'];

// ── Signal helpers ────────────────────────────────────────────────────────────
const graphCoerceWidth = w => (w === 2 || w === 4) ? w : 1;

function graphFrameKey(frame) { return (frame.isExt ? 'E' : 'S') + ':' + frame.id; } // keep in sync with frameKey()

function graphParseKey(key) {
  const i = key.indexOf(':');
  return { isExt: key.slice(0, i) === 'E', id: parseInt(key.slice(i + 1), 10) };
}

function graphLabel(key, byteIndex, width, endian, signed) {
  const { isExt, id } = graphParseKey(key);
  const hex = id.toString(16).toUpperCase().padStart(isExt ? 8 : 3, '0');
  const idLabel = (isExt ? '0x' : '') + hex;
  const range = width >= 2 ? `D${byteIndex}:${byteIndex + width - 1}` : `D${byteIndex}`;
  const fmt = width === 4 ? `${endian.toUpperCase()} ${signed ? 's32' : 'u32'}`
            : width === 2 ? `${endian.toUpperCase()} ${signed ? 's16' : 'u16'}`
            : (signed ? 's8' : 'u8');
  return `${idLabel} ${range} ${fmt}`;
}

// Extract this signal's numeric value from a frame's data bytes; null = don't plot.
function graphExtract(sig, data) {
  if (!data || data.length < sig.byteIndex + sig.width) return null;   // no data / value crosses dlc boundary
  const i = sig.byteIndex;
  if (sig.width === 1) {
    const b = data[i];
    return sig.signed ? (b << 24 >> 24) : b;
  }
  if (sig.width === 2) {
    const lo = sig.endian === 'le' ? data[i] : data[i + 1];
    const hi = sig.endian === 'le' ? data[i + 1] : data[i];
    const u = ((hi << 8) | lo) & 0xFFFF;
    return sig.signed ? (u << 16 >> 16) : u;
  }
  const b0 = sig.endian === 'le' ? data[i]     : data[i + 3];
  const b1 = sig.endian === 'le' ? data[i + 1] : data[i + 2];
  const b2 = sig.endian === 'le' ? data[i + 2] : data[i + 1];
  const b3 = sig.endian === 'le' ? data[i + 3] : data[i];
  const u = b3 * 0x1000000 + b2 * 0x10000 + b1 * 0x100 + b0; // LE/BE u32 (no <<24 sign trap)
  return sig.signed ? (u | 0) : u;
}

function graphMakeSignal(def) {
  const width = graphCoerceWidth(def.width);
  const endian = def.endian === 'be' ? 'be' : 'le';
  const signed = !!def.signed;
  return {
    id: 'g' + Date.now().toString(36) + (graphColorIdx),
    frameKey: def.frameKey, byteIndex: def.byteIndex | 0,
    width, endian, signed,
    name: def.name || '',          // optional user-given name; falls back to label
    colorIdx: graphColorIdx++,
    label: graphLabel(def.frameKey, def.byteIndex | 0, width, endian, signed),
    curVal: null, vmin: Infinity, vmax: -Infinity,
    buf: { t: new Float64Array(GRAPH_CAP), v: new Float64Array(GRAPH_CAP), head: 0, count: 0, cap: GRAPH_CAP, sum: 0, recalc: 0 },
  };
}

function graphDisp(sig) { return sig.name || sig.label; }
function graphEsc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function graphPush(sig, t, val) {
  const b = sig.buf;
  if (b.count === b.cap) b.sum -= b.v[b.head];   // ring full → b.head is the oldest, about to be overwritten
  b.t[b.head] = t; b.v[b.head] = val;
  b.sum += val;
  b.head = (b.head + 1) % b.cap;
  if (b.count < b.cap) b.count++;
  // The incremental sum accumulates Float64 rounding over the buffer's lifetime; recompute it from
  // the ring once per full cap of pushes (amortized O(1)) so the displayed mean can't drift forever.
  if (++b.recalc >= b.cap) { b.recalc = 0; graphRecomputeSum(b); }
  // Range only ever grows to fit a new extreme - never auto-shrinks when an old
  // peak scrolls off, so the vertical scale stays stable instead of constantly resizing.
  if (val < sig.vmin) sig.vmin = val;
  if (val > sig.vmax) sig.vmax = val;
}

function graphRecomputeSum(b) {
  let s = 0;
  const start = (b.head - b.count + b.cap) % b.cap;
  for (let i = 0; i < b.count; i++) s += b.v[(start + i) % b.cap];
  b.sum = s;
}

// ── Ingest (called from sloppycan.js ingestFrame) ─────────────────────────────
function graphIngestFrame(frame) {
  if (!graphSignals.length) return;
  const key = graphFrameKey(frame);
  const now = Date.now();
  for (const sig of graphSignals) {
    if (sig.frameKey !== key) continue;
    const val = graphExtract(sig, frame.data);
    if (val === null) continue;
    graphPush(sig, now, val);
    sig.curVal = val;
  }
  // NB: deliberately do NOT mark graphDirty here. Redraws are paced by the ~30fps live
  // tick in loop() instead, so a busy bus can't force a (potentially expensive) trace
  // repaint on every single frame - that would saturate the compositor and freeze the UI.
}

// ── Add / remove signals ──────────────────────────────────────────────────────
function addGraphSignal(def) {
  const width = graphCoerceWidth(def.width);
  const endian = def.endian === 'be' ? 'be' : 'le';
  const signed = !!def.signed;
  const dup = graphSignals.find(s => s.frameKey === def.frameKey && s.byteIndex === (def.byteIndex | 0)
    && s.width === width && s.endian === endian && s.signed === signed);
  if (dup) { graphJumpToTab(); return; }
  graphSignals.push(graphMakeSignal({ ...def, width, endian, signed }));
  graphDirty = true;
  if (window.graphScheduleSave) window.graphScheduleSave();
  graphJumpToTab();
}

function graphRemoveSignal(id) {
  const n = graphSignals.length;
  graphSignals = graphSignals.filter(s => s.id !== id);
  if (graphSignals.length !== n) {
    graphDirty = true;
    if (window.graphScheduleSave) window.graphScheduleSave();
  }
}

// Reset a signal's sticky vmin/vmax to the values currently in its buffer.
function graphRescaleSignal(id) {
  const sig = graphSignals.find(s => s.id === id);
  if (!sig) return;
  const b = sig.buf;
  let mn = Infinity, mx = -Infinity;
  const start = (b.head - b.count + b.cap) % b.cap;
  for (let i = 0; i < b.count; i++) {
    const v = b.v[(start + i) % b.cap];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  sig.vmin = mn; sig.vmax = mx;       // Infinity/-Infinity if empty → re-grows on next sample
  graphDirty = true;
}

function graphJumpToTab() {
  const wrap = document.getElementById('graphWrap');
  if (wrap && wrap.style.display === 'none' && typeof switchViewTab === 'function') switchViewTab('graph');
}

// ── In-tab picker ─────────────────────────────────────────────────────────────
function graphOnShow() {
  graphPopulateIdPicker();
  resizeGraphCanvas();
  graphDirty = true;
}

// Re-list the Signal ID dropdown as new IDs appear on the bus, without disturbing an
// open menu or the user's current pick (graphPopulateIdPicker preserves the selection).
let graphIdCount = -1;
let graphIdTick = 0;
function graphMaybeRefreshIdPicker() {
  const wrap = document.getElementById('graphWrap');
  if (!wrap || wrap.style.display === 'none' || typeof frames === 'undefined') return;
  if (frames.size === graphIdCount) return;
  const active = document.activeElement;
  if (active && ['graphPickId', 'graphPickByte', 'graphPickWidth', 'graphPickEndian'].includes(active.id)) return;
  graphIdCount = frames.size;
  graphPopulateIdPicker();
}

function graphPopulateIdPicker() {
  const sel = document.getElementById('graphPickId');
  if (!sel || typeof frames === 'undefined') return;
  graphIdCount = frames.size;
  const prev = sel.value;
  const keys = [...frames.keys()].sort((a, b) => {
    const A = graphParseKey(a), B = graphParseKey(b);
    return (A.isExt - B.isExt) || (A.id - B.id);
  });
  if (!keys.length) {
    sel.innerHTML = '<option value="">- no IDs seen yet -</option>';
  } else {
    sel.innerHTML = keys.map(k => {
      const { isExt, id } = graphParseKey(k);
      const hex = id.toString(16).toUpperCase().padStart(isExt ? 8 : 3, '0');
      return `<option value="${k}">${(isExt ? '0x' : '') + hex}${isExt ? ' (ext)' : ''}</option>`;
    }).join('');
    if (keys.includes(prev)) sel.value = prev;
  }
  graphPopulateBytePicker(sel.value);
  graphUpdatePickNote(sel.value);
}

// Show the selected ID's note next to the picker, so the user knows what they're about to add.
function graphUpdatePickNote(key) {
  const el = document.getElementById('graphPickNote');
  if (!el) return;
  const note = graphNoteOf(key);
  el.textContent = note ? '📝 ' + note : '';
  el.title = note || '';
  el.style.display = note ? '' : 'none';
}

function graphPopulateBytePicker(key) {
  const sel = document.getElementById('graphPickByte');
  if (!sel) return;
  const prev = sel.value;
  const dlc = graphCurrentDlc(key);
  const n = Math.max(1, dlc);
  let html = '';
  for (let i = 0; i < n; i++) html += `<option value="${i}">D${i}</option>`;
  sel.innerHTML = html;
  if (prev !== '' && +prev < n) sel.value = prev;
  graphSyncPickerLimits();
}

function graphCurrentDlc(key) {
  if (key === undefined) {
    const idSel = document.getElementById('graphPickId');
    key = idSel ? idSel.value : '';
  }
  if (key && typeof frames !== 'undefined' && frames.has(key)) return frames.get(key).dlc || 8;
  return 8;
}

// Keep the byte + width pickers mutually consistent: a sample can never extend past the
// frame's DLC. Combinations that would overflow are disabled (greyed) in BOTH dropdowns -
// not removed - so neither an out-of-range byte nor an over-wide width is selectable, in
// either order. If a DLC change makes the current pick overflow, it's clamped to fit.
function graphSyncPickerLimits() {
  const byteSel = document.getElementById('graphPickByte');
  const widthSel = document.getElementById('graphPickWidth');
  if (!byteSel || !widthSel || !byteSel.options.length) return;
  const dlc = graphCurrentDlc();
  let byte = parseInt(byteSel.value, 10) || 0;
  let width = parseInt(widthSel.value, 10) || 1;
  if (byte > dlc - 1) byte = Math.max(0, dlc - 1);                            // byte fell outside a shrunk frame
  if (byte + width > dlc) width = [4, 2, 1].find(w => byte + w <= dlc) || 1;  // shrink width to fit at this byte
  for (const o of byteSel.options)  o.disabled = (+o.value + width > dlc);
  for (const o of widthSel.options) o.disabled = (byte + (+o.value) > dlc);
  byteSel.value = String(byte);
  widthSel.value = String(width);
}

function graphShowAddWarn(msg) {
  const el = document.getElementById('graphAddWarn');
  if (!el) return;
  el.textContent = msg ? '⚠ ' + msg : '';
  el.style.display = msg ? '' : 'none';
}

function graphAddFromPicker() {
  const key = document.getElementById('graphPickId').value;
  if (!key) return;
  const byteIndex = parseInt(document.getElementById('graphPickByte').value, 10) || 0;
  const width = graphCoerceWidth(parseInt(document.getElementById('graphPickWidth').value, 10) || 1);
  let dlc = 8;
  if (typeof frames !== 'undefined' && frames.has(key)) dlc = frames.get(key).dlc || 8;
  if (byteIndex + width > dlc) {            // backstop: width-aware picker normally prevents this
    graphShowAddWarn(`D${byteIndex} + ${width * 8}-bit exceeds ${dlc}-byte frame`);
    return;
  }
  graphShowAddWarn('');
  addGraphSignal({
    frameKey: key,
    byteIndex,
    width,
    endian: document.getElementById('graphPickEndian').value,
    signed: document.getElementById('graphPickSigned').checked,
  });
}

// ── Context menu (right-click an ID List row) ─────────────────────────────────
function graphContextMenu(x, y, key) {
  let menu = document.getElementById('graphCtxMenu');
  if (!menu) return;
  const { isExt, id } = graphParseKey(key);
  const hex = (isExt ? '0x' : '') + id.toString(16).toUpperCase().padStart(isExt ? 8 : 3, '0');
  menu.innerHTML = `<div class="graph-ctx-item">📈 Graph ${hex} (byte D0)</div>`;
  menu.firstChild.onclick = () => { graphCtxClose(); addGraphSignal({ frameKey: key, byteIndex: 0, width: 1 }); };
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
  setTimeout(() => document.addEventListener('click', graphCtxClose, { once: true }), 0);
}
function graphCtxClose() {
  const menu = document.getElementById('graphCtxMenu');
  if (menu) menu.style.display = 'none';
}

// ── Pause / live ──────────────────────────────────────────────────────────────
function graphSetPaused(on) {
  if (on && !graphPaused) graphFrozenEnd = Date.now();
  if (!on) graphPan = 0;            // resuming → follow the live edge again (zoom kept; Live resets it)
  graphPaused = on;
  graphDirty = true;
}
function graphGoLive() {
  graphPaused = false; graphPan = 0; graphZoom = 1;
  graphDirty = true;
}

// ── Canvas sizing ─────────────────────────────────────────────────────────────
// Trace stroke rasterization is the graph's paint cost and scales with canvas pixels ×
// signal count. On a HiDPI display a 2× backing store is 4× the pixels (and antialiased
// line coverage is superlinear), so cap the render resolution as more signals are added -
// the common 1–3 signal case stays crisp; many noisy traces stay smooth.
function graphEffectiveDpr() {
  const dpr = window.devicePixelRatio || 1;
  const n = graphSignals.length;
  return n >= 8 ? Math.min(dpr, 1) : n >= 4 ? Math.min(dpr, 1.5) : dpr;
}

function resizeGraphCanvas() {
  const c = document.getElementById('graphCanvas');
  if (!c) return;
  const wrap = document.getElementById('graphWrap');
  if (wrap && wrap.style.display === 'none') return;   // CSS size is 0 while hidden - resize on show instead
  const r = c.getBoundingClientRect();
  const dpr = graphEffectiveDpr();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  graphDirty = true;
}

// ── Render loop ───────────────────────────────────────────────────────────────
function graphRender() {
  const wrap = document.getElementById('graphWrap');
  if (!wrap || wrap.style.display === 'none') { graphWasHidden = true; return; }
  if (graphWasHidden) { graphWasHidden = false; graphDirty = true; resizeGraphCanvas(); }
  if (!graphDirty) return;
  graphDirty = false;
  drawGraph();
}

// The live edge only advances while the bus is actually delivering frames.
function graphBusLive() {
  return !!(window.fuzzBusReady && window.fuzzBusReady() && !(window.fuzzBusPaused && window.fuzzBusPaused()));
}

(function loop() {
  const now = Date.now();
  // Only keep scrolling the live edge while the bus is live and the view isn't paused;
  // otherwise the window would slide and drag the (static) traces off-screen.
  if (graphBusLive() && !graphPaused && now - graphLastTick >= 33) { graphDirty = true; graphLastTick = now; }  // ~30fps live cap
  if (now - graphIdTick >= 750) { graphIdTick = now; graphMaybeRefreshIdPicker(); }
  if (graphSignals.length !== graphLastSigCount) { graphLastSigCount = graphSignals.length; resizeGraphCanvas(); }  // re-cap DPR as signals change
  graphRender();
  requestAnimationFrame(loop);
})();

// ── Draw ──────────────────────────────────────────────────────────────────────
// getComputedStyle returns a LIVE declaration, so caching the object is safe -
// .getPropertyValue() reads still reflect theme changes; we just stop re-resolving
// it every frame (drawGraph + graphLegendHtml run on the hover/redraw hot path).
let graphCS = null;
function graphGetCS() { return graphCS || (graphCS = getComputedStyle(document.documentElement)); }

function niceStep(ms) {
  const raw = ms / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return mult * pow;
}

function graphTraceColor(cs, idx) {
  if (idx < GRAPH_TRACE_VARS.length) {
    const v = cs.getPropertyValue(GRAPH_TRACE_VARS[idx]).trim();
    if (v) return v;
  }
  return GRAPH_TRACE_HEX[(idx - GRAPH_TRACE_VARS.length + GRAPH_TRACE_HEX.length) % GRAPH_TRACE_HEX.length];
}

// Use the ID's user-chosen row colour (set in the Frame Inspector) when present,
// else fall back to the rotating palette.
// Accept only #hex or rgb()/rgba() so a stored colour can't inject into inline style / strokeStyle.
const GRAPH_COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$/;
function graphSigColor(cs, sig) {
  if (typeof frameColors !== 'undefined' && frameColors.has(sig.frameKey)) {
    const c = frameColors.get(sig.frameKey);
    // It's the user's own inspector colour (low trust) but goes straight into style="background:…"
    // and canvas strokeStyle - validate before trusting it, else fall back to the palette colour.
    if (c && GRAPH_COLOR_RE.test(c)) return c;
  }
  return graphTraceColor(cs, sig.colorIdx);
}

// The note attached to an ID (frameNotes is keyed by frameKey), or ''.
function graphNoteOf(key) {
  return (typeof frameNotes !== 'undefined' && frameNotes.get(key)) || '';
}

function drawGraph() {
  const c = document.getElementById('graphCanvas');
  if (!c) return;
  const dpr = graphEffectiveDpr();   // must match the backing store set by resizeGraphCanvas()
  const W = c.width / dpr, H = c.height / dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cs = graphGetCS();
  const COL = {
    bg:    cs.getPropertyValue('--bg2').trim()    || '#141720',
    grid:  cs.getPropertyValue('--border').trim() || '#2a2f3f',
    axis:  cs.getPropertyValue('--border2').trim()|| '#3a4060',
    text:  cs.getPropertyValue('--text2').trim()  || '#8892a4',
    text3: cs.getPropertyValue('--text3').trim()  || '#4a5568',
  };
  const sans = cs.getPropertyValue('--sans').trim() || 'sans-serif';
  const mono = cs.getPropertyValue('--mono').trim() || 'monospace';

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  const plotL = 10, plotR = W - 10, plotT = 10, plotB = H - 22;

  // Empty state
  if (!graphSignals.length) {
    ctx.fillStyle = COL.text3;
    ctx.font = '13px ' + sans;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Add a signal above to start graphing - or right-click an ID List row.', W / 2, H / 2);
    graphLegendHtml();
    return;
  }

  // Visible time window. The right edge tracks wall-clock only while the bus is
  // live; when paused it sits at the captured freeze point, and when the bus is
  // disconnected/bus-paused it holds at the last live instant so traces don't drift.
  const busLive = graphBusLive();
  const nowMs = Date.now();
  if (busLive && !graphPaused) graphLiveEnd = nowMs;
  const tEnd = graphPaused ? graphFrozenEnd : (busLive ? nowMs : (graphLiveEnd || nowMs));
  const win = graphWindowMs / graphZoom;

  // Oldest retained sample across all signals (for pan clamp)
  let oldestT = null;
  for (const sig of graphSignals) {
    if (!sig.buf.count) continue;
    const start = (sig.buf.head - sig.buf.count + sig.buf.cap) % sig.buf.cap;
    const t0 = sig.buf.t[start];
    if (oldestT === null || t0 < oldestT) oldestT = t0;
  }
  const panMin = oldestT !== null ? (oldestT + win - tEnd) : -win;
  graphPan = Math.max(Math.min(0, panMin), Math.min(0, graphPan));

  const tHi = tEnd + graphPan;
  const tLo = tHi - win;
  const x = t => plotL + (t - tLo) / (tHi - tLo) * (plotR - plotL);
  graphPlot = { L: plotL, R: plotR, T: plotT, B: plotB, tLo, tHi, win, tEnd };

  // Horizontal gridlines (25/50/75/100%)
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round(plotT + (plotB - plotT) * i / 4) + 0.5;
    ctx.moveTo(plotL, yy); ctx.lineTo(plotR, yy);
  }
  ctx.stroke();

  // Vertical time gridlines + labels
  const step = niceStep(win);
  ctx.fillStyle = COL.text3;
  ctx.font = '10px ' + sans;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.strokeStyle = COL.grid;
  const firstT = Math.ceil(tLo / step) * step;
  for (let t = firstT; t <= tHi; t += step) {
    const xx = Math.round(x(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(xx, plotT); ctx.lineTo(xx, plotB); ctx.stroke();
    const secs = (t - tEnd) / 1000;
    const lbl = (secs >= 0 ? '' : '') + (Math.abs(secs) < 0.0005 ? '0s' : secs.toFixed(secs % 1 ? 1 : 0) + 's');
    ctx.fillText(lbl, xx, plotB + 4);
  }

  // Traces (clipped to plot rect; each normalized to its own min/max)
  ctx.save();
  ctx.beginPath(); ctx.rect(plotL, plotT, plotR - plotL, plotB - plotT); ctx.clip();
  const yPad = (plotB - plotT) * 0.06;          // headroom so min/max don't clip at the edges
  const yTop = plotT + yPad, yBot = plotB - yPad;
  const normY = (sig, v) => {
    const span = sig.vmax - sig.vmin;
    return span > 0 ? yBot - (v - sig.vmin) / span * (yBot - yTop) : (yTop + yBot) / 2;
  };
  for (const sig of graphSignals) {
    const b = sig.buf;
    if (!b.count) continue;
    const color = graphSigColor(cs, sig);
    const y = v => normY(sig, v);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'bevel';
    ctx.beginPath();
    const start = (b.head - b.count + b.cap) % b.cap;
    // Min/max decimation: collapse all samples landing on the same x-pixel column into one
    // vertical min→max segment. Bounds the stroked path to ≤ plot width instead of up to
    // GRAPH_CAP points - this is what makes a dense/noisy trace cheap to rasterize (the trace
    // stroke is the graph's sole paint bottleneck). For sparse data (≤1 sample/column) it's
    // identical to the plain polyline. Samples are time-ordered, so columns only advance.
    let pen = false, curCol = null, colMin = 0, colMax = 0, colLast = 0;
    const flushCol = () => {
      if (curCol === null) return;
      if (!pen) { ctx.moveTo(curCol, colLast); pen = true; }
      ctx.lineTo(curCol, colMin);
      ctx.lineTo(curCol, colMax);
      ctx.lineTo(curCol, colLast);
    };
    for (let i = 0; i < b.count; i++) {
      const idx = (start + i) % b.cap;
      const px = Math.round(x(b.t[idx])), py = y(b.v[idx]);
      // Skip path-building for samples off the plot's x-range (clip discards their stroke anyway),
      // but keep ONE on each side so the segment entering/leaving the window is still drawn:
      //  - off-left: collapse into a single pending start column (overwritten until we enter);
      //  - off-right: flush the exit segment to it once, then stop (columns only advance in time).
      if (px < plotL) { curCol = px; colMin = colMax = colLast = py; continue; }
      if (px > plotR) { flushCol(); curCol = px; colMin = colMax = colLast = py; flushCol(); curCol = null; break; }
      if (px !== curCol) { flushCol(); curCol = px; colMin = colMax = colLast = py; }
      else { if (py < colMin) colMin = py; if (py > colMax) colMax = py; colLast = py; }
    }
    flushCol();
    ctx.stroke();
  }
  ctx.restore();

  // Plot border
  ctx.strokeStyle = COL.axis; ctx.lineWidth = 1;
  ctx.strokeRect(plotL + 0.5, plotT + 0.5, plotR - plotL - 1, plotB - plotT - 1);

  // Hover crosshair + readout
  let hover = null;
  if (graphHoverX !== null && graphHoverX >= plotL && graphHoverX <= plotR) {
    const tHover = tLo + (graphHoverX - plotL) / (plotR - plotL) * (tHi - tLo);
    ctx.strokeStyle = COL.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(graphHoverX) + 0.5, plotT); ctx.lineTo(Math.round(graphHoverX) + 0.5, plotB); ctx.stroke();
    hover = { tHover, rows: [] };
    let focused = null, focusedD = Infinity;
    for (const sig of graphSignals) {
      const v = graphNearest(sig, tHover);
      if (v === null) continue;
      const color = graphSigColor(cs, sig);
      const py = normY(sig, v);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(graphHoverX, py, 3, 0, Math.PI * 2); ctx.fill();
      hover.rows.push({ color, label: graphDisp(sig), val: v,
        min: sig.vmin, max: sig.vmax, mean: sig.buf.count ? sig.buf.sum / sig.buf.count : v });
      if (graphHoverY !== null) {
        const d = Math.abs(py - graphHoverY);
        if (d < focusedD) { focusedD = d; focused = { sig, color, py }; }
      }
    }
    // Emphasize the focused trace's dot and label the Y axis with its real values.
    if (focused) {
      ctx.strokeStyle = focused.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(graphHoverX, focused.py, 5, 0, Math.PI * 2); ctx.stroke();
      graphDrawYAxis(ctx, focused.sig, focused.color, plotL, plotT, plotB, yTop, yBot, COL, mono);
    }
    graphDrawReadout(ctx, hover, graphHoverX, plotL, plotR, plotT, COL, mono, sans);
  }

  // PAUSED pill
  if (graphPaused) {
    ctx.font = '600 10px ' + sans;
    const txt = 'PAUSED';
    const tw = ctx.measureText(txt).width;
    const pad = 6, bw = tw + pad * 2, bh = 16;
    const bx = plotR - bw - 6, by = plotT + 6;
    ctx.fillStyle = cs.getPropertyValue('--amber').trim() || '#f59e0b';
    ctx.globalAlpha = 0.92;
    graphRoundRect(ctx, bx, by, bw, bh, 4); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COL.bg;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx + pad, by + bh / 2 + 0.5);
  }

  graphLegendHtml();
}

// Samples ascend in time from `start`, so binary-search the logical index for the
// closest timestamp instead of scanning the whole ring on every hover frame.
function graphNearest(sig, t) {
  const b = sig.buf;
  if (!b.count) return null;
  const start = (b.head - b.count + b.cap) % b.cap;
  const at = j => b.t[(start + j) % b.cap];
  let lo = 0, hi = b.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) < t) lo = mid + 1; else hi = mid;
  }
  let best = b.v[(start + lo) % b.cap];
  if (lo > 0 && Math.abs(at(lo - 1) - t) < Math.abs(at(lo) - t)) best = b.v[(start + lo - 1) % b.cap];
  return best;
}

// Value labels at the horizontal gridlines, mapped to the focused trace's own scale.
function graphDrawYAxis(ctx, sig, color, plotL, plotT, plotB, yTop, yBot, COL, mono) {
  const span = sig.vmax - sig.vmin;
  ctx.font = '10px ' + mono;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const yy = plotT + (plotB - plotT) * i / 4;
    const val = span > 0 ? sig.vmin + (yBot - yy) / (yBot - yTop) * span : sig.vmin;
    const txt = graphFmtVal(val);
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = COL.bg; ctx.globalAlpha = 0.82;
    ctx.fillRect(plotL + 2, yy - 7, tw + 6, 13);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(txt, plotL + 5, yy + 0.5);
  }
}

function graphDrawReadout(ctx, hover, hx, plotL, plotR, plotT, COL, mono, sans) {
  if (!hover.rows.length) return;
  ctx.font = '11px ' + mono;
  // Pad each number to a per-signal fixed width (its min/max/mean extreme) so the box
  // doesn't flicker in size as the live value races between 0 and its peak. Monospace
  // font → each space is one fixed column, so padStart gives a stable box width.
  const fieldW = r => Math.max(graphFmtVal(r.min).length, graphFmtVal(r.max).length, graphFmtVal(r.mean).length);
  const fx = (v, w) => graphFmtVal(v).padStart(w);
  const mainOf = r => `${r.label}  ${fx(r.val, fieldW(r))}`;
  const statOf = r => { const w = fieldW(r); return `  ↓${fx(r.min, w)} ↑${fx(r.max, w)} µ${fx(r.mean, w)}`; };
  let wMax = 0;
  for (const r of hover.rows) {
    wMax = Math.max(wMax, ctx.measureText(mainOf(r) + statOf(r)).width);
  }
  const pad = 7, lh = 15;
  const bw = wMax + pad * 2 + 14;
  const bh = hover.rows.length * lh + pad * 2;
  // Pin to the top corner opposite the cursor: stays put (and clear of the data under
  // the cursor) instead of gliding pixel-by-pixel and sliding as values/widths grow.
  let bx = hx < (plotL + plotR) / 2 ? (plotR - bw - 6) : (plotL + 6);
  bx = Math.max(plotL + 6, Math.min(bx, plotR - bw - 6));
  const by = plotT + 6;
  ctx.fillStyle = COL.bg; ctx.globalAlpha = 0.95;
  graphRoundRect(ctx, bx, by, bw, bh, 5); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COL.axis; ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  hover.rows.forEach((r, i) => {
    const ry = by + pad + i * lh + lh / 2 - 1;
    ctx.fillStyle = r.color;
    ctx.fillRect(bx + pad, ry - 4, 8, 8);
    const main = mainOf(r);
    ctx.fillStyle = COL.text;
    ctx.fillText(main, bx + pad + 14, ry);
    ctx.fillStyle = COL.text3;
    ctx.fillText(statOf(r), bx + pad + 14 + ctx.measureText(main).width, ry);
  });
}

function graphFmtVal(v) {
  if (v === null || v === undefined) return '-';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function graphRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── Legend (HTML overlay) ─────────────────────────────────────────────────────
// The legend DOM is only rebuilt when the signal set / names / theme change - NOT
// every frame - so the ✕ button and the editable name stay clickable (no flicker).
// Live values are patched in place each draw.
let graphLegendSig = '';
const graphLegendVals = new Map(); // signal id → value <span>

function graphLegendHtml() {
  const el = document.getElementById('graphLegend');
  if (!el) return;
  const cs = graphGetCS();
  const themeKey = cs.getPropertyValue('--bg2').trim();
  const sig = themeKey + '|' + graphSignals.map(s =>
    s.id + ':' + graphSigColor(cs, s) + ':' + (s.name || '')).join('|');

  if (sig !== graphLegendSig) {
    graphLegendSig = sig;
    graphLegendVals.clear();
    el.innerHTML = graphSignals.map(s => {
      const color = graphSigColor(cs, s);
      return `<span class="graph-legend-item">
        <span class="graph-swatch" style="background:${color}"></span>
        <span class="graph-legend-name" contenteditable="true" spellcheck="false" data-id="${s.id}"
              title="Click to rename - clear to reset to default">${graphEsc(graphDisp(s))}</span>
        <span class="graph-legend-val" data-id="${s.id}"></span>
        <button class="graph-legend-rescale" title="Rescale Y to current data" data-id="${s.id}">↕</button>
        <button class="graph-legend-x" title="Remove" data-id="${s.id}">✕</button>
      </span>`;
    }).join('');
    el.querySelectorAll('.graph-legend-val').forEach(n => graphLegendVals.set(n.dataset.id, n));
  }

  for (const s of graphSignals) {
    const node = graphLegendVals.get(s.id);
    if (!node) continue;
    // Reserve a fixed column width (the min/max extreme, in mono ch) so the legend item
    // doesn't reflow as the live value swings between 0 and its peak.
    const w = Math.max(graphFmtVal(s.vmin).length, graphFmtVal(s.vmax).length);
    const fixed = v => `<span style="display:inline-block;min-width:${w}ch;text-align:right">${graphFmtVal(v)}</span>`;
    const rng = s.buf.count ? `${fixed(s.vmin)}…${fixed(s.vmax)}` : '-';
    node.innerHTML = `${fixed(s.curVal)} <span style="color:var(--text3)">(${rng})</span>`;
  }
}

// ── Persistence hooks (called from sloppycan.js) ──────────────────────────────
function graphCollect() {
  return graphSignals.map(s => ({
    frameKey: s.frameKey, byteIndex: s.byteIndex, width: s.width, endian: s.endian, signed: s.signed,
    name: s.name || undefined,
  }));
}
function graphApply(arr) {
  graphSignals = [];
  graphColorIdx = 0;
  (arr || []).forEach(def => { if (def && def.frameKey) graphSignals.push(graphMakeSignal(def)); });
  graphDirty = true;
}

// ── Expose hooks ──────────────────────────────────────────────────────────────
window.graphIngestFrame     = graphIngestFrame;
window.graphOnShow          = graphOnShow;
window.graphContextMenu     = graphContextMenu;
window.graphRemoveSignal    = graphRemoveSignal;
window.graphCollect         = graphCollect;
window.graphApply           = graphApply;

// ── Wire toolbar + canvas events (DOM is parsed - this script is deferred) ────
(function wire() {
  const pickId = document.getElementById('graphPickId');
  const pickWidth = document.getElementById('graphPickWidth');
  const pickByte = document.getElementById('graphPickByte');
  if (pickId) pickId.addEventListener('change', () => { graphPopulateBytePicker(pickId.value); graphUpdatePickNote(pickId.value); });
  if (pickByte) pickByte.addEventListener('change', graphSyncPickerLimits);
  if (pickWidth) pickWidth.addEventListener('change', () => {
    graphSyncPickerLimits();
    const wide = pickWidth.value === '2' || pickWidth.value === '4';
    document.getElementById('graphPickEndian').style.display = wide ? '' : 'none';
    document.getElementById('graphPickSignedLbl').style.display = wide ? '' : 'none';
  });
  const addBtn = document.getElementById('graphAddBtn');
  if (addBtn) addBtn.addEventListener('click', graphAddFromPicker);

  const clearBtn = document.getElementById('graphClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    graphSignals = []; graphColorIdx = 0; graphDirty = true;
    graphShowAddWarn('');
    if (window.graphScheduleSave) window.graphScheduleSave();
  });

  const winSel = document.getElementById('graphWindowSel');
  if (winSel) winSel.addEventListener('change', () => { graphWindowMs = parseInt(winSel.value, 10) || 30000; graphDirty = true; });

  const pauseBtn = document.getElementById('graphPauseBtn');
  if (pauseBtn) pauseBtn.addEventListener('click', () => { graphSetPaused(!graphPaused); pauseBtn.textContent = graphPaused ? 'Resume' : 'Pause'; });
  const liveBtn = document.getElementById('graphLiveBtn');
  if (liveBtn) liveBtn.addEventListener('click', () => { graphGoLive(); if (pauseBtn) pauseBtn.textContent = 'Pause'; });

  const c = document.getElementById('graphCanvas');
  if (c) {
    c.addEventListener('mousemove', e => {
      const r = c.getBoundingClientRect();
      if (graphDragging && graphPlot) {
        const dx = e.clientX - graphDragX;
        graphDragX = e.clientX;
        const msPerPx = graphPlot.win / (graphPlot.R - graphPlot.L);
        graphPan -= dx * msPerPx;          // drag right → view moves into the past
      }
      graphHoverX = e.clientX - r.left;
      graphHoverY = e.clientY - r.top;
      graphDirty = true;
    });
    c.addEventListener('mouseleave', () => { graphHoverX = null; graphHoverY = null; graphDirty = true; });
    c.addEventListener('mousedown', e => {
      graphDragging = true; graphDragX = e.clientX;
      graphSetPaused(true);
      if (pauseBtn) pauseBtn.textContent = 'Resume';
    });
    window.addEventListener('mouseup', () => { graphDragging = false; });
    c.addEventListener('wheel', e => {
      if (!graphPlot) return;
      e.preventDefault();
      graphSetPaused(true);
      if (pauseBtn) pauseBtn.textContent = 'Resume';
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const frac = Math.max(0, Math.min(1, (px - graphPlot.L) / (graphPlot.R - graphPlot.L)));
      const tCursor = graphPlot.tLo + frac * (graphPlot.tHi - graphPlot.tLo);
      graphZoom = Math.max(1, Math.min(50, graphZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const winNew = graphWindowMs / graphZoom;
      graphPan = tCursor + winNew * (1 - frac) - graphFrozenEnd;
      graphDirty = true;
    }, { passive: false });
  }

  // Legend: delegated remove (✕) + inline rename (contenteditable name).
  const legend = document.getElementById('graphLegend');
  if (legend) {
    legend.addEventListener('click', e => {
      const x = e.target.closest('.graph-legend-x');
      if (x) { graphRemoveSignal(x.dataset.id); return; }
      const rs = e.target.closest('.graph-legend-rescale');
      if (rs) graphRescaleSignal(rs.dataset.id);
    });
    legend.addEventListener('keydown', e => {
      if (e.target.classList.contains('graph-legend-name') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    legend.addEventListener('focusout', e => {
      const n = e.target;
      if (!n.classList.contains('graph-legend-name')) return;
      const sig = graphSignals.find(s => s.id === n.dataset.id);
      if (!sig) return;
      const v = n.textContent.trim();
      const newName = (v && v !== sig.label) ? v : '';
      if (newName !== sig.name) {
        sig.name = newName;
        graphLegendSig = '';                 // force a legend rebuild with the new name
        graphDirty = true;
        if (window.graphScheduleSave) window.graphScheduleSave();
      }
    });
  }

  window.addEventListener('resize', resizeGraphCanvas);

  // Restore signals persisted before this (deferred) script loaded.
  if (window._graphPending) graphApply(window._graphPending);
})();
