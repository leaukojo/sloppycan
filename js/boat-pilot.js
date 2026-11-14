// ── Boat autopilot: a Control panel section ─────────────────────────────────
// The commanded half boat.js deliberately left out: boat.js's own header says outright that
// `sheet` / `rudder` / `nav_mode` / `heading_cmd` belong to "an autopilot control head", because
// boat.js is TELEMETRY ONLY and none of those four has a telemetry echo worth drawing a widget
// over. This is that control head, but only for THREE of the four: `rudder` is nmea2000.js's,
// decoded off PGN 127245's rudder order, and otherwise the boat is steered on the RAMN 'steer'
// axis, which InputRouter's own arbitration accepts as the rudder command when 'rudder' is absent.
//
// `sheet` is OWNED here: this window sources it into window.carlitoUplinkSources, permanently
// rather than as a claim, because nothing else on this side sources it (the carlito.js
// MODULE_IN_SOURCES rule). nav_mode / heading_cmd are NOT - nmea2000.js owns them, because it
// also reads them off the bus (PGN 127237) and carlito-bridge.html loads it and not this file. So
// the mode buttons and the heading knob are a view over that state (nmea2000PilotCtl /
// nmea2000SetPilot), the way drone.js is a view over dronecan.js's dcCtl.
//
// Not a window: a section of the Control panel (vehiclePanelSection), shown while a boat is on
// the link - the boat is still driven with the RAMN accel/brake/steer axes exactly as boat.js's
// own header says, so its commands sit beside them rather than in a second window.
//
// HEADING KNOB CAPTURE: the contract states 'heading_cmd' is PRESENCE-IS-THE-COMMAND - sourcing
// a number the moment this window loads would engage the pilot on an arbitrary bearing before
// anyone touched a control. So the source stays undefined (nothing commanded) until the FIRST
// nudge, and that nudge seeds itself off the boat's own 'heading_target' - the exact value the
// contract says an engage would capture - rather than off zero.
//
// 'sheet' has no presence rule (mirrored verbatim, absent = 0 = hauled in), so it is always
// sourced straight off the slider.
//
// Integration: index.html (script after vehicle-panel.js + ramn.js + boat.js). Live-only: no
// persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.bap-seg { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.bap-seg button {
  padding:6px 4px; font-size:var(--fs-s); font-family:var(--sans); text-transform:uppercase;
  letter-spacing:.06em; color:var(--text2); background:var(--bg); border:1px solid var(--border);
  border-radius:0; cursor:pointer;
}
.bap-seg button.on { color:var(--amber); border-color:var(--amber); background:var(--amber-dim); }
.bap-hdg { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.bap-hdg-v { font-family:var(--mono); font-size:var(--fs-l); color:var(--text); min-width:52px; text-align:center; }
.bap-hdg-v.uncaptured { color:var(--text3); }
.bap-nudges { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-top:6px; }
.bap-nudges button {
  padding:5px 0; font-family:var(--mono); font-size:var(--fs-s); color:var(--text2);
  background:var(--bg); border:1px solid var(--border); border-radius:0; cursor:pointer;
}
.bap-nudges button:hover { color:var(--text); border-color:var(--border2); }
.bap-sheet-row { display:flex; justify-content:space-between; font-size:var(--fs-s); text-transform:uppercase;
  letter-spacing:.06em; color:var(--text2); margin-bottom:4px; }
.bap-sheet-row .v { font-family:var(--mono); font-size:var(--fs-s); color:var(--text); letter-spacing:0; }
.bap-range { width:100%; }
`;
  document.head.appendChild(style);

  const HEADING_STEPS = [-10, -1, 1, 10];

  const wrap360 = (deg) => ((deg % 360) + 360) % 360;

  // ── State ───────────────────────────────────────────────────────────────────
  // Only `sheet` lives here. The pilot's mode and heading are nmea2000.js's, read and written
  // through its accessors; its heading starts uncaptured (null), so nothing is commanded until
  // the first nudge seeds it off the boat's own heading_target.
  const bap = { sheet: 0 };
  const pilot = () => (window.nmea2000PilotCtl ? window.nmea2000PilotCtl() : { navMode: 0, headingCmd: null });
  const setPilot = (p) => { if (window.nmea2000SetPilot) window.nmea2000SetPilot(p); };
  let el = {};

  // ── Uplink sourcing - the permanent registry, never a claim ─────────────────
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    sheet: () => bap.sheet,
  });

  // ── Panel ───────────────────────────────────────────────────────────────────
  // A Control panel section (see header).
  const BODY = `
    <div class="vp-sec-lbl"><span>Boat autopilot</span></div>

    <div class="vp-sec-lbl" title="contract nav_mode - the request, mirrored verbatim. STANDBY hands the rudder to the helm; HEADING HOLD asks the pilot to steer the commanded course. What it is ACTUALLY doing (nav_mode_actual) reads back on the boat dashboard's Autopilot chip.">Mode</div>
    <div class="bap-seg">
      <button id="bapStandby" title="nav_mode = 0. Hand-steered on the RAMN rudder axis.">Standby</button>
      <button id="bapAuto" title="nav_mode = 1. The pilot steers 'heading_cmd' if this window has sent one, or the course it captured at the moment you last engaged.">Auto</button>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="contract heading_cmd - a compass bearing, only meaningful in Auto. Presence IS the command: this window sends nothing until the first nudge below, so engaging Auto alone captures whatever course the boat is already on (the dashboard's Target chip reads it back) rather than steering to an arbitrary number.">Heading</div>
    <div class="bap-hdg">
      <span class="bap-hdg-v uncaptured" id="bapHdgV">captured</span>
    </div>
    <div class="bap-nudges" id="bapNudges">
      <button data-d="-10" title="Nudge the commanded heading -10 degrees. The first press seeds it off the boat's current heading_target.">-10</button>
      <button data-d="-1"  title="Nudge the commanded heading -1 degree.">-1</button>
      <button data-d="1"   title="Nudge the commanded heading +1 degree.">+1</button>
      <button data-d="10"  title="Nudge the commanded heading +10 degrees.">+10</button>
    </div>

    <div class="vp-rule"></div>
    <div class="bap-sheet-row" title="contract sheet - how far the boom is allowed to swing, 0 hauled in hard to 100 fully eased. A LIMIT, not a position: the boom lines up with the wind (luffing) once eased past the apparent wind angle. Read the result on the boat dashboard's wind rose - the boom needle and the AoA readout.">
      <span>Sheet</span><span class="v" id="bapSheetV">0%</span>
    </div>
    <input type="range" class="bap-range" id="bapSheet" min="0" max="100" value="0">

`;
  const panel = window.vehiclePanelSection({ family: 'boat', where: 'ctrl', html: BODY, render: () => render() });

  // ── Render ────────────────────────────────────────────────────────────────────
  // Also on every telemetry push while open: a 127237 on the bus can change the pilot state
  // behind this window's back.
  function render() {
    const p = pilot();
    el.standby.classList.toggle('on', p.navMode === 0);
    el.auto.classList.toggle('on', p.navMode === 1);
    el.hdgV.textContent = p.headingCmd === null ? 'captured' : Math.round(p.headingCmd) + '°';
    el.hdgV.classList.toggle('uncaptured', p.headingCmd === null);
    el.sheetV.textContent = Math.round(bap.sheet) + '%';
  }

  function nudgeHeading(delta) {
    let h = pilot().headingCmd;
    if (h === null) {
      const tel = panel.tel();
      const base = Number(tel && tel.heading_target);
      h = Number.isFinite(base) ? Math.round(base) : 0;
    }
    setPilot({ headingCmd: wrap360(h + delta) });
    render();
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    const q = panel.q;

    el = {
      standby: q('bapStandby'), auto: q('bapAuto'),
      hdgV: q('bapHdgV'), sheetV: q('bapSheetV'), sheet: q('bapSheet'),
    };

    el.standby.addEventListener('click', () => { setPilot({ navMode: 0 }); render(); });
    el.auto.addEventListener('click', () => { setPilot({ navMode: 1 }); render(); });
    q('bapNudges').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-d]');
      if (btn) nudgeHeading(parseInt(btn.dataset.d, 10));
    });
    el.sheet.addEventListener('input', () => { bap.sheet = parseInt(el.sheet.value, 10) || 0; render(); });

    render();
  })();

})();
