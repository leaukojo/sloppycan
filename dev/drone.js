// ── Drone Dashboard + Drone Control ─────────────────────────────────────────
// Self-contained module. Two floating, draggable, resizable windows, the RAMN pair's shape for
// an aircraft instead of a car:
//   1. Drone Dashboard - renders the Carlito drone's telemetry (arming, mode, pack, GNSS,
//      heights, the four ESCs, the eight-node bus) straight off the telemetry push.
//   2. Drone Control - the sticks and switches that fly it. ARM and the climb axis reach the
//      game nowhere else; the rest are dronecan.js's bench controls, brought to a window you
//      can watch the aircraft from.
//
// WHY THIS EXISTS. While the bridge is fresh the game's InputRouter reads the payload and
// ignores its own latches, and the touch overlay hides every control it has taken - so with
// sloppyCAN on the link the drone's ARM, MODE, HOOK, FAIL and climb pads are gone from the game
// and something on this side has to replace them. `arm` and `climb` had no uplink source at
// all, which is why the aircraft could not take off.
//
// OWNERSHIP. Every drone "in" signal is owned by dronecan.js's dcCtl - this file is a view over
// it through window.dronecanCtl / dronecanSetCtl, so the DroneCAN tab and this panel are two
// windows onto one set of switches rather than two sets. The exception is the SHARED axes
// (accel / brake / steer / key), which carlito.js sources from RAMN state for every vehicle:
// those are CLAIMED through window.carlitoUplinkOverrides while this panel is flying, and
// handed straight back when it is not.
//
// INTEGRATION POINTS - the only changes required in the other files:
//   index.html         <script src="drone.js" defer>  (after ramn.js + dronecan.js, before
//                      carlito.js) + #droneBtn, shipped style="display:none"
//   sloppycan.js       _buttonsWrap() id list; switchViewTab('dronecan') →
//                      window.vehiclePanelRequestForProto('dronecan')
//   vehicle-panel.js   fan-out, link detection, RAMN handoff, deep link, button visibility
//   carlito.js         window.carlitoUplinkOverrides
//   ramn.js            makeFloating's closeSel option (this close button is not .ramn-close)
//   carlito-bridge.js  window.droneIsOpen = () => true;   (that page has no dashboards)
// Live-only: no persistence of window position/state.

