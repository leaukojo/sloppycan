// ── fuzz.js ───────────────────────────────────────────────────────────────────
// Self-contained CAN fuzzing module (same revertable pattern as graph.js /
// j1939.js). Transmits crafted frames with varied ID / DLC / payload.
// All wire I/O goes through the core seam window.fuzzTxFrame(id,isExt,dlc,bytes) 
// so both SLCAN and gs_usb work.
// Integration points in the core (all optional-chained — delete this file +
// #vtab-fuzz/#fuzzWrap/#fuzzActiveBadge + the <script> tag to fully revert):
//   window.fuzzTxFrame / fuzzBusReady / fuzzObservedIds  (provided by sloppycan.js)
//   window.fuzzOnShow / fuzzStop / fuzzCollect / fuzzApply  (provided here)
//   window.fuzzScheduleSave  (= scheduleSave, set at startup)
//   switchViewTab 'fuzz' case, disconnectSerial → fuzzStop().

// ── State ──
let fuzzCfg = fuzzDefaultCfg();
let fuzzRunning = false;
let fuzzTimer = null;
let fuzzCount = 0;
let fuzzBusy = false;
// run-time cursors (not persisted)
let fzIdCur = 0, fzObsCur = 0, fzDlcCur = 0, fzSeqBits = 0, fzSweepCur = 0;
let fzByteInc = [0,0,0,0,0,0,0,0];

function fuzzDefaultCfg() {
  return {
    idMode: 'range', isExt: false,
    idStart: 0x000, idEnd: 0x7FF, idScan: 'seq',
    singleId: 0x7DF, obsScan: 'seq',
    dlcMode: 'fixed', dlcFixed: 8,
    payMode: 'random',
    randomBytes: [true,true,true,true,true,true,true,true],
    byteMasks: Array.from({length:8}, () => ({ mode:'rand', value:0 })),
    bitGrid: Array.from({length:8}, () => Array.from({length:8}, () => 'fuzz')),
    bitPat: 'rand',
    gap: 50, burst: 1
  };
}

// ── One-time dynamic UI build ──
function fuzzInitUI() {
  // Random-mode byte checkboxes
  const rb = document.getElementById('fuzzRandomBytes');
  rb.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const lbl = document.createElement('label');
    lbl.className = 'fuzz-bytechk';
    lbl.innerHTML = `<input type="checkbox" data-bi="${i}" checked> ${i}`;
    lbl.querySelector('input').addEventListener('change', fuzzCfgChange);
    rb.appendChild(lbl);
  }
  // Per-byte mask table (Mode row + Value row)
  const mb = document.getElementById('fuzzMaskBody');
  let modeRow = '<tr><td class="fuzz-mask-lbl">Mode</td>';
  let valRow  = '<tr><td class="fuzz-mask-lbl">Fixed value</td>';
  for (let i = 0; i < 8; i++) {
    modeRow += `<td><select class="fuzz-sel fuzz-msel" data-bi="${i}">
      <option value="rand">rand</option><option value="fixed">fixed</option><option value="inc">inc</option></select></td>`;
    valRow  += `<td><input type="text" class="fuzz-hex fuzz-mval" data-bi="${i}" value="00" maxlength="2"></td>`;
  }
  mb.innerHTML = modeRow + '</tr>' + valRow + '</tr>';
  mb.querySelectorAll('.fuzz-msel, .fuzz-mval').forEach(el =>
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', fuzzCfgChange));
  // 8×8 bit grid (rows = bytes, cols = bits MSB-left)
  const g = document.getElementById('fuzzBitgrid');
  g.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    const row = document.createElement('div');
    row.className = 'fuzz-grid-row';
    const tag = document.createElement('span');
    tag.className = 'fuzz-grid-tag';
    tag.textContent = 'B' + r;
    row.appendChild(tag);
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'fuzz-cell fuzz';
      cell.dataset.r = r; cell.dataset.c = c;
      cell.addEventListener('click', () => fuzzCycleCell(r, c, cell));
      row.appendChild(cell);
    }
    g.appendChild(row);
  }
}

const FZ_STATES = ['fuzz','always','never'];
function fuzzCycleCell(r, c, cell) {
  const cur = fuzzCfg.bitGrid[r][c];
  const next = FZ_STATES[(FZ_STATES.indexOf(cur) + 1) % 3];
  fuzzCfg.bitGrid[r][c] = next;
  cell.classList.remove('fuzz','always','never');
  cell.classList.add(next);
  if (window.fuzzScheduleSave) window.fuzzScheduleSave();
}

