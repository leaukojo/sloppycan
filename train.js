// ── Train controls ───────────────────────────────────────────────────────────
// The two contract 'in' signals the RAMN controls do not fit: `pantograph` and `doors`, mirrored
// verbatim like every other in-bit but with nothing on the RAMN board that carries them (the
// contract's 'train' flavor note - no real train CAN standard is adopted here). This window OWNS
// both, permanently, in window.carlitoUplinkSources - a bench switch, not a claim: nothing else on
// this side sources them, so there is no RAMN state to hand back to (the boat-pilot.js `sheet`
// rule). The train is still driven on the RAMN accel/brake/key/lights axes exactly as boat-pilot.js
// leaves the boat on the RAMN rudder axis, so this window takes no vehiclePanelClaim - claiming
// 'dash' would close the RAMN cluster the train is actually driven with.
//
// PANTOGRAPH STARTS RAISED: the game's own local default is a train that can move, and this panel
// is where you LOWER it, not where you have to remember to raise it before every drive. Doors
// start shut. A car or truck ignores both bits; only the contract's `train` family reads them.
//
// Integration: index.html (script after vehicle-panel.js + ramn.js, before carlito.js - #trainBtn
// ships style="display:none", vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list).
// Live-only: no persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.trn-window {
  position:fixed; z-index:900; top:72px; left:430px; width:230px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.trn-window.open { display:flex; }
.trn-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.trn-header .trn-dot { width:8px; height:8px; border-radius:50%; background:var(--amber); flex-shrink:0; }
.trn-header .trn-title { flex:1; }
.trn-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.trn-close:hover { background:var(--bg); color:var(--text); }
.trn-scaleouter { overflow:hidden; }
.trn-body { width:230px; transform-origin:top left; padding:12px 14px 16px; box-sizing:border-box; }
.trn-rule { height:1px; background:var(--border); margin:9px 0 8px; }
.trn-sec-lbl {
  display:flex; justify-content:space-between; align-items:baseline;
  font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:6px;
}
.trn-toggle {
  padding:8px 0; font-size:12px; font-family:var(--sans); text-align:center; text-transform:uppercase;
  letter-spacing:.06em; color:var(--text2); background:var(--bg); border:1px solid var(--border);
  border-radius:7px; cursor:pointer; user-select:none;
}
.trn-toggle:hover { background:var(--bg3); color:var(--text); }
.trn-toggle.on { color:var(--green); border-color:transparent; background:var(--green-dim); }
.trn-read-row { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase;
  letter-spacing:.06em; color:var(--text3); margin-bottom:4px; }
