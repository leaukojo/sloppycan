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
// Integration: index.html (script after vehicle-panel.js + ramn.js - #planeBtn
// ships style="display:none", vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list).
// Live-only: no persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.pln-body .vp-sec-lbl .v { font-family:var(--mono); font-size:inherit; color:var(--text); letter-spacing:0; text-transform:none; }
.pln-range { width:100%; margin:0; cursor:pointer; accent-color:var(--blue); }
.pln-read-row { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase;
  letter-spacing:.06em; color:var(--text3); margin-bottom:4px; }
.pln-read-row .v { font-family:var(--mono); font-size:11px; color:var(--text); letter-spacing:0; }
`;
  document.head.appendChild(style);

  // ── State ───────────────────────────────────────────────────────────────────
  // Elevator springs back to 0 on release; flaps latch where set.
  const stick = { elevator: 0 };
  const planeCtl = { flaps: 0 };
  let el = {};

  // ── Uplink sourcing - the permanent registry, never a claim ─────────────────
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    elevator: () => stick.elevator,
    flaps: () => planeCtl.flaps,
  });

  // ── Panel ───────────────────────────────────────────────────────────────────
  // No claim and no follow: the plane is flown on the RAMN axes, so this window opens only by hand.
  const BODY = `

    <div class="vp-sec-lbl" title="contract elevator - pitch command, + = nose up. Springs back to centre on release: plane.gd reads it as a pitch-torque command with its own rate damper, so letting go commands nothing."><span>Elevator</span><span class="v" id="plnElevV">+0%</span></div>
    <input type="range" class="pln-range" id="plnElev" min="-100" max="100" value="0" title="+ noses up, - noses down. Springs back to centre when you let go.">

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="contract flaps - flap setting request, arcade lift/drag boost. Latches where you leave it, like a real flap lever."><span>Flaps</span><span class="v" id="plnFlapsV">0%</span></div>
    <input type="range" class="pln-range" id="plnFlaps" min="0" max="100" value="0">

    <div class="vp-rule"></div>
    <div class="pln-read-row" title="contract flaps_actual - actual flap position, slewed toward the request."><span>Flaps actual</span><span class="v" id="plnFlapsActual">-</span></div>

`;
  const panel = window.makeVehiclePanel({
    id: 'plane', family: 'plane', btn: 'planeBtn',
    cssPrefix: 'pln', title: 'Plane controls', baseW: 230, left: 430, dot: 'var(--amber)',
    headerTip: 'The two plane commands the RAMN controls have no board position for. Drag to move, grip the bottom-right corner to resize.',
    bodyHtml: BODY,
    render: () => render(),
  });

  // ── Render ────────────────────────────────────────────────────────────────────
  function render() {
    el.elevV.textContent = (stick.elevator >= 0 ? '+' : '') + Math.round(stick.elevator) + '%';
    el.flapsV.textContent = Math.round(planeCtl.flaps) + '%';
    const tel = panel.tel();
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

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    const q = panel.q;

    el = {
      elevV: q('plnElevV'), flapsV: q('plnFlapsV'), flapsActual: q('plnFlapsActual'),
    };

    bindSpring(q('plnElev'), (v) => { stick.elevator = v; render(); });
    q('plnFlaps').addEventListener('input', (e) => { planeCtl.flaps = +e.target.value; render(); });

    render();
  })();

  window.planeToggle = panel.toggle;
})();