// ── Read DOM → fuzzCfg, refresh visibility, persist ──
function fuzzCfgChange() {
  const radio = n => (document.querySelector(`input[name="${n}"]:checked`) || {}).value;
  fuzzCfg.idMode  = radio('fuzzIdMode') || 'range';
  fuzzCfg.isExt   = document.getElementById('fuzzIsExt').value === '1';
  fuzzCfg.idStart = parseInt(document.getElementById('fuzzIdStart').value, 16) || 0;
  fuzzCfg.idEnd   = parseInt(document.getElementById('fuzzIdEnd').value, 16) || 0;
  fuzzCfg.idScan  = radio('fuzzIdScan') || 'seq';
  fuzzCfg.singleId = parseInt(document.getElementById('fuzzSingleId').value, 16) || 0;
  fuzzCfg.obsScan = radio('fuzzObsScan') || 'seq';
  fuzzCfg.dlcMode = radio('fuzzDlcMode') || 'fixed';
  fuzzCfg.dlcFixed = parseInt(document.getElementById('fuzzDlcFixed').value, 10);
  fuzzCfg.payMode = radio('fuzzPayMode') || 'random';
  fuzzCfg.bitPat  = radio('fuzzBitPat') || 'rand';
  fuzzCfg.gap     = Math.max(1, parseInt(document.getElementById('fuzzGap').value, 10) || 50);
  fuzzCfg.burst   = Math.max(1, parseInt(document.getElementById('fuzzBurst').value, 10) || 1);
  document.querySelectorAll('#fuzzRandomBytes input').forEach(el => {
    fuzzCfg.randomBytes[+el.dataset.bi] = el.checked;
  });
  document.querySelectorAll('.fuzz-msel').forEach(el => {
    fuzzCfg.byteMasks[+el.dataset.bi].mode = el.value;
  });
  document.querySelectorAll('.fuzz-mval').forEach(el => {
    fuzzCfg.byteMasks[+el.dataset.bi].value = (parseInt(el.value, 16) || 0) & 0xFF;
  });

  // Visibility of the sub-option groups
  document.getElementById('fuzzRangeOpts').style.display    = fuzzCfg.idMode === 'range'    ? 'flex' : 'none';
  document.getElementById('fuzzSingleOpts').style.display   = fuzzCfg.idMode === 'single'   ? 'flex' : 'none';
  document.getElementById('fuzzObservedOpts').style.display = fuzzCfg.idMode === 'observed' ? 'flex' : 'none';
  document.getElementById('fuzzRandomOpts').style.display   = fuzzCfg.payMode === 'random'  ? 'flex' : 'none';
  document.getElementById('fuzzMaskOpts').style.display     = fuzzCfg.payMode === 'mask'    ? 'block' : 'none';
  document.getElementById('fuzzBitgridOpts').style.display  = fuzzCfg.payMode === 'bitgrid' ? 'block' : 'none';

  if (window.fuzzScheduleSave) window.fuzzScheduleSave();
}

// ── Frame generation ──
function fuzzIdMask() { return fuzzCfg.isExt ? 0x1FFFFFFF : 0x7FF; }

function fuzzNextId() {
  const mask = fuzzIdMask();
  if (fuzzCfg.idMode === 'single') return fuzzCfg.singleId & mask;
  if (fuzzCfg.idMode === 'observed') {
    const list = window.fuzzObservedIds ? window.fuzzObservedIds(fuzzCfg.isExt) : [];
    if (!list.length) return null;
    if (fuzzCfg.obsScan === 'rand') return list[Math.floor(Math.random() * list.length)] & mask;
    return list[(fzObsCur++) % list.length] & mask;
  }
  // range
  let lo = fuzzCfg.idStart & mask, hi = fuzzCfg.idEnd & mask;
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  const span = hi - lo + 1;
  if (fuzzCfg.idScan === 'rand') return (lo + Math.floor(Math.random() * span)) & mask;
  return (lo + ((fzIdCur++) % span)) & mask;
}

function fuzzNextDlc() {
  if (fuzzCfg.dlcMode === 'rand') return Math.floor(Math.random() * 9);
  if (fuzzCfg.dlcMode === 'inc')  return (fzDlcCur++) % 9;
  return fuzzCfg.dlcFixed;
}

function fuzzBitgridByte(r) {
  // base from always(1)/never(0); fuzz bits filled per pattern by caller helpers
  let v = 0;
  for (let c = 0; c < 8; c++) if (fuzzCfg.bitGrid[r][c] === 'always') v |= (1 << (7 - c));
  return v;
}

