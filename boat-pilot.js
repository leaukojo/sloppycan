// ── Boat autopilot control head ─────────────────────────────────────────────
// The commanded half boat.js deliberately left out: boat.js's own header says outright that
// `sheet` / `rudder` / `nav_mode` / `heading_cmd` belong to "an autopilot control head", because
// boat.js is TELEMETRY ONLY and none of those four has a telemetry echo worth drawing a widget
// over. This is that control head, but only for THREE of the four: `rudder` is deliberately
// left unsourced here too, exactly as it is everywhere else on this side today (carlito.js's own
// checkOutFields note lists it among the controls with no sloppyCAN source built yet) - the boat
// is steered on the RAMN 'steer' axis, which InputRouter's own arbitration already accepts as the
// rudder command when 'rudder' itself is absent, so nothing is lost by not sourcing it.
//
// `sheet` is OWNED here: this window sources it into window.carlitoUplinkSources, permanently
// rather than as a claim, because nothing else on this side sources it (the carlito.js
// MODULE_IN_SOURCES rule). nav_mode / heading_cmd are NOT - nmea2000.js owns them, because it
// also reads them off the bus (PGN 127237) and carlito-bridge.html loads it and not this file. So
// the mode buttons and the heading knob are a view over that state (nmea2000PilotCtl /
// nmea2000SetPilot), the way drone.js is a view over dronecan.js's dcCtl.
//
// This window does NOT take the RAMN pair or the boat dashboard: the boat is still driven with
// the RAMN accel/brake/steer axes exactly as boat.js's own header says, so there is nothing here
// for vehiclePanelClaim to take - it only registers for the toolbar button's own show/hide, the
// way every panel's `family` entry does.
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
// Integration: index.html (script after boat.js, before carlito.js - #boatPilotBtn ships
// style="display:none", vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list).
// Live-only: no persistence.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.bap-window {
  position:fixed; z-index:900; top:72px; left:430px; width:230px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.bap-window.open { display:flex; }
