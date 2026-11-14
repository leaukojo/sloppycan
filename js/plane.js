// ── Plane: Control panel + Dashboard sections ───────────────────────────────
// The two contract 'in' signals the RAMN controls do not fit: `elevator` and `flaps` (CANaerospace
// flavor; no frame decode here, panel-only, exactly like boat-pilot.js's `sheet`). Owned here,
// permanently, in window.carlitoUplinkSources - nothing else on this side sources them, so there
// is no RAMN state to hand back to and no claim is needed. The plane is still flown on the RAMN
// accel/brake/steer/key axes, so it has no window of its own: the two commands are a Control panel
// section and flaps_actual a Dashboard section (vehiclePanelSection), shown while a plane is on
// the link.
//
// ELEVATOR SPRINGS BACK TO CENTRE on release: plane.gd reads it as a pitch-TORQUE command with its
// own rate damper, so a yoke nobody is holding should command nothing, the same reasoning drone.js
// gives its pitch stick. FLAPS LATCH where you leave them, like a real flap lever - they are not
// something a pilot holds a stick against.
//
// Integration: index.html (script after vehicle-panel.js + ramn.js). Live-only: no persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.pln-ctl .vp-sec-lbl .v { font-family:var(--mono); font-size:inherit; color:var(--text); letter-spacing:0; text-transform:none; }
.pln-range { width:100%; margin:0; cursor:pointer; accent-color:var(--blue); }
.pln-read-row { display:flex; justify-content:space-between; font-size:var(--fs-s); text-transform:uppercase;
  letter-spacing:.06em; color:var(--text2); margin-bottom:4px; }
.pln-read-row .v { font-family:var(--mono); font-size:var(--fs-s); color:var(--text); letter-spacing:0; }
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

  // ── Sections ────────────────────────────────────────────────────────────────
  const CTL = `<div class="pln-ctl">
    <div class="vp-sec-lbl"><span>Plane commands</span></div>

    <div class="vp-sec-lbl" title="contract elevator - pitch command, + = nose up. Springs back to centre on release: plane.gd reads it as a pitch-torque command with its own rate damper, so letting go commands nothing."><span>Elevator</span><span class="v" id="plnElevV">+0%</span></div>
    <input type="range" class="pln-range" id="plnElev" min="-100" max="100" value="0" title="+ noses up, - noses down. Springs back to centre when you let go.">

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="contract flaps - flap setting request, arcade lift/drag boost. Latches where you leave it, like a real flap lever."><span>Flaps</span><span class="v" id="plnFlapsV">0%</span></div>
    <input type="range" class="pln-range" id="plnFlaps" min="0" max="100" value="0">
</div>`;
  const DASH = `
    <div class="vp-sec-lbl"><span>Plane</span></div>
    <div class="pln-read-row" title="contract flaps_actual - actual flap position, slewed toward the request."><span>Flaps actual</span><span class="v" id="plnFlapsActual">-</span></div>

`;
  const ctl = window.vehiclePanelSection({ family: 'plane', where: 'ctrl', html: CTL, render: () => render() });
  const dash = window.vehiclePanelSection({ family: 'plane', where: 'dash', html: DASH, render: (t) => renderDash(t) });

  // ── Render ────────────────────────────────────────────────────────────────────
  function render() {
    el.elevV.textContent = (stick.elevator >= 0 ? '+' : '') + Math.round(stick.elevator) + '%';
    el.flapsV.textContent = Math.round(planeCtl.flaps) + '%';
  }
  function renderDash(tel) {
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
    const q = ctl.q;

    el = {
      elevV: q('plnElevV'), flapsV: q('plnFlapsV'), flapsActual: dash.q('plnFlapsActual'),
    };

    bindSpring(q('plnElev'), (v) => { stick.elevator = v; render(); });
    q('plnFlaps').addEventListener('input', (e) => { planeCtl.flaps = +e.target.value; render(); });

    render();
  })();

})();