.trn-read-row .v { font-family:var(--mono); font-size:11px; color:var(--text); letter-spacing:0; }
.trn-read-row .v.warn { color:var(--amber); }
.trn-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(style);

  const BASE_W = 230;
  const PANEL_ID = 'train';
  const FAMILY = 'train';

  // Warn thresholds are read off the contract, never retyped - boat.js's own copy of the helper,
  // for the same reason it gives (vehicle-panel.js owns the mechanism, not a utility surface).
  const CONTRACT = window.CARLITO_CONTRACT || { signals: [] };
  const SIGS = CONTRACT.signals || [];
  function isWarn(name, v) {
    const s = SIGS.find(x => x.name === name && x.dir === 'out');
    if (!s || !Number.isFinite(Number(s.warn)) || !Number.isFinite(v)) return false;
    return s.warn_side === 'low' ? v <= s.warn : v >= s.warn;
  }

  // ── State ───────────────────────────────────────────────────────────────────
  // Both switches live here, permanently. Pantograph starts raised (see header); doors start shut.
  const trainCtl = { pantograph: true, doors: false };
  let tel = null;
  let scale = () => {};
  let el = {};

  // ── Uplink sourcing - the permanent registry, never a claim ─────────────────
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    pantograph: () => trainCtl.pantograph,
    doors: () => trainCtl.doors,
  });

  // ── Window DOM ──────────────────────────────────────────────────────────────
  const win = document.createElement('div');
  win.className = 'trn-window';
  win.id = 'trainWindow';
  win.innerHTML = `
  <div class="trn-header" id="trnHeader" title="The two train commands the RAMN controls have no board position for. Drag to move, grip the bottom-right corner to resize.">
    <span class="trn-dot"></span>
    <span class="trn-title">Train controls</span>
    <button class="trn-close" id="trnCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="trn-scaleouter" id="trnScaleOuter">
   <div class="trn-body" id="trnBody">

    <div class="trn-sec-lbl" title="contract pantograph - raise request, mirrored verbatim. Traction is cut while lowered, like the key gate. Starts raised so a locally driven train can move without visiting this panel first.">Pantograph</div>
    <div class="trn-toggle on" id="trnPanto">Raised</div>

    <div class="trn-rule"></div>
    <div class="trn-sec-lbl" title="contract doors - open request, mirrored verbatim, honored only at standstill.">Doors</div>
    <div class="trn-toggle" id="trnDoors">Shut</div>

    <div class="trn-rule"></div>
    <div class="trn-read-row" title="contract pantograph_state - actually raised (request AND key Ignition)."><span>Panto actual</span><span class="v" id="trnPantoState">-</span></div>
    <div class="trn-read-row" title="contract doors_state - actually open (request honored at standstill only)."><span>Doors actual</span><span class="v" id="trnDoorsState">-</span></div>
    <div class="trn-read-row" title="contract catenary_volts - overhead line voltage at the pantograph, 0 when lowered. Amber under the collapsing-line threshold."><span>Catenary</span><span class="v" id="trnCatenary">-</span></div>

   </div>
  </div>
  <div class="trn-resize" id="trnResize"></div>
`;

  // ── Window open / close ──────────────────────────────────────────────────────
  const isOpen = () => win.classList.contains('open');
  function setOpen(open) {
    if (isOpen() === open) return;
    win.classList.toggle('open', open);
    if (open) scale(win.offsetWidth || BASE_W);
    const b = document.getElementById('trainBtn');
    if (b) b.classList.toggle('active', open);
  }
  function trainToggle() { setOpen(!isOpen()); }

  // ── Render ────────────────────────────────────────────────────────────────────
  // Also on every telemetry push while open: pantograph_state/doors_state lag the request by the
  // sim's own rule (key Ignition, standstill), so the readback can disagree with the switch.
  function render() {
    el.panto.classList.toggle('on', trainCtl.pantograph);
    el.panto.textContent = trainCtl.pantograph ? 'Raised' : 'Lowered';
    el.doors.classList.toggle('on', trainCtl.doors);
    el.doors.textContent = trainCtl.doors ? 'Open' : 'Shut';
    el.pantoState.textContent = tel ? (tel.pantograph_state ? 'raised' : 'lowered') : '-';
    el.doorsState.textContent = tel ? (tel.doors_state ? 'open' : 'shut') : '-';
    const v = tel ? Number(tel.catenary_volts) : NaN;
    el.catenary.textContent = Number.isFinite(v) ? Math.round(v) + ' V' : '-';
    el.catenary.classList.toggle('warn', isWarn('catenary_volts', v));
  }

  window.vehiclePanelSubscribe(function (t) { tel = t; if (isOpen()) render(); });

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    document.body.appendChild(win);
    const q = (id) => win.querySelector('#' + id);

    el = {
      panto: q('trnPanto'), doors: q('trnDoors'),
      pantoState: q('trnPantoState'), doorsState: q('trnDoorsState'), catenary: q('trnCatenary'),
    };

    el.panto.addEventListener('click', () => { trainCtl.pantograph = !trainCtl.pantograph; render(); });
    el.doors.addEventListener('click', () => { trainCtl.doors = !trainCtl.doors; render(); });

    q('trnCloseBtn').addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; setOpen(false);
    });

    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: q('trnHeader'), grip: q('trnResize'),
        outer: q('trnScaleOuter'), body: q('trnBody'),
        baseW: BASE_W, closeSel: '.trn-close',
      });
    } else {
      console.warn('Train panel: makeFloating is missing - load ramn.js before train.js.');
    }

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: PANEL_ID, family: FAMILY, btn: 'trainBtn', isOpen,
        close: () => setOpen(false),
      });
    }

    render();
  })();

  window.trainToggle = trainToggle;
})();