(function () {
  'use strict';

  // ── Inject CSS ──────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
/* Deliberately .ramn-window's own corner: these windows REPLACE the RAMN pair rather than sit
   beside it (see handoffRamn), so they take its place on screen too. */
.drone-window {
  position:fixed; z-index:900; top:72px; left:90px; width:320px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.drone-window.open { display:flex; }
.drone-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.drone-header .drone-dot { width:8px; height:8px; border-radius:50%; background:var(--cyan); flex-shrink:0; }
.drone-header .drone-dot.ctrl { background:var(--amber); }
.drone-header .drone-title { flex:1; }
.drone-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.drone-close:hover { background:var(--bg); color:var(--text); }
.drone-scaleouter { overflow:hidden; }
.drone-body { width:320px; transform-origin:top left; padding:12px 14px 14px; box-sizing:border-box; }
.drone-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}

/* Sections, shared by both windows */
.drone-sec { margin-bottom:10px; }
.drone-sec-lbl {
  display:flex; justify-content:space-between; align-items:center; gap:6px;
  font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:5px;
}
.drone-sec-lbl .v { font-family:var(--mono); color:var(--text); letter-spacing:0; text-transform:none; }
.drone-rule { border-top:1px solid var(--border); margin:12px 0 10px; }

/* Chips: one state each, off the contract's own enum tables */
.drone-chips { display:grid; grid-template-columns:repeat(2,1fr); gap:5px; }
.drone-chip {
  display:flex; flex-direction:column; gap:2px; padding:5px 7px; border-radius:7px;
  background:var(--bg); border:1px solid var(--border);
}
.drone-chip .cap { font-size:8px; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); }
.drone-chip .val { font-family:var(--mono); font-size:13px; line-height:1.1; color:var(--text); }
.drone-chip.green { background:var(--green-dim); border-color:transparent; }
.drone-chip.green .val { color:var(--green); }
.drone-chip.amber { background:var(--amber-dim); border-color:transparent; }
.drone-chip.amber .val { color:var(--amber); }
.drone-chip.red   { background:var(--red-dim);   border-color:transparent; }
.drone-chip.red   .val { color:var(--red); }
.drone-chip.blue  { background:var(--blue-dim);  border-color:transparent; }
.drone-chip.blue  .val { color:var(--blue); }

/* Why the FC refused. Only ever shown while arming_state is BLOCKED. */
.drone-why {
  margin-top:6px; padding:5px 7px; border-radius:7px; background:var(--red-dim);
  color:var(--red); font-size:10px; line-height:1.45;
}
.drone-why.hidden { display:none; }

/* Bars */
.drone-bar-row { margin-bottom:7px; }
.drone-bar-head { display:flex; justify-content:space-between; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:3px; }
.drone-bar-head .v { font-family:var(--mono); color:var(--text); letter-spacing:0; text-transform:none; }
.drone-bar { height:8px; background:var(--bg); border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.drone-bar > i { display:block; height:100%; width:0%; border-radius:4px; background:var(--cyan); transition:width .1s linear; }
.drone-bar.warn > i { background:var(--red); }

/* Readout grid */
.drone-reads { display:grid; grid-template-columns:repeat(3,1fr); gap:5px 8px; }
.drone-read { display:flex; flex-direction:column; gap:1px; }
.drone-read .cap { font-size:8px; text-transform:uppercase; letter-spacing:.07em; color:var(--text3); }
.drone-read .val { font-family:var(--mono); font-size:11px; color:var(--text); }

/* ESC table + node strip */
.drone-tbl { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:10px; }
.drone-tbl th { font-family:var(--sans); font-size:8px; text-transform:uppercase; letter-spacing:.07em; color:var(--text3); text-align:right; font-weight:500; padding:0 0 3px; }
.drone-tbl th:first-child, .drone-tbl td:first-child { text-align:left; }
.drone-tbl td { text-align:right; padding:1px 0; color:var(--text); }
.drone-tbl tr.fault td { color:var(--red); }
.drone-nodes { display:grid; grid-template-columns:repeat(4,1fr); gap:4px; }
.drone-node {
  padding:4px 2px; border-radius:6px; text-align:center; background:var(--bg);
  border:1px solid var(--border); font-size:9px; letter-spacing:.03em; color:var(--text2);
  cursor:pointer; user-select:none;
}
.drone-node:hover { border-color:var(--border2); color:var(--text); }
.drone-node.ok   { background:var(--green-dim); color:var(--green); border-color:transparent; }
.drone-node.warn { background:var(--amber-dim); color:var(--amber); border-color:transparent; }
.drone-node.crit { background:var(--red-dim);   color:var(--red);   border-color:transparent; }
.drone-node.cut  { text-decoration:line-through; opacity:.55; }

/* ── Control widgets ──────────────────────────────────────────────────────── */
.drone-arm {
  width:100%; padding:10px 0; font-family:var(--sans); font-size:14px; font-weight:600;
  letter-spacing:.1em; text-align:center; cursor:pointer; user-select:none;
  background:var(--bg); color:var(--text2); border:1px solid var(--border2); border-radius:8px;
}
.drone-arm:hover { background:var(--bg3); color:var(--text); }
.drone-arm.up { background:var(--red-dim); color:var(--red); border-color:transparent; }
.drone-armnote { margin-top:5px; font-size:9.5px; line-height:1.45; color:var(--text3); }
.drone-armnote.warn { color:var(--amber); }
.drone-range { width:100%; margin:0; cursor:pointer; accent-color:var(--cyan); }
.drone-range.pitch { accent-color:var(--green); }
.drone-range.yaw   { accent-color:var(--blue); }
.drone-range.gimbal { accent-color:var(--purple); }
.drone-seg { display:flex; gap:4px; }
.drone-seg button, .drone-toggle {
  flex:1; padding:6px 0; font-size:11px; font-family:var(--sans); text-align:center;
  background:var(--bg); color:var(--text2); border:1px solid var(--border);
  border-radius:6px; cursor:pointer; user-select:none; transition:background .08s,color .08s;
}
.drone-seg button:hover, .drone-toggle:hover { background:var(--bg3); color:var(--text); }
.drone-seg button.active { background:var(--blue-dim); color:var(--blue); border-color:transparent; }
.drone-toggle.on { background:var(--green-dim); color:var(--green); border-color:transparent; }
.drone-row2 { display:flex; gap:6px; align-items:center; }
.drone-mini {
  font-size:9px; font-family:var(--sans); padding:2px 8px; background:var(--bg);
  color:var(--text2); border:1px solid var(--border); border-radius:5px; cursor:pointer;
}
.drone-mini:hover { background:var(--bg3); color:var(--text); }
.drone-colour { width:34px; height:24px; padding:0; background:var(--bg); border:1px solid var(--border); border-radius:5px; cursor:pointer; }
.drone-hint {
  margin-top:8px; padding-top:9px; border-top:1px solid var(--border);
  font-size:9.5px; color:var(--text3); line-height:1.5;
}
.drone-hint b { color:var(--text2); font-weight:600; }
`;
  document.head.appendChild(style);

  // ── Contract readers ────────────────────────────────────────────────────────
  // Ranges, warn thresholds and enum labels are the CONTRACT's and are never retyped here: a bar
  // that turns red at its own signal's `warn` is the same number the game's cluster uses, and a
  // mode label that comes off the table cannot drift from the mode the game resolved.
  const CONTRACT = window.CARLITO_CONTRACT || { signals: [] };
  const SIGS = CONTRACT.signals || [];
  const sigDef = (name, dir) => SIGS.find(s => s.name === name && s.dir === dir);
  function rangeOf(name) {
    const s = sigDef(name, 'out');
    return (s && Array.isArray(s.range) && s.range.length === 2) ? s.range : [0, 1];
  }
  function isWarn(name, v) {
    const s = sigDef(name, 'out');
    if (!s || !Number.isFinite(Number(s.warn)) || !Number.isFinite(v)) return false;
    return s.warn_side === 'low' ? v <= s.warn : v >= s.warn;
  }
  const enumLabel = (name, dir, v) =>
    window.dronecanEnumLabel ? window.dronecanEnumLabel(name, dir, v) : String(v);
  const enumKeys = (name, dir) => (window.dronecanEnumKeys ? window.dronecanEnumKeys(name, dir) : []);

  // ── Which machine is on the link ────────────────────────────────────────────
  // vehicle-panel.js's test, off the contract's `vehicles` field: a drone-only "out" signal
  // being present IS the vehicle.
  const isDroneTelemetry = (t) => !!(window.vehiclePanelIsFamily && window.vehiclePanelIsFamily('drone', t));

  // ── Small helpers ───────────────────────────────────────────────────────────
  // An INSTANCED contract signal (count > 1) arrives as an ARRAY, so `+t.sig || 0` - which
  // Number()s an array into NaN and falls through to a plausible 0 - is exactly the wrong shape.
  // Read the elements by index and coerce each one, carlito.js's `inst` rule.
  const inst = (v, i) => { const n = Number(Array.isArray(v) ? v[i] : undefined); return Number.isFinite(n) ? n : NaN; };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  const fmt = (v, d, unit) => Number.isFinite(v) ? (v.toFixed(d) + (unit || '')) : '–';
  const whole = (v) => Number.isFinite(v) ? String(Math.round(v)) : '–';
  const signed = (v) => (v >= 0 ? '+' : '') + Math.round(v);
  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ROSTER = window.dronecanRoster ? window.dronecanRoster() : [];
  const BASE_W = 320;

  // ── Help text for the two GENERATED control groups ──────────────────────────
  // Keyed by the contract's own enum LABEL, not by index: a mode the contract grows arrives
  // with no tooltip rather than inheriting the previous one's, which would be worse than none.
  const MODE_HELP = {
    'STABILIZE': 'Hand-flown. The climb axis is a thrust TRIM around hover here, not a rate, ' +
      'and the craft holds neither height nor position - let go and it drifts. Needs no receiver, ' +
      'so it is the mode to take off in under a roof.',
    'ALT HOLD': 'Holds height; the climb axis becomes a climb RATE. Position is still yours - it ' +
      'will drift downwind. Needs no receiver.',
    'LOITER': 'Holds height AND position. Deflect the pitch stick and you fly, with the anchor ' +
      'following the craft, so releasing holds wherever you let go. Needs a 3D fix; without one it ' +
      'falls back to ALT HOLD. The position loop has no integrator, so it holds a bounded offset ' +
      'into wind rather than fighting to the exact metre.',
    'RTL': 'Climbs, flies back to where the craft ARMED and lands itself. Yaw stays yours. Needs a ' +
      '3D fix. The 400 m / 120 m geofence commands this once per exit - press the mode key to ' +
      'cancel it and it will not re-command until you have been back inside.',
    'LAND': 'Descends at a fixed rate and cuts ALL FOUR motor demands on touchdown, not just the ' +
      'collective - a zero collective with an attitude demand on top still drives two motors and ' +
      'leaves a landed craft fighting the slope.',
  };
  // The roster's four ESCs and four sensors say different things when they leave the bus, and the
  // difference is the whole point of being able to kill one.
  const NODE_HELP = (r, i) => `${r.name}, DroneCAN node ${r.id} (contract node_health index ${i}). ` +
    'Click to take it off the bus and click again to restore it - a bench SWITCH, not damage, so ' +
    'it survives a respawn. ' + (/^ESC/.test(r.name)
      ? 'An offline ESC is zeroed AFTER the mix and never compensated for: the controllers still ' +
        'ask for the roll and yaw they wanted and one motor does not answer, so the loss is ' +
        'asymmetric and the craft tumbles. It also refuses to arm (pre-arm bit ESC).'
      : r.name === 'GNSS' ? 'Without it there is no fix, so LOITER and RTL fall back to ALT HOLD ' +
        'and a flying craft raises the GPS LOST failsafe.'
      : r.name === 'AHRS' ? 'Nothing self-levels without an attitude solution - and it refuses to ' +
        'arm (pre-arm bit AHRS).'
      : r.name === 'POWER' ? 'The pack stops reporting; its last charge and current readings ' +
        'freeze rather than reading zero, because a dropped node cannot file a report.'
      : 'The downward rangefinder stops reporting, so AGL freezes at its last reading.');
  // THE CONTRACT'S `key` IS A CAR'S IGNITION BARREL (1 Lock / 2 On / 3 Ignition), shared by every
  // vehicle - and a quadcopter has no barrel, it has a battery you plug in. The game asks exactly
  // one question of it (`drone.gd`: `key == Ignition and pack.has_charge()` = is there a powered
  // flight controller) and treats Lock and On identically, so two positions say everything the
  // aircraft can hear. The panel offers the two the airframe HAS rather than the three the signal
  // carries; Lock is the one that means "unplugged" because it is the barrel's own off.
  const KEY_POWERED = 3, KEY_UNPOWERED = 1;

  // ── State ───────────────────────────────────────────────────────────────────
  let tel = null;               // last telemetry pushed (null = link gone)
  let droneLive = false;
  let autoOpened = false;       // the pair was opened BY the telemetry, not by hand
  let dashScale = () => {}, ctrlScale = () => {};
  let rafPending = false;
  let el = {};
  let ctrlKey = KEY_POWERED;    // the pack starts plugged in - a quad on the bench is powered
  // The climb axis has TWO inputs and one value: a slider that LATCHES (a transmitter's throttle
  // stick does not spring back) and momentary keys. The key wins while it is held and the slider
  // is what is left when it is released, so neither input has to know about the other. Pitch and
  // yaw work the same way, except their slider springs to centre like the stick it stands in for.
  let climbSlider = 0, climbKey = 0, pitchSlider = 0, pitchKey = 0, yawSlider = 0, yawKey = 0;
  const climbNow = () => (climbKey !== 0 ? climbKey : climbSlider);

  const dashOpen = () => dashWin.classList.contains('open');
  const ctrlOpen = () => ctrlWin.classList.contains('open');
  const CTL_REST = { mode: 0, led: 0, beep: false, hook: false, gimbalPitch: 0, gimbalYaw: 0, arm: false, climb: 0, failMask: 0 };
  const ctl = () => (window.dronecanCtl ? window.dronecanCtl() : CTL_REST);
  const setCtl = (p) => { if (window.dronecanSetCtl) window.dronecanSetCtl(p); syncCtrlUI(); };

  // ── Uplink overrides: the shared axes, while this panel is flying ───────────
  // Assigned at eval time because carlito.js snapshots the registry when IT evaluates, and it
  // loads after us. EVERY ONE RETURNS undefined WHEN THE PANEL IS NOT FLYING, which is what
  // hands accel/brake/steer/key back to the RAMN controls - see carlito.js's UPLINK_OVERRIDES
  // header. `key` is claimed too: an aircraft whose power switch is on a car's dashboard is one
  // the pilot cannot power up.
  //
  // The drone's axes are not the car's, and this mapping is the whole translation: contract
  // `accel`/`brake` are the game's throttle axis, which DroneVehicle reads as forward/back TILT,
  // and `steer` is its yaw rate. THERE IS NO ROLL STICK - the airframe leans on one axis and
  // turns with the other, which is what drone.gd's Vector2(tilt, 0) says.
  const stick = { pitch: 0, yaw: 0 };   // -100..100, pitch + = nose forward
  const flying = () => ctrlOpen() && droneLive;
  window.carlitoUplinkOverrides = window.carlitoUplinkOverrides || {};
  Object.assign(window.carlitoUplinkOverrides, {
    accel: () => flying() ? Math.max(0, stick.pitch) : undefined,
    brake: () => flying() ? Math.max(0, -stick.pitch) : undefined,
    steer: () => flying() ? stick.yaw : undefined,
    key:   () => flying() ? ctrlKey : undefined,
  });

  // ── Dashboard window DOM ────────────────────────────────────────────────────
  const dashWin = document.createElement('div');
  dashWin.className = 'drone-window';
  dashWin.id = 'droneWindow';
  dashWin.innerHTML = `
  <div class="drone-header" id="dnHeader" title="The drone's telemetry, read off the game's own publish at ~20 Hz. Opens by itself when a drone appears on the Carlito link and takes the RAMN dashboard's place while it is up, because a car's cluster describes nothing about a quadcopter. Drag to move, grip the bottom-right corner to resize.">
    <span class="drone-dot"></span>
    <span class="drone-title">Drone dashboard</span>
    <button class="drone-close" id="dnCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="drone-scaleouter" id="dnScaleOuter">
   <div class="drone-body" id="dnBody">
    <div class="drone-chips">
      <div class="drone-chip" id="dnChipArm" title="contract arming_state - what the flight controller says about the ARM REQUEST. DISARMED means nobody asked, BLOCKED means it was asked and refused (and the red line below names the check), ARMED means the motors are live. An unpowered aircraft reads DISARMED rather than claiming a judgement nothing made."><span class="cap">Arming</span><span class="val" id="dnArm">&ndash;</span></div>
      <div class="drone-chip" id="dnChipMode" title="contract mode_actual - the mode the FC is actually IN, against the one you asked for on the control panel. The two disagreeing is the reading: LOITER and RTL without a 3D fix fall back to ALT HOLD, a fence breach commands RTL, and an RTL on its landing leg reads LAND."><span class="cap">Mode (actual)</span><span class="val" id="dnMode">&ndash;</span></div>
      <div class="drone-chip" id="dnChipFs" title="contract failsafe - a condition the aircraft is reacting to on its own, most severe winning: BATT LOW / BATT CRIT / GPS LOST / GEOFENCE / MOTOR. It forces a mode and can only escalate one, so a flat pack cannot pull a craft out of a landing. Not a latch: it clears when its cause does."><span class="cap">Failsafe</span><span class="val" id="dnFs">&ndash;</span></div>
      <div class="drone-chip" id="dnChipFix" title="contract fix_type from the GNSS node - NO FIX / TIME / 2D / 3D. LOITER and RTL need a 3D fix; without one they fall back to ALT HOLD, and pre-arm bit GPS refuses to arm only when the mode you selected actually needs the receiver."><span class="cap">GNSS fix</span><span class="val" id="dnFix">&ndash;</span></div>
    </div>
    <div class="drone-why hidden" id="dnWhy" title="contract prearm_fail, one bit per check, decoded. Shown only while BLOCKED: it publishes 0 in flight by design, because a flying craft deflects its stick and leans past ten degrees constantly."></div>

    <div class="drone-rule"></div>
    <div class="drone-bar-row" title="contract soc - pack state of charge, coulomb-counted against the rated capacity. Red at the 20 % low-battery failsafe, which is exactly when the aircraft decides to come home; arming needs 25 %, deliberately above it.">
      <div class="drone-bar-head"><span>Pack charge</span><span class="v" id="dnSocV">&ndash;</span></div>
      <div class="drone-bar" id="dnSocBar"><i></i></div>
    </div>
    <div class="drone-bar-row" title="contract pack_temp - the battery's own temperature, a thermal lag on the measured current rather than a fixed number. Red past its contract warn.">
      <div class="drone-bar-head"><span>Pack temp</span><span class="v" id="dnPtV">&ndash;</span></div>
      <div class="drone-bar" id="dnPtBar"><i></i></div>
    </div>
    <div class="drone-bar-row" title="contract pack_current - draw measured AT THE PACK, so it deliberately disagrees with the ESC currents once a node drops: a motor that is not turning stops drawing, while its last published esc_rpm keeps counting toward the rotor average.">
      <div class="drone-bar-head"><span>Pack current</span><span class="v" id="dnPcV">&ndash;</span></div>
      <div class="drone-bar" id="dnPcBar"><i></i></div>
    </div>
    <div class="drone-bar-row" title="contract home_dist - distance from where the craft ARMED. The bar's full scale is the 400 m geofence radius, and the fence COMMANDS an RTL rather than stopping you - so the number really can pass 400 and the bar simply pins.">
      <div class="drone-bar-head"><span>Home distance</span><span class="v" id="dnHdV">&ndash;</span></div>
      <div class="drone-bar" id="dnHdBar"><i></i></div>
    </div>

    <div class="drone-rule"></div>
    <div class="drone-reads">
      <div class="drone-read" title="contract altitude - height above sea level, measured off the world. Compare it with AGL and Baro: the three are MEANT to disagree."><span class="cap">Alt</span><span class="val" id="dnAlt">&ndash;</span></div>
      <div class="drone-read" title="contract agl - height above the ground directly below, off the downward rangefinder (roster node RANGE). Reads -1 with nothing in range."><span class="cap">AGL</span><span class="val" id="dnAgl">&ndash;</span></div>
      <div class="drone-read" title="contract baro_alt - pressure altitude on a fixed standard-day subscale, against a sea-level pressure that drifts. The static port also under-reads with the square of airspeed, so the gap between this and Alt MOVES in wind. Both errors are real instrument behaviour; never correct one height toward another."><span class="cap">Baro</span><span class="val" id="dnBaro">&ndash;</span></div>
      <div class="drone-read" title="contract vspeed - vertical rate, + = climbing. In every mode but STABILIZE this is what the climb stick commands."><span class="cap">V/S</span><span class="val" id="dnVs">&ndash;</span></div>
      <div class="drone-read" title="contract sats - satellites the GNSS node can see, out of sixteen sky rays. Fewer under trees, a shed or a bridge. Four is the 3D-fix line."><span class="cap">Sats</span><span class="val" id="dnSats">&ndash;</span></div>
      <div class="drone-read" title="contract hdop - horizontal dilution of precision. LOWER IS BETTER; it rises as the visible satellites bunch together, so a clear count with a bad geometry still reads badly."><span class="cap">HDOP</span><span class="val" id="dnHdop">&ndash;</span></div>
      <div class="drone-read" title="contract pitch - nose up/down in degrees. Over ten degrees is pre-arm bit ATTITUDE: park on a hill and arming is refused."><span class="cap">Pitch</span><span class="val" id="dnPitch">&ndash;</span></div>
      <div class="drone-read" title="contract roll - bank in degrees. Same ten-degree pre-arm limit as pitch. The quad has no roll STICK: it leans on pitch and turns on yaw."><span class="cap">Roll</span><span class="val" id="dnRoll">&ndash;</span></div>
      <div class="drone-read" title="contract rotor_rpm - the mean of the four PUBLISHED esc_rpm values. A dropped node holds its last reading and keeps counting toward this, which is what a listener reading four messages would compute."><span class="cap">Rotor</span><span class="val" id="dnRpm">&ndash;</span></div>
      <div class="drone-read" title="contract hardpoint_state - whether the latch is actually holding, against the Hook command you sent. Commanding HOLD over open ground leaves this open: there has to be a crate under the hook."><span class="cap">Hook</span><span class="val" id="dnHook">&ndash;</span></div>
      <div class="drone-read" title="contract payload_weight in NEWTONS, the unit the DroneCAN hardpoint message specifies. A carried crate is a real mass change - the hover collective is re-derived when the latch closes."><span class="cap">Payload</span><span class="val" id="dnPay">&ndash;</span></div>
      <div class="drone-read" title="contract gimbal_pitch_actual / gimbal_yaw_actual - where the camera mount IS. The mount slews at a finite rate, so it chases the commanded angles on the control panel rather than matching them."><span class="cap">Gimbal</span><span class="val" id="dnGmb">&ndash;</span></div>
    </div>

    <div class="drone-rule"></div>
    <div class="drone-sec-lbl" title="One row per motor, indexed by DroneCAN esc_index. contract esc_rpm / esc_current / esc_temp, each an instanced signal of four. A row turns red on its esc_fault bit, which is set by the controller running hot OR by its node leaving the bus."><span>ESCs</span><span class="v" id="dnEscFault"></span></div>
    <table class="drone-tbl">
      <thead><tr><th>#</th><th title="contract esc_rpm">rpm</th><th title="contract esc_current">A</th><th title="contract esc_temp - red past its 90 °C warn">&deg;C</th></tr></thead>
      <tbody id="dnEscBody"></tbody>
    </table>

    <div class="drone-rule"></div>
    <div class="drone-sec-lbl" title="The eight DroneCAN nodes, in the contract's node_health order. Colour is the node's own health (green OK, amber WARNING, red CRITICAL); a struck-through cell is one YOU took off the bus. Killing an ESC costs the mixer a motor and is not compensated for; killing GNSS or AHRS refuses arming."><span>Bus</span><span class="v">click = fail / restore</span></div>
    <div class="drone-nodes" id="dnNodes"></div>
   </div>
  </div>
  <div class="drone-resize" id="dnResize"></div>
`;

  // ── Control window DOM ──────────────────────────────────────────────────────
  const ctrlWin = document.createElement('div');
  ctrlWin.className = 'drone-window';
  ctrlWin.id = 'droneCtrlWindow';
  ctrlWin.style.left = '430px';
  ctrlWin.innerHTML = `
  <div class="drone-header" id="dncHeader" title="The sticks and switches that fly the drone. While this window is open it CLAIMS accel / brake / steer / key from the RAMN controls, and hands them straight back the moment you close it. The game's own ARM, MODE, HOOK and climb pads are hidden while sloppyCAN has the link - these replace them.">
    <span class="drone-dot ctrl"></span>
    <span class="drone-title">Drone control</span>
    <button class="drone-close" id="dncCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="drone-scaleouter" id="dncScaleOuter">
   <div class="drone-body" id="dncBody">
    <div class="drone-sec">
      <div class="drone-arm" id="dncArmBtn" title="contract arm (key T) - a LATCHED SWITCH, not a press, and a REQUEST rather than a state. The craft arms on this switch's RISING EDGE and only with every pre-arm check passing; it REFUSES a disarm while airborne, and disarms itself a few seconds after landing - after which the switch has to be CYCLED before it will arm again, exactly as on a real aircraft. What the aircraft did with it is the Arming chip on the dashboard.">ARM</div>
      <div class="drone-armnote" id="dncArmNote"></div>
    </div>

    <div class="drone-sec">
      <div class="drone-sec-lbl"><span title="contract climb (keys R / F) - the throttle axis. It means two different things and that IS the mode ladder: in STABILIZE it is a thrust TRIM around the hover collective, in every other mode a climb RATE. This slider LATCHES where you leave it, like a transmitter's throttle stick, so centre it before arming - a deflected climb axis is pre-arm bit STICK, and a craft that leaps on arming is what the check exists to prevent.">Climb (throttle)</span><span><button class="drone-mini" id="dncClimbCentre" title="Return the climb axis to zero. Pre-arm bit STICK refuses to arm until it is here.">Centre</button> <span class="v" id="dncClimbV">+0%</span></span></div>
      <input type="range" class="drone-range" id="dncClimb" min="-100" max="100" value="0" title="Latching throttle: -100 full descent, 0 hover trim, +100 full climb.">
    </div>
    <div class="drone-sec">
      <div class="drone-sec-lbl"><span title="Sent as the contract's accel / brake pair (keys W / S). On a quad the game reads its throttle axis as forward-and-back TILT, up to the airframe's 32-degree limit - so this is the stick that makes it fly somewhere rather than one that makes it go faster. Springs back to centre on release.">Pitch (nose fwd / back)</span><span class="v" id="dncPitchV">+0%</span></div>
      <input type="range" class="drone-range pitch" id="dncPitch" min="-100" max="100" value="0" title="+ leans the nose forward, - leans it back. Springs back to centre when you let go.">
    </div>
    <div class="drone-sec">
      <div class="drone-sec-lbl"><span title="Sent as the contract's steer (keys A / D) - yaw RATE, made by propeller drag alone, so it is the weakest axis on the aircraft and a quad on three motors cannot hold heading at all. Manual in EVERY mode, RTL included: no real flight controller takes the yaw stick away. There is no roll stick - the airframe leans on pitch and turns on this.">Yaw</span><span class="v" id="dncYawV">C 0%</span></div>
      <input type="range" class="drone-range yaw" id="dncYaw" min="-100" max="100" value="0" title="- yaws left, + yaws right. Springs back to centre when you let go.">
    </div>

    <div class="drone-sec">
      <div class="drone-sec-lbl"><span title="contract flight_mode (key Z) - the mode you are ASKING for. What the FC is actually in comes back as mode_actual on the dashboard, and the two disagreeing is the reading rather than a fault.">Flight mode (requested)</span></div>
      <div class="drone-seg" id="dncModeSeg"></div>
    </div>
    <div class="drone-sec">
      <div class="drone-sec-lbl"><span title="Sent as the contract's key, which is a CAR'S IGNITION BARREL (Lock / On / Ignition) shared by every vehicle. A quad has no barrel - it has a battery you plug in - and the game asks the signal exactly one question: is there a powered flight controller. So this is two positions, not three.">Flight pack</span><span class="v" id="dncPackV">connected</span></div>
      <div class="drone-toggle" id="dncPackBtn" title="Plug the flight pack in or pull it out. Unplugged cuts the aircraft instantly and unconditionally - it is not a check that can be refused, and the Arming chip reads DISARMED rather than BLOCKED, because an absent flight controller is not refusing anything.">Battery</div>
    </div>

    <div class="drone-sec drone-row2">
      <div class="drone-toggle" id="dncHookBtn" title="contract hardpoint_cmd (key 1) - HOLD the cargo latch. Sends a DroneCAN hardpoint.Command on each edge. The latch only closes with a crate under the hook, so hardpoint_state on the dashboard can disagree with this. Releasing needs no condition and no timer: the failure you must never have is a load you cannot drop.">Hook</div>
      <div class="drone-toggle" id="dncBeepBtn" title="contract beep - sends a DroneCAN BeepCommand on each edge. The airframe has no buzzer sample, so this lights a tell-tale and makes no sound.">Beep</div>
      <input type="color" class="drone-colour" id="dncLed" value="#000000" title="contract led - one colour for all four arm tips, sent as a DroneCAN LightsCommand when you commit the picker. The wire is RGB565, so the colour comes back a shade off: that is the LEDs' real resolution, not a rounding bug. Nothing in the game blinks a lamp - if you want a flash, toggle it from here.">
      <button class="drone-mini" id="dncLedOff" title="Command the arm-tip LEDs off (black).">LED off</button>
    </div>

    <div class="drone-sec">
      <div class="drone-sec-lbl"><span title="contract gimbal_pitch / gimbal_yaw in degrees - BRIDGE-ONLY, with no key in the game. Sends a DroneCAN camera_gimbal.AngularCommand and an actuator.ArrayCommand together, because which of the two a real mount answers to is a property of the mount. Both sliders' stops come off the contract's own ranges.">Gimbal</span><span><button class="drone-mini" id="dncGimbCentre" title="Command the mount back to looking straight ahead.">Centre</button> <span class="v" id="dncGimbV">+0&deg; / +0&deg;</span></span></div>
      <input type="range" class="drone-range gimbal" id="dncGimbP" min="-90" max="30" value="0" title="Gimbal pitch, + = up. The mount slews at a finite rate, so watch gimbal_pitch_actual on the dashboard chase this rather than match it.">
      <input type="range" class="drone-range gimbal" id="dncGimbY" min="-120" max="120" value="0" style="margin-top:4px" title="Gimbal yaw, + = right. Sent together with pitch: an orientation is both angles, so sending half of one is a lie about the other.">
    </div>

    <div class="drone-hint">
      <b>Keys</b> (panel open): <b>W</b>/<b>S</b> pitch &middot; <b>A</b>/<b>D</b> yaw &middot;
      <b>R</b>/<b>F</b> climb &middot; <b>T</b> arm &middot; <b>Z</b> next mode.<br>
      Pitch and yaw spring back; the climb stick does not, like a real transmitter &mdash; and the
      FC refuses to arm until it is centred.
    </div>
   </div>
  </div>
  <div class="drone-resize" id="dncResize"></div>
`;

  // ── Telemetry hook (pushed by carlito.js) ───────────────────────────────────
  // Open the pair the first time a drone appears, close it when the drone goes away - a vehicle
  // change, or the Carlito window closing, which arrives here as null. Only the AUTOMATIC open
  // is undone: someone who closed the window is not re-opened on the next frame, and someone who
  // opened it by hand is not closed out from under them.
  window.vehiclePanelSubscribe(function (t) {
    tel = t;
    const live = isDroneTelemetry(t);
    if (live !== droneLive) {
      droneLive = live;
      if (live && !dashOpen() && !ctrlOpen()) { autoOpened = true; setPairOpen(true); }
      else if (!live && autoOpened) { autoOpened = false; setPairOpen(false); }
    }
    markDirty();
  });

  // ── Window open / close ─────────────────────────────────────────────────────
  function setDashOpen(open) {
    dashWin.classList.toggle('open', open);
    if (open) { dashScale(dashWin.offsetWidth || BASE_W); markDirty(); }
    afterOpenChange();
  }
  function setCtrlOpen(open) {
    ctrlWin.classList.toggle('open', open);
    if (open) { syncCtrlUI(); ctrlScale(ctrlWin.offsetWidth || BASE_W); }
    // A stick nobody can reach is centred. THE ARM SWITCH IS NOT TOUCHED - it is a latch, and
    // closing a window is not a pilot lowering it, so an aircraft in the air stays armed.
    else { releaseSticks(); }
    afterOpenChange();
  }
  function setPairOpen(open) { setDashOpen(open); setCtrlOpen(open); }
  function afterOpenChange() { syncBtn(); handoffRamn(); }
  function syncBtn() {
    const b = document.getElementById('droneBtn');
    if (b) b.classList.toggle('active', dashOpen() || ctrlOpen());
  }

  // ── The RAMN pair steps aside ───────────────────────────────────────────────
  // `takes` 'pair': while this panel is flying it has taken accel/brake/steer off the RAMN
  // controls, so leaving them up is two control surfaces for one aircraft. A road vehicle's
  // panel takes 'dash' instead. What was up before is remembered in vehicle-panel.js.
  function handoffRamn() {
    if (window.vehiclePanelClaim) window.vehiclePanelClaim('drone', dashOpen() || ctrlOpen(), 'pair');
  }

  // Paired toolbar toggle, ramnToggle's shape: opens both, or closes both once everything is
  // open. The window close buttons and Esc still close one at a time.
  function droneToggle() {
    const allOpen = dashOpen() && ctrlOpen();
    autoOpened = false;             // touched by hand: the telemetry hook stops closing it
    setPairOpen(!allOpen);
  }
  function droneIsOpen() { return dashOpen() || ctrlOpen(); }
  function droneCtrlToggle() { setCtrlOpen(!ctrlOpen()); }

  // Asking the game for a drone is NOT here: switchViewTab('dronecan') calls
  // vehiclePanelRequestForProto('dronecan'), the entry every protocol view shares.

  // ── Render ──────────────────────────────────────────────────────────────────
  function markDirty() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (dashOpen()) renderDash();
      // The arm note reads the LIVE arming state, so it has to follow the telemetry. The rest of
      // the control UI is written on events only - a render tick that reassigned a range input's
      // .value would fight the pointer dragging it - EXCEPT when dcCtl changed behind our back,
      // which is what happens when the DroneCAN tab's own widgets are used. One owner is only
      // one owner if both windows show what it says, so an outside edit forces a full sync.
      if (ctrlOpen()) { if (ctlChangedElsewhere()) syncCtrlUI(); else syncArmNote(); }
    });
  }

  function setChip(chip, valNode, text, colour) {
    valNode.textContent = text;
    chip.className = 'drone-chip' + (colour ? ' ' + colour : '');
  }
  function setBar(bar, vNode, v, name, text) {
    const r = rangeOf(name);
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, (v - r[0]) / ((r[1] - r[0]) || 1) * 100)) : 0;
    bar.firstElementChild.style.width = pct.toFixed(1) + '%';
    bar.classList.toggle('warn', isWarn(name, v));
    vNode.textContent = text;
  }

  const BARS = ['soc', 'pack_temp', 'pack_current', 'home_dist'];
  const READS = ['alt', 'agl', 'baro', 'vs', 'sats', 'hdop', 'pitch', 'roll', 'rpm', 'hook', 'pay', 'gmb'];

  // The refusal block is the one thing in this window that changes its HEIGHT, and makeFloating
  // fixes the scale wrapper's height in pixels when the window opens - so showing or hiding it
  // has to re-apply the scale, or the window keeps the taller layout's dead space underneath.
  let whyShown = false;
  function setWhy(html) {
    const show = html !== null;
    if (show) el.why.innerHTML = html;
    el.why.classList.toggle('hidden', !show);
    if (show === whyShown) return;
    whyShown = show;
    dashScale(dashWin.offsetWidth || BASE_W);
  }

  function renderDash() {
    const t = (droneLive && tel) ? tel : null;
    if (!t) {
      for (const [chip, val] of [[el.chipArm, el.arm], [el.chipMode, el.mode],
                                 [el.chipFs, el.fs], [el.chipFix, el.fix]]) setChip(chip, val, '–', '');
      setWhy(null);
      for (const name of BARS) setBar(el.bar[name], el.barV[name], NaN, name, '–');
      for (const k of READS) el[k].textContent = '–';
      el.escFault.textContent = '';
      renderEscs(null);
      renderNodes(null);
      return;
    }

    // Arming. The SWITCH and the AIRCRAFT are two different things and the panel shows both -
    // the contract's own point about arm against armed. A refusal names the check that made it,
    // and only while BLOCKED: prearm_fail publishes 0 in flight by design, so reading it at any
    // other time says "no check failed" about checks nobody is running.
    const state = num(t.arming_state);
    setChip(el.chipArm, el.arm, enumLabel('arming_state', 'out', state),
      state === 2 ? 'green' : state === 1 ? 'red' : '');
    if (state === 1) {
      const names = window.dronecanPrearmNames ? window.dronecanPrearmNames(num(t.prearm_fail) | 0) : [];
      setWhy('<b>Refused:</b> ' + (names.length ? names.map(esc).join(' &middot; ') : 'no check named'));
    } else {
      setWhy(null);
    }

    const mode = num(t.mode_actual);
    setChip(el.chipMode, el.mode, enumLabel('mode_actual', 'out', mode), mode >= 3 ? 'amber' : 'blue');
    const fs = num(t.failsafe);
    setChip(el.chipFs, el.fs, enumLabel('failsafe', 'out', fs), fs > 0 ? 'red' : '');
    const fix = num(t.fix_type);
    setChip(el.chipFix, el.fix, enumLabel('fix_type', 'out', fix), fix >= 3 ? 'green' : 'amber');

    const soc = num(t.soc), pt = num(t.pack_temp), pc = num(t.pack_current), hd = num(t.home_dist);
    setBar(el.bar.soc, el.barV.soc, soc, 'soc', fmt(soc, 0, ' %'));
    setBar(el.bar.pack_temp, el.barV.pack_temp, pt, 'pack_temp', fmt(pt, 1, ' °C'));
    setBar(el.bar.pack_current, el.barV.pack_current, pc, 'pack_current', fmt(pc, 1, ' A'));
    // home_dist's range top IS the geofence radius, and the fence is REFUSABLE - so the number
    // really can pass 400 and the bar simply pins. A scale, not a clamp.
    setBar(el.bar.home_dist, el.barV.home_dist, hd, 'home_dist', fmt(hd, 0, ' m'));

    // The three heights are meant to DISAGREE (a fixed standard-day subscale against a drifting
    // sea level, and a static port that under-reads with airspeed). Never reconcile them.
    el.alt.textContent = fmt(num(t.altitude), 1, ' m');
    el.agl.textContent = fmt(num(t.agl), 1, ' m');
    el.baro.textContent = fmt(num(t.baro_alt), 1, ' m');
    el.vs.textContent = fmt(num(t.vspeed), 1, ' m/s');
    el.sats.textContent = whole(num(t.sats));
    el.hdop.textContent = fmt(num(t.hdop), 1, '');
    el.pitch.textContent = fmt(num(t.pitch), 0, '°');
    el.roll.textContent = fmt(num(t.roll), 0, '°');
    el.rpm.textContent = whole(num(t.rotor_rpm));
    // hardpoint_state is the LATCH, and it disagreeing with the hook command is the reading:
    // closing over open ground holds nothing.
    el.hook.textContent = t.hardpoint_state ? 'HOLD' : 'open';
    el.pay.textContent = fmt(num(t.payload_weight), 1, ' N');
    el.gmb.textContent = fmt(num(t.gimbal_pitch_actual), 0, '°') + ' / ' + fmt(num(t.gimbal_yaw_actual), 0, '°');

    renderEscs(t);
    renderNodes(t);
  }

  function renderEscs(t) {
    // esc_fault's bits are ESC_INDEX, not roster indices - the two agree only because the ESCs
    // sit first in the roster, and they stop agreeing the day a fifth motor appears.
    const fault = t ? (num(t.esc_fault) | 0) : 0;
    el.escFault.textContent = fault ? ('fault 0x' + fault.toString(16).toUpperCase()) : '';
    for (let i = 0; i < el.escRows.length; i++) {
      const row = el.escRows[i];
      row.classList.toggle('fault', !!((fault >> i) & 1));
      row.cells[1].textContent = t ? whole(inst(t.esc_rpm, i)) : '–';
      row.cells[2].textContent = t ? fmt(inst(t.esc_current, i), 1, '') : '–';
      row.cells[3].textContent = t ? fmt(inst(t.esc_temp, i), 0, '') : '–';
    }
  }

  function renderNodes(t) {
    // node_online is the BUS's judgement of a node (it stopped publishing) and node_health is the
    // node's judgement of itself - deliberately two signals, never folded into one.
    const online = t ? (num(t.node_online) | 0) : 0;
    const failMask = ctl().failMask;
    for (let i = 0; i < el.nodeCells.length; i++) {
      const cell = el.nodeCells[i];
      cell.classList.remove('ok', 'warn', 'crit');
      if (t) {
        const health = inst(t.node_health, i);
        if (!((online >> i) & 1) || health >= 2) cell.classList.add('crit');
        else if (health >= 1) cell.classList.add('warn');
        else cell.classList.add('ok');
      }
      // Our own injected failure is worth showing with or without telemetry - it is a switch we
      // set, and it survives a respawn exactly as the game's Y key does.
      cell.classList.toggle('cut', !!((failMask >> i) & 1));
    }
  }

  // ── Control UI ──────────────────────────────────────────────────────────────
  // Written on EVENTS, not on the render tick - see markDirty.
  let lastCtlSig = '';
  const ctlSig = (c) => [c.mode, c.led, c.beep, c.hook, c.gimbalPitch, c.gimbalYaw, c.arm, c.climb, c.failMask].join('|');
  function ctlChangedElsewhere() { return ctlSig(ctl()) !== lastCtlSig; }

  function syncCtrlUI() {
    if (!el.armBtn) return;
    const c = ctl();
    lastCtlSig = ctlSig(c);
    // Adopt a climb the DroneCAN tab (or anything else) set, so the slider is not a second
    // opinion. A key HELD wins - it is the more recent instruction and it is still being given.
    if (climbKey === 0 && c.climb !== climbSlider) climbSlider = c.climb;
    el.climb.value = String(climbSlider);
    el.climbV.textContent = signed(climbNow()) + '%';
    el.pitchV.textContent = signed(stick.pitch) + '%';
    el.yawV.textContent = (Math.abs(stick.yaw) < 2 ? 'C' : (stick.yaw < 0 ? 'L' : 'R')) +
      ' ' + Math.round(Math.abs(stick.yaw)) + '%';
    el.modeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.val === c.mode));
    const powered = ctrlKey === KEY_POWERED;
    el.packBtn.classList.toggle('on', powered);
    el.packV.textContent = powered ? 'connected' : 'unplugged';
    el.hookBtn.classList.toggle('on', !!c.hook);
    el.beepBtn.classList.toggle('on', !!c.beep);
    if (window.dronecanHexFromRgb565) el.led.value = window.dronecanHexFromRgb565(c.led);
    el.gimbP.value = String(c.gimbalPitch);
    el.gimbY.value = String(c.gimbalYaw);
    el.gimbV.textContent = signed(c.gimbalPitch) + '° / ' + signed(c.gimbalYaw) + '°';
    syncArmNote();
  }

  // The one place arm-against-armed is explained, because it is the one place it is confusing:
  // the aircraft auto-disarms a few seconds after landing with the switch still up and will not
  // arm again until the switch is CYCLED, since arming is an edge.
  function syncArmNote() {
    if (!el.armBtn) return;
    const armUp = ctl().arm;
    el.armBtn.textContent = armUp ? 'ARM SWITCH UP' : 'ARM';
    el.armBtn.classList.toggle('up', armUp);
    const state = (droneLive && tel) ? num(tel.arming_state) : NaN;
    let note, warn = false;
    if (!droneLive) note = 'No drone on the link.';
    else if (state === 2) note = 'Armed. A disarm is refused while airborne — land first.';
    else if (state === 1) note = 'Refused — the dashboard names the check that said no.';
    else if (armUp) { note = 'Switch up, aircraft disarmed: cycle the switch to arm again.'; warn = true; }
    else if (climbNow() !== 0) { note = 'Centre the climb stick — the FC refuses to arm on a deflected stick.'; warn = true; }
    else if (ctrlKey !== KEY_POWERED) { note = 'The flight pack is unplugged, so there is no flight controller to arm.'; warn = true; }
    else note = 'Ready.';
    el.armNote.textContent = note;
    el.armNote.classList.toggle('warn', warn);
  }

  // dcCtl is written on EDGES only, never per frame: dronecanSetCtl schedules a workspace save
  // and can push the DroneCAN tab's widgets, neither of which belongs on a 60 Hz path.
  function pushClimb() {
    const v = climbNow();
    if (v !== ctl().climb) setCtl({ climb: v });
    else syncCtrlUI();
  }
  function releaseSticks() {
    climbSlider = climbKey = pitchSlider = pitchKey = yawSlider = yawKey = 0;
    stick.pitch = 0; stick.yaw = 0;
    pushClimb();
  }
  function applyKeyAxis(axis, v) {
    if (axis === 'pitch') { pitchKey = v; stick.pitch = pitchKey || pitchSlider; syncCtrlUI(); }
    else if (axis === 'yaw') { yawKey = v; stick.yaw = yawKey || yawSlider; syncCtrlUI(); }
    else { climbKey = v; pushClimb(); }
  }
  function nextMode(m) {
    const keys = enumKeys('flight_mode', 'in');
    if (!keys.length) return 0;
    const i = keys.indexOf(Math.round(Number(m)) || 0);
    return keys[(i + 1 + keys.length) % keys.length];
  }
  // A range input that returns to centre when the pointer or the key lets go of it.
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
    document.body.appendChild(dashWin);
    document.body.appendChild(ctrlWin);

    // Mode positions and labels come off the CONTRACT's enum table, never retyped - the rule the
    // DroneCAN tab's own selector follows. The help text is keyed by LABEL rather than by index,
    // so a mode the contract grows simply arrives without a tooltip instead of inheriting the
    // wrong one.
    const modeSeg = ctrlWin.querySelector('#dncModeSeg');
    modeSeg.innerHTML = enumKeys('flight_mode', 'in').map(k => {
      const label = enumLabel('flight_mode', 'in', k);
      const help = MODE_HELP[label];
      return `<button data-val="${k}"${help ? ` title="${esc(help)}"` : ''}>${esc(label)}</button>`;
    }).join('');

    // Bus cells: the roster is dronecan.js's, copied out rather than retyped - a node id has one
    // home, and this is node_health's bit order.
    const nodes = dashWin.querySelector('#dnNodes');
    nodes.innerHTML = ROSTER.map((r, i) =>
      `<div class="drone-node" data-idx="${i}" title="${esc(NODE_HELP(r, i))}">${esc(r.name)}</div>`).join('');

    const escBody = dashWin.querySelector('#dnEscBody');
    escBody.innerHTML = [0, 1, 2, 3].map(i => `<tr><td>${i}</td><td>–</td><td>–</td><td>–</td></tr>`).join('');

    const q = (w, id) => w.querySelector('#' + id);
    el = {
      chipArm: q(dashWin, 'dnChipArm'), arm: q(dashWin, 'dnArm'),
      chipMode: q(dashWin, 'dnChipMode'), mode: q(dashWin, 'dnMode'),
      chipFs: q(dashWin, 'dnChipFs'), fs: q(dashWin, 'dnFs'),
      chipFix: q(dashWin, 'dnChipFix'), fix: q(dashWin, 'dnFix'),
      why: q(dashWin, 'dnWhy'),
      bar: {
        soc: q(dashWin, 'dnSocBar'), pack_temp: q(dashWin, 'dnPtBar'),
        pack_current: q(dashWin, 'dnPcBar'), home_dist: q(dashWin, 'dnHdBar'),
      },
      barV: {
        soc: q(dashWin, 'dnSocV'), pack_temp: q(dashWin, 'dnPtV'),
        pack_current: q(dashWin, 'dnPcV'), home_dist: q(dashWin, 'dnHdV'),
      },
      alt: q(dashWin, 'dnAlt'), agl: q(dashWin, 'dnAgl'), baro: q(dashWin, 'dnBaro'),
      vs: q(dashWin, 'dnVs'), sats: q(dashWin, 'dnSats'), hdop: q(dashWin, 'dnHdop'),
      pitch: q(dashWin, 'dnPitch'), roll: q(dashWin, 'dnRoll'), rpm: q(dashWin, 'dnRpm'),
      hook: q(dashWin, 'dnHook'), pay: q(dashWin, 'dnPay'), gmb: q(dashWin, 'dnGmb'),
      escFault: q(dashWin, 'dnEscFault'),
      escRows: [...escBody.querySelectorAll('tr')],
      nodeCells: [...nodes.querySelectorAll('.drone-node')],

      armBtn: q(ctrlWin, 'dncArmBtn'), armNote: q(ctrlWin, 'dncArmNote'),
      climb: q(ctrlWin, 'dncClimb'), climbV: q(ctrlWin, 'dncClimbV'),
      pitchStick: q(ctrlWin, 'dncPitch'), pitchV: q(ctrlWin, 'dncPitchV'),
      yawStick: q(ctrlWin, 'dncYaw'), yawV: q(ctrlWin, 'dncYawV'),
      modeSeg: modeSeg, packBtn: q(ctrlWin, 'dncPackBtn'), packV: q(ctrlWin, 'dncPackV'),
      hookBtn: q(ctrlWin, 'dncHookBtn'), beepBtn: q(ctrlWin, 'dncBeepBtn'), led: q(ctrlWin, 'dncLed'),
      gimbP: q(ctrlWin, 'dncGimbP'), gimbY: q(ctrlWin, 'dncGimbY'), gimbV: q(ctrlWin, 'dncGimbV'),
    };

    // Gimbal slider bounds come off the CONTRACT's own ranges rather than the markup's - the rule
    // dronecanOnShow follows, so a contract that moves a stop moves the slider with it.
    for (const [node, name] of [[el.gimbP, 'gimbal_pitch'], [el.gimbY, 'gimbal_yaw']]) {
      const s = sigDef(name, 'in');
      if (s && Array.isArray(s.range) && s.range.length === 2) { node.min = String(s.range[0]); node.max = String(s.range[1]); }
    }

    q(dashWin, 'dnCloseBtn').addEventListener('click', () => { autoOpened = false; setDashOpen(false); });
    q(ctrlWin, 'dncCloseBtn').addEventListener('click', () => { autoOpened = false; setCtrlOpen(false); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled) return;   // shared flag: another window may already have claimed this press
      if (ctrlOpen()) { e._scEscHandled = true; autoOpened = false; setCtrlOpen(false); }
      else if (dashOpen()) { e._scEscHandled = true; autoOpened = false; setDashOpen(false); }
    });

    const floating = window.makeFloating;
    if (floating) {
      dashScale = floating({
        win: dashWin, header: q(dashWin, 'dnHeader'), grip: q(dashWin, 'dnResize'),
        outer: q(dashWin, 'dnScaleOuter'), body: q(dashWin, 'dnBody'),
        baseW: BASE_W, closeSel: '.drone-close',
      });
      ctrlScale = floating({
        win: ctrlWin, header: q(ctrlWin, 'dncHeader'), grip: q(ctrlWin, 'dncResize'),
        outer: q(ctrlWin, 'dncScaleOuter'), body: q(ctrlWin, 'dncBody'),
        baseW: BASE_W, closeSel: '.drone-close',
      });
    } else {
      console.warn('Drone panel: makeFloating is missing - load ramn.js before drone.js. The ' +
        'windows still open, but cannot be dragged or resized.');
    }

    // ── Sticks ──
    // Pitch and yaw SPRING BACK on release and the climb stick does not, which is what a
    // transmitter does: throttle holds where you leave it, the attitude sticks return to centre.
    el.climb.addEventListener('input', () => { climbSlider = +el.climb.value; pushClimb(); });
    q(ctrlWin, 'dncClimbCentre').addEventListener('click', () => { climbSlider = 0; pushClimb(); });
    bindSpring(el.pitchStick, v => { pitchSlider = v; stick.pitch = pitchKey || pitchSlider; syncCtrlUI(); });
    bindSpring(el.yawStick, v => { yawSlider = v; stick.yaw = yawKey || yawSlider; syncCtrlUI(); });

    // ── Switches (all of them through dcCtl) ──
    el.armBtn.addEventListener('click', () => setCtl({ arm: !ctl().arm }));
    el.modeSeg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) setCtl({ mode: +b.dataset.val }); });
    el.packBtn.addEventListener('click', () => {
      ctrlKey = ctrlKey === KEY_POWERED ? KEY_UNPOWERED : KEY_POWERED;
      syncCtrlUI();
    });
    el.hookBtn.addEventListener('click', () => setCtl({ hook: !ctl().hook }));
    el.beepBtn.addEventListener('click', () => setCtl({ beep: !ctl().beep }));
    // 'change', not 'input' - the DroneCAN tab's own picker uses onchange for the same reason:
    // a colour input fires continuously while the OS picker is being dragged, and every distinct
    // value would latch another LightsCommand. The commit is the command.
    el.led.addEventListener('change', () =>
      setCtl({ led: window.dronecanRgb565FromHex ? window.dronecanRgb565FromHex(el.led.value) : 0 }));
    q(ctrlWin, 'dncLedOff').addEventListener('click', () => setCtl({ led: 0 }));
    const pushGimbal = () => setCtl({ gimbalPitch: +el.gimbP.value, gimbalYaw: +el.gimbY.value });
    el.gimbP.addEventListener('input', pushGimbal);
    el.gimbY.addEventListener('input', pushGimbal);
    q(ctrlWin, 'dncGimbCentre').addEventListener('click', () => { el.gimbP.value = '0'; el.gimbY.value = '0'; pushGimbal(); });

    nodes.addEventListener('click', e => {
      const cell = e.target.closest('.drone-node');
      if (cell && window.dronecanToggleNodeFail) { window.dronecanToggleNodeFail(+cell.dataset.idx); markDirty(); }
    });

    // ── Keyboard flying (control panel open, not typing in a field) ──
    const isField = t => t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const AXES = {
      w: ['pitch', 100], arrowup: ['pitch', 100],
      s: ['pitch', -100], arrowdown: ['pitch', -100],
      a: ['yaw', -100], arrowleft: ['yaw', -100],
      d: ['yaw', 100], arrowright: ['yaw', 100],
      r: ['climb', 100], f: ['climb', -100],
    };
    document.addEventListener('keydown', e => {
      if (!ctrlOpen() || isField(e.target) || e.repeat) return;
      const k = e.key.toLowerCase();
      // T and Z are the GAME's own arm / flight-mode keys, kept the same here so one pair of
      // fingers works whether the bridge has the aircraft or not.
      if (k === 't') { e.preventDefault(); setCtl({ arm: !ctl().arm }); return; }
      if (k === 'z') { e.preventDefault(); setCtl({ mode: nextMode(ctl().mode) }); return; }
      const m = AXES[k];
      if (!m) return;
      e.preventDefault();
      applyKeyAxis(m[0], m[1]);
    });
    document.addEventListener('keyup', e => {
      if (!ctrlOpen()) return;
      const m = AXES[e.key.toLowerCase()];
      if (m) applyKeyAxis(m[0], 0);
    });
    // A missed keyup (alt-tab, a context menu) would otherwise leave a stick hard over on an
    // aircraft nobody is watching. The same guard ramn.js puts on its joystick byte. The climb
    // SLIDER survives, because it is where the pilot left it rather than a key still down.
    window.addEventListener('blur', () => {
      if (!pitchKey && !yawKey && !climbKey) return;
      pitchKey = yawKey = 0;
      stick.pitch = pitchSlider; stick.yaw = yawSlider;
      applyKeyAxis('climb', 0);
    });

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: 'drone', family: 'drone', variant: 'drone', label: 'drone', verb: 'Fly',
        // The toolbar button is vehicle-panel.js's to show and hide: it is up only while a drone
        // is on the link, or while the windows it closes are open.
        btn: 'droneBtn', isOpen: droneIsOpen,
        close: () => { autoOpened = false; setPairOpen(false); },
      });
    }

    syncCtrlUI();
    syncBtn();
  })();

  // ── Expose hooks ────────────────────────────────────────────────────────────
  window.droneToggle = droneToggle;
  window.droneIsOpen = droneIsOpen;
  window.droneCtrlToggle = droneCtrlToggle;
})();