.bap-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.bap-header .bap-dot { width:8px; height:8px; border-radius:50%; background:var(--amber); flex-shrink:0; }
.bap-header .bap-title { flex:1; }
.bap-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.bap-close:hover { background:var(--bg); color:var(--text); }
.bap-scaleouter { overflow:hidden; }
.bap-body { width:230px; transform-origin:top left; padding:12px 14px 16px; box-sizing:border-box; }
.bap-rule { height:1px; background:var(--border); margin:9px 0 8px; }
.bap-sec-lbl {
  display:flex; justify-content:space-between; align-items:baseline;
  font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:6px;
}
.bap-seg { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.bap-seg button {
  padding:6px 4px; font-size:11px; font-family:var(--sans); text-transform:uppercase;
  letter-spacing:.06em; color:var(--text2); background:var(--bg); border:1px solid var(--border);
  border-radius:7px; cursor:pointer;
}
.bap-seg button.on { color:var(--amber); border-color:var(--amber); background:var(--amber-dim); }
.bap-hdg { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.bap-hdg-v { font-family:var(--mono); font-size:16px; color:var(--text); min-width:52px; text-align:center; }
.bap-hdg-v.uncaptured { color:var(--text3); }
.bap-nudges { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-top:6px; }
.bap-nudges button {
  padding:5px 0; font-family:var(--mono); font-size:11px; color:var(--text2);
  background:var(--bg); border:1px solid var(--border); border-radius:6px; cursor:pointer;
}
.bap-nudges button:hover { color:var(--text); border-color:var(--border2); }
.bap-sheet-row { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase;
  letter-spacing:.06em; color:var(--text3); margin-bottom:4px; }
.bap-sheet-row .v { font-family:var(--mono); font-size:11px; color:var(--text); letter-spacing:0; }
.bap-range { width:100%; }
.bap-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(style);

  const BASE_W = 230;
  const PANEL_ID = 'boat-pilot';
  const FAMILY = 'boat';
  const HEADING_STEPS = [-10, -1, 1, 10];

  const wrap360 = (deg) => ((deg % 360) + 360) % 360;

  // ── State ───────────────────────────────────────────────────────────────────
  // Only `sheet` lives here. The pilot's mode and heading are nmea2000.js's, read and written
  // through its accessors; its heading starts uncaptured (null), so nothing is commanded until
  // the first nudge seeds it off the boat's own heading_target.
  const bap = { sheet: 0 };
  const pilot = () => (window.nmea2000PilotCtl ? window.nmea2000PilotCtl() : { navMode: 0, headingCmd: null });
  const setPilot = (p) => { if (window.nmea2000SetPilot) window.nmea2000SetPilot(p); };
  let tel = null;
  let scale = () => {};
  let el = {};

  // ── Uplink sourcing - the permanent registry, never a claim ─────────────────
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    sheet: () => bap.sheet,
  });

  // ── Window DOM ──────────────────────────────────────────────────────────────
  const win = document.createElement('div');
  win.className = 'bap-window';
  win.id = 'boatPilotWindow';
  win.innerHTML = `
  <div class="bap-header" id="bapHeader" title="Commands the boat's autopilot and sail over the uplink - the three contract 'in' signals boat.js's own dashboard has no widget for. 'rudder' is not here: the boat is still steered on the RAMN steering axis. Drag to move, grip the bottom-right corner to resize.">
    <span class="bap-dot"></span>
    <span class="bap-title">Boat autopilot</span>
    <button class="bap-close" id="bapCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="bap-scaleouter" id="bapScaleOuter">
   <div class="bap-body" id="bapBody">

    <div class="bap-sec-lbl" title="contract nav_mode - the request, mirrored verbatim. STANDBY hands the rudder to the helm; HEADING HOLD asks the pilot to steer the commanded course. What it is ACTUALLY doing (nav_mode_actual) reads back on the boat dashboard's Autopilot chip.">Mode</div>
    <div class="bap-seg">
      <button id="bapStandby" title="nav_mode = 0. Hand-steered on the RAMN rudder axis.">Standby</button>
      <button id="bapAuto" title="nav_mode = 1. The pilot steers 'heading_cmd' if this window has sent one, or the course it captured at the moment you last engaged.">Auto</button>
    </div>

    <div class="bap-rule"></div>
    <div class="bap-sec-lbl" title="contract heading_cmd - a compass bearing, only meaningful in Auto. Presence IS the command: this window sends nothing until the first nudge below, so engaging Auto alone captures whatever course the boat is already on (the dashboard's Target chip reads it back) rather than steering to an arbitrary number.">Heading</div>
    <div class="bap-hdg">
      <span class="bap-hdg-v uncaptured" id="bapHdgV">captured</span>
    </div>
    <div class="bap-nudges">
      <button data-d="-10" title="Nudge the commanded heading -10 degrees. The first press seeds it off the boat's current heading_target.">-10</button>
      <button data-d="-1"  title="Nudge the commanded heading -1 degree.">-1</button>
      <button data-d="1"   title="Nudge the commanded heading +1 degree.">+1</button>
      <button data-d="10"  title="Nudge the commanded heading +10 degrees.">+10</button>
    </div>

    <div class="bap-rule"></div>
    <div class="bap-sheet-row" title="contract sheet - how far the boom is allowed to swing, 0 hauled in hard to 100 fully eased. A LIMIT, not a position: the boom lines up with the wind (luffing) once eased past the apparent wind angle. Read the result on the boat dashboard's wind rose - the boom needle and the AoA readout.">
      <span>Sheet</span><span class="v" id="bapSheetV">0%</span>
    </div>
    <input type="range" class="bap-range" id="bapSheet" min="0" max="100" value="0">

   </div>
  </div>
  <div class="bap-resize" id="bapResize"></div>
`;

  // ── Window open / close ──────────────────────────────────────────────────────
  const isOpen = () => win.classList.contains('open');
  function setOpen(open) {
    if (isOpen() === open) return;
    win.classList.toggle('open', open);
    if (open) scale(win.offsetWidth || BASE_W);
    const b = document.getElementById('boatPilotBtn');
    if (b) b.classList.toggle('active', open);
  }
  function boatPilotToggle() { setOpen(!isOpen()); }

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
      const base = Number(tel && tel.heading_target);
      h = Number.isFinite(base) ? Math.round(base) : 0;
    }
    setPilot({ headingCmd: wrap360(h + delta) });
    render();
  }

  window.vehiclePanelSubscribe(function (t) { tel = t; if (isOpen()) render(); });

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    document.body.appendChild(win);
    const q = (id) => win.querySelector('#' + id);

    el = {
      standby: q('bapStandby'), auto: q('bapAuto'),
      hdgV: q('bapHdgV'), sheetV: q('bapSheetV'), sheet: q('bapSheet'),
    };

    el.standby.addEventListener('click', () => { setPilot({ navMode: 0 }); render(); });
    el.auto.addEventListener('click', () => { setPilot({ navMode: 1 }); render(); });
    for (const btn of win.querySelectorAll('.bap-nudges button')) {
      btn.addEventListener('click', () => nudgeHeading(parseInt(btn.dataset.d, 10)));
    }
    el.sheet.addEventListener('input', () => { bap.sheet = parseInt(el.sheet.value, 10) || 0; render(); });

    q('bapCloseBtn').addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; setOpen(false);
    });

    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: q('bapHeader'), grip: q('bapResize'),
        outer: q('bapScaleOuter'), body: q('bapBody'),
        baseW: BASE_W, closeSel: '.bap-close',
      });
    } else {
      console.warn('Boat autopilot panel: makeFloating is missing - load ramn.js before boat-pilot.js.');
    }

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: PANEL_ID, family: FAMILY, btn: 'boatPilotBtn', isOpen,
        close: () => setOpen(false),
      });
    }

    render();
  })();

  window.boatPilotToggle = boatPilotToggle;
})();