function fuzzNextPayload(dlc) {
  const out = new Array(dlc);
  if (fuzzCfg.payMode === 'mask') {
    for (let i = 0; i < dlc; i++) {
      const m = fuzzCfg.byteMasks[i] || { mode:'rand', value:0 };
      out[i] = m.mode === 'fixed' ? (m.value & 0xFF)
             : m.mode === 'inc'   ? ((fzByteInc[i]++) & 0xFF)
             : Math.floor(Math.random() * 256);
    }
    return out;
  }
  if (fuzzCfg.payMode === 'bitgrid') {
    // Collect fuzz-bit positions in row-major, MSB-left order (within dlc bytes).
    const pos = [];
    for (let r = 0; r < dlc; r++)
      for (let c = 0; c < 8; c++)
        if (fuzzCfg.bitGrid[r][c] === 'fuzz') pos.push([r, c]);
    for (let i = 0; i < dlc; i++) out[i] = fuzzBitgridByte(i) & 0xFF;
    if (pos.length) {
      if (fuzzCfg.bitPat === 'sweep') {
        const [r, c] = pos[(fzSweepCur++) % pos.length];
        out[r] |= (1 << (7 - c));
      } else if (fuzzCfg.bitPat === 'seq') {
        const n = fzSeqBits++;
        pos.forEach(([r, c], k) => { if ((n >> k) & 1) out[r] |= (1 << (7 - c)); });
      } else { // rand
        pos.forEach(([r, c]) => { if (Math.random() < 0.5) out[r] |= (1 << (7 - c)); });
      }
    }
    return out;
  }
  // random bytes (only the enabled indices vary; others stay 0)
  for (let i = 0; i < dlc; i++) out[i] = fuzzCfg.randomBytes[i] ? Math.floor(Math.random() * 256) : 0;
  return out;
}

// ── Run loop ──
async function fuzzTick() {
  if (fuzzBusy) return;
  if (!window.fuzzBusReady || !window.fuzzBusReady()) { fuzzStop(); return; }
  fuzzBusy = true;
  try {
    for (let b = 0; b < fuzzCfg.burst; b++) {
      const id = fuzzNextId();
      if (id === null) continue; // observed mode with empty list
      const dlc = fuzzNextDlc();
      const bytes = fuzzNextPayload(dlc);
      const ok = await window.fuzzTxFrame(id, fuzzCfg.isExt, dlc, bytes);
      if (ok) fuzzCount++;
    }
  } finally {
    fuzzBusy = false;
  }
  fuzzUpdateIndicator();
}

function fuzzToggleRun() {
  if (fuzzRunning) { fuzzStop(); return; }
  if (!window.fuzzBusReady || !window.fuzzBusReady()) {
    alert('No open bus. Connect an adapter (or start Demo) before fuzzing.');
    return;
  }
  if (!confirm('Start fuzzing? This transmits crafted frames onto the bus and can affect a live vehicle. Only proceed on a bus you control.')) return;
  fuzzCount = 0;
  fzIdCur = fzObsCur = fzDlcCur = fzSeqBits = fzSweepCur = 0;
  fzByteInc = [0,0,0,0,0,0,0,0];
  fuzzRunning = true;
  fuzzTimer = setInterval(fuzzTick, fuzzCfg.gap);
  fuzzUpdateIndicator();
}

function fuzzStop() {
  if (fuzzTimer) { clearInterval(fuzzTimer); fuzzTimer = null; }
  fuzzRunning = false;
  fuzzUpdateIndicator();
}

function fuzzUpdateIndicator() {
  const startBtn = document.getElementById('fuzzStartBtn');
  if (startBtn) {
    startBtn.textContent = fuzzRunning ? 'Stop fuzzing' : 'Start fuzzing';
    startBtn.classList.toggle('running', fuzzRunning);
  }
  const counter = document.getElementById('fuzzCounter');
  if (counter) counter.textContent = `${fuzzCount} frames sent`;
  const badge = document.getElementById('fuzzActiveBadge');
  if (badge) badge.style.display = fuzzRunning ? 'inline-flex' : 'none';
  const bc = document.getElementById('fuzzActiveCount');
  if (bc) bc.textContent = fuzzCount;
}

// ── Tab show + persistence hooks ──
window.fuzzOnShow = function () {
  // Refresh observed-ID note count so the user knows the target pool.
  const note = document.getElementById('fuzzObservedNote');
  if (note && window.fuzzObservedIds) {
    note.textContent = `Cycles through the ${window.fuzzObservedIds(fuzzCfg.isExt).length} ${fuzzCfg.isExt ? 'extended' : 'standard'} ID(s) currently in the ID List.`;
  }
};

window.fuzzStop = fuzzStop;

