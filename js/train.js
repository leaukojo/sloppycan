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
// Integration: index.html (script after vehicle-panel.js + ramn.js - #trainBtn
// ships style="display:none", vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list).
// Live-only: no persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
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
`;
  document.head.appendChild(style);

  // Warn thresholds are read off the contract, never retyped (vehicle-panel.js).
  const { isWarn } = window.vehiclePanelUtil;

  // ── State ───────────────────────────────────────────────────────────────────
  // Both switches live here, permanently. Pantograph starts raised (see header); doors start shut.
  const trainCtl = { pantograph: true, doors: false };
  let el = {};

  // ── Uplink sourcing - the permanent registry, never a claim ─────────────────
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    pantograph: () => trainCtl.pantograph,
    doors: () => trainCtl.doors,
  });

  // ── Panel ───────────────────────────────────────────────────────────────────
  // No claim and no follow: the train is driven on the RAMN axes, so this window opens only by hand.
  const BODY = `

    <div class="vp-sec-lbl" title="contract pantograph - raise request, mirrored verbatim. Traction is cut while lowered, like the key gate. Starts raised so a locally driven train can move without visiting this panel first.">Pantograph</div>
    <div class="trn-toggle on" id="trnPanto">Raised</div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="contract doors - open request, mirrored verbatim, honored only at standstill.">Doors</div>
    <div class="trn-toggle" id="trnDoors">Shut</div>

    <div class="vp-rule"></div>
    <div class="trn-read-row" title="contract pantograph_state - actually raised (request AND key Ignition)."><span>Panto actual</span><span class="v" id="trnPantoState">-</span></div>
    <div class="trn-read-row" title="contract doors_state - actually open (request honored at standstill only)."><span>Doors actual</span><span class="v" id="trnDoorsState">-</span></div>
    <div class="trn-read-row" title="contract catenary_volts - overhead line voltage at the pantograph, 0 when lowered. Amber under the collapsing-line threshold."><span>Catenary</span><span class="v" id="trnCatenary">-</span></div>

`;
  const panel = window.makeVehiclePanel({
    id: 'train', family: 'train', btn: 'trainBtn',
    cssPrefix: 'trn', title: 'Train controls', baseW: 230, left: 430, dot: 'var(--amber)',
    headerTip: 'The two train commands the RAMN controls have no board position for. Drag to move, grip the bottom-right corner to resize.',
    bodyHtml: BODY,
    render: (t, raw) => render(raw),
  });

  // ── Render ────────────────────────────────────────────────────────────────────
  // Also on every telemetry push while open: pantograph_state/doors_state lag the request by the
  // sim's own rule (key Ignition, standstill), so the readback can disagree with the switch.
  function render(tel) {
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

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    const q = panel.q;

    el = {
      panto: q('trnPanto'), doors: q('trnDoors'),
      pantoState: q('trnPantoState'), doorsState: q('trnDoorsState'), catenary: q('trnCatenary'),
    };

    el.panto.addEventListener('click', () => { trainCtl.pantograph = !trainCtl.pantograph; render(panel.tel()); });
    el.doors.addEventListener('click', () => { trainCtl.doors = !trainCtl.doors; render(panel.tel()); });

    render(panel.tel());
  })();

  window.trainToggle = panel.toggle;
})();
