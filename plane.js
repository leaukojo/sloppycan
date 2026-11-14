// ── Plane controls ───────────────────────────────────────────────────────────
// The two contract 'in' signals the RAMN controls do not fit: `elevator` and `flaps` (CANaerospace
// flavor; no frame decode here, panel-only, exactly like boat-pilot.js's `sheet`). Owned here,
// permanently, in window.carlitoUplinkSources - nothing else on this side sources them, so there
// is no RAMN state to hand back to and no claim is needed. The plane is still flown on the RAMN
// accel/brake/steer/key axes exactly as boat-pilot.js leaves the boat on the RAMN rudder axis, so
// this window takes no vehiclePanelClaim - claiming 'dash' would close the RAMN cluster the plane
// is actually flown with.
//
// ELEVATOR SPRINGS BACK TO CENTRE on release: plane.gd reads it as a pitch-TORQUE command with its
// own rate damper, so a yoke nobody is holding should command nothing, the same reasoning drone.js
// gives its pitch stick. FLAPS LATCH where you leave them, like a real flap lever - they are not
// something a pilot holds a stick against.
//
// Integration: index.html (script after vehicle-panel.js + ramn.js, before carlito.js - #planeBtn
// ships style="display:none", vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list).
// Live-only: no persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.pln-window {
  position:fixed; z-index:900; top:72px; left:430px; width:230px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.pln-window.open { display:flex; }
.pln-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.pln-header .pln-dot { width:8px; height:8px; border-radius:50%; background:var(--amber); flex-shrink:0; }
.pln-header .pln-title { flex:1; }
.pln-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.pln-close:hover { background:var(--bg); color:var(--text); }
.pln-scaleouter { overflow:hidden; }
.pln-body { width:230px; transform-origin:top left; padding:12px 14px 16px; box-sizing:border-box; }
.pln-rule { height:1px; background:var(--border); margin:9px 0 8px; }
.pln-sec-lbl {
  display:flex; justify-content:space-between; align-items:baseline;
  font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:6px;
}
.pln-sec-lbl .v { font-family:var(--mono); color:var(--text); letter-spacing:0; text-transform:none; }
.pln-range { width:100%; margin:0; cursor:pointer; accent-color:var(--blue); }
.pln-read-row { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase;
  letter-spacing:.06em; color:var(--text3); margin-bottom:4px; }
.pln-read-row .v { font-family:var(--mono); font-size:11px; color:var(--text); letter-spacing:0; }
.pln-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(style);

  const BASE_W = 230;
  const PANEL_ID = 'plane';
  const FAMILY = 'plane';

  // ── State ───────────────────────────────────────────────────────────────────
  // Elevator springs back to 0 on release; flaps latch where set.
  const stick = { elevator: 0 };
  const planeCtl = { flaps: 0 };
  let tel = null;
  let scale = () => {};
  let el = {};

  // ── Uplink sourcing - the permanent registry, never a claim ─────────────────
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    elevator: () => stick.elevator,
    flaps: () => planeCtl.flaps,
  });

  // ── Window DOM ──────────────────────────────────────────────────────────────
  const win = document.createElement('div');
  win.className = 'pln-window';
  win.id = 'planeWindow';
  win.innerHTML = `
  <div class="pln-header" id="plnHeader" title="The two plane commands the RAMN controls have no board position for. Drag to move, grip the bottom-right corner to resize.">
    <span class="pln-dot"></span>
    <span class="pln-title">Plane controls</span>
    <button class="pln-close" id="plnCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="pln-scaleouter" id="plnScaleOuter">
   <div class="pln-body" id="plnBody">

    <div class="pln-sec-lbl" title="contract elevator - pitch command, + = nose up. Springs back to centre on release: plane.gd reads it as a pitch-torque command with its own rate damper, so letting go commands nothing."><span>Elevator</span><span class="v" id="plnElevV">+0%</span></div>
    <input type="range" class="pln-range" id="plnElev" min="-100" max="100" value="0" title="+ noses up, - noses down. Springs back to centre when you let go.">

    <div class="pln-rule"></div>
    <div class="pln-sec-lbl" title="contract flaps - flap setting request, arcade lift/drag boost. Latches where you leave it, like a real flap lever."><span>Flaps</span><span class="v" id="plnFlapsV">0%</span></div>
    <input type="range" class="pln-range" id="plnFlaps" min="0" max="100" value="0">

    <div class="pln-rule"></div>
    <div class="pln-read-row" title="contract flaps_actual - actual flap position, slewed toward the request."><span>Flaps actual</span><span class="v" id="plnFlapsActual">-</span></div>

   </div>
  </div>
  <div class="pln-resize" id="plnResize"></div>
`;

  // ── Window open / close ──────────────────────────────────────────────────────
  const isOpen = () => win.classList.contains('open');
  function setOpen(open) {
    if (isOpen() === open) return;
    win.classList.toggle('open', open);
    if (open) scale(win.offsetWidth || BASE_W);
    const b = document.getElementById('planeBtn');
    if (b) b.classList.toggle('active', open);
  }
  function planeToggle() { setOpen(!isOpen()); }

  // ── Render ────────────────────────────────────────────────────────────────────
  function render() {
    el.elevV.textContent = (stick.elevator >= 0 ? '+' : '') + Math.round(stick.elevator) + '%';
    el.flapsV.textContent = Math.round(planeCtl.flaps) + '%';
    const fa = tel ? Number(tel.flaps_actual) : NaN;
    el.flapsActual.textContent = Number.isFinite(fa) ? Math.round(fa) + '%' : '-';
  }

  // A range input that returns to centre when the pointer or the key lets go of it, drone.js's
  // stick idiom - the FC there gives the same reason: a control nobody is holding reads neutral.
  function bindSpring(node, set) {
    const release = () => { node.value = '0'; set(0); };
    node.addEventListener('input', () => set(+node.value));
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('keyup', release);
    node.addEventListener('blur', release);
  }

  window.vehiclePanelSubscribe(function (t) { tel = t; if (isOpen()) render(); });

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    document.body.appendChild(win);
    const q = (id) => win.querySelector('#' + id);

    el = {
      elevV: q('plnElevV'), flapsV: q('plnFlapsV'), flapsActual: q('plnFlapsActual'),
    };

    bindSpring(q('plnElev'), (v) => { stick.elevator = v; render(); });
    q('plnFlaps').addEventListener('input', (e) => { planeCtl.flaps = +e.target.value; render(); });

    q('plnCloseBtn').addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; setOpen(false);
    });

    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: q('plnHeader'), grip: q('plnResize'),
        outer: q('plnScaleOuter'), body: q('plnBody'),
        baseW: BASE_W, closeSel: '.pln-close',
      });
    } else {
      console.warn('Plane panel: makeFloating is missing - load ramn.js before plane.js.');
    }

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: PANEL_ID, family: FAMILY, btn: 'planeBtn', isOpen,
        close: () => setOpen(false),
      });
    }

    render();
  })();

  window.planeToggle = planeToggle;
})();