window.fuzzCollect = function () {
  // Deep-ish copy of the serializable config (never the run state).
  return {
    idMode: fuzzCfg.idMode, isExt: fuzzCfg.isExt,
    idStart: fuzzCfg.idStart, idEnd: fuzzCfg.idEnd, idScan: fuzzCfg.idScan,
    singleId: fuzzCfg.singleId, obsScan: fuzzCfg.obsScan,
    dlcMode: fuzzCfg.dlcMode, dlcFixed: fuzzCfg.dlcFixed,
    payMode: fuzzCfg.payMode,
    randomBytes: [...fuzzCfg.randomBytes],
    byteMasks: fuzzCfg.byteMasks.map(m => ({ mode: m.mode, value: m.value })),
    bitGrid: fuzzCfg.bitGrid.map(row => [...row]),
    bitPat: fuzzCfg.bitPat, gap: fuzzCfg.gap, burst: fuzzCfg.burst
  };
};

window.fuzzApply = function (cfg) {
  fuzzStop(); // never auto-run on load/workspace switch
  fuzzCfg = Object.assign(fuzzDefaultCfg(), cfg || {});
  // Repair nested arrays if a partial/legacy object came in.
  if (!Array.isArray(fuzzCfg.randomBytes) || fuzzCfg.randomBytes.length !== 8)
    fuzzCfg.randomBytes = [true,true,true,true,true,true,true,true];
  if (!Array.isArray(fuzzCfg.byteMasks) || fuzzCfg.byteMasks.length !== 8)
    fuzzCfg.byteMasks = Array.from({length:8}, () => ({ mode:'rand', value:0 }));
  if (!Array.isArray(fuzzCfg.bitGrid) || fuzzCfg.bitGrid.length !== 8)
    fuzzCfg.bitGrid = Array.from({length:8}, () => Array.from({length:8}, () => 'fuzz'));
  fuzzWriteToDOM();
};

// Push fuzzCfg back into the form controls (used by fuzzApply + init).
function fuzzWriteToDOM() {
  const setRadio = (n, v) => { const el = document.querySelector(`input[name="${n}"][value="${v}"]`); if (el) el.checked = true; };
  const hex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
  setRadio('fuzzIdMode', fuzzCfg.idMode);
  document.getElementById('fuzzIsExt').value = fuzzCfg.isExt ? '1' : '0';
  const w = fuzzCfg.isExt ? 8 : 3;
  document.getElementById('fuzzIdStart').value = hex(fuzzCfg.idStart, w);
  document.getElementById('fuzzIdEnd').value   = hex(fuzzCfg.idEnd, w);
  setRadio('fuzzIdScan', fuzzCfg.idScan);
  document.getElementById('fuzzSingleId').value = hex(fuzzCfg.singleId, w);
  setRadio('fuzzObsScan', fuzzCfg.obsScan);
  setRadio('fuzzDlcMode', fuzzCfg.dlcMode);
  document.getElementById('fuzzDlcFixed').value = fuzzCfg.dlcFixed;
  setRadio('fuzzPayMode', fuzzCfg.payMode);
  setRadio('fuzzBitPat', fuzzCfg.bitPat);
  document.getElementById('fuzzGap').value = fuzzCfg.gap;
  document.getElementById('fuzzBurst').value = fuzzCfg.burst;
  document.querySelectorAll('#fuzzRandomBytes input').forEach(el => { el.checked = !!fuzzCfg.randomBytes[+el.dataset.bi]; });
  document.querySelectorAll('.fuzz-msel').forEach(el => { el.value = fuzzCfg.byteMasks[+el.dataset.bi].mode; });
  document.querySelectorAll('.fuzz-mval').forEach(el => { el.value = (fuzzCfg.byteMasks[+el.dataset.bi].value & 0xFF).toString(16).toUpperCase().padStart(2, '0'); });
  document.querySelectorAll('#fuzzBitgrid .fuzz-cell').forEach(cell => {
    const st = fuzzCfg.bitGrid[+cell.dataset.r][+cell.dataset.c];
    cell.classList.remove('fuzz','always','never');
    cell.classList.add(st);
  });
  // sync visibility without re-persisting (call after DOM written)
  document.getElementById('fuzzRangeOpts').style.display    = fuzzCfg.idMode === 'range'    ? 'flex' : 'none';
  document.getElementById('fuzzSingleOpts').style.display   = fuzzCfg.idMode === 'single'   ? 'flex' : 'none';
  document.getElementById('fuzzObservedOpts').style.display = fuzzCfg.idMode === 'observed' ? 'flex' : 'none';
  document.getElementById('fuzzRandomOpts').style.display   = fuzzCfg.payMode === 'random'  ? 'flex' : 'none';
  document.getElementById('fuzzMaskOpts').style.display     = fuzzCfg.payMode === 'mask'    ? 'block' : 'none';
  document.getElementById('fuzzBitgridOpts').style.display  = fuzzCfg.payMode === 'bitgrid' ? 'block' : 'none';
}

// ── Init (deferred: DOM is ready) ──
fuzzInitUI();
if (window._fuzzPending) window.fuzzApply(window._fuzzPending);
else fuzzWriteToDOM();
fuzzUpdateIndicator();
