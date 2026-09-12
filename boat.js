// ── Boat dashboard ─────────────────────────────────────────────────────────
// One floating window, following the Carlito link through vehicle-panel.js. Takes 'dash':
// a boat is driven with the RAMN controls, so it replaces the cluster and the Control Panel
// keeps driving. Claims no uplink signal.
//
// TELEMETRY ONLY. Every reading here is the game's own publish - nothing is read from
// window.ramnGetState(), which carries what sloppyCAN COMMANDS rather than what the boat
// measures. The RAMN Control Panel stays up beside this window and already shows the command
// half of every pair, so a second echo here would be the wrong half twice.
//
// THE INSTRUMENTS ARE THE MARINE ONES, and each is a pair whose GAP is the reading: apparent
// wind against the boom (the angle of attack a trimmer works from), COG against HDG (the crab
// angle the tide sets), STW against SOG (the tide's own contribution), heading_target against
// heading (the autopilot's error). Two numbers in two boxes teach none of those.
//
// `sheet` is a contract dir:"in" signal with no telemetry echo and no source on this side, so
// the commanded trim is not here: the angle of attack below is derived from `awa` and
// `sail_angle` alone, which the contract states is exact (aoa = awa - sail_angle). An autopilot
// control head owning `sheet` / `rudder` / `nav_mode` / `heading_cmd` is where the commanded
// halves belong.
//
// Integration: index.html (script after vehicle-panel.js; #boatBtn ships style="display:none",
// vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list). Live-only.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.boat-window {
  position:fixed; z-index:900; top:72px; left:90px; width:320px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.boat-window.open { display:flex; }
.boat-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.boat-header .boat-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; }
.boat-header .boat-title { flex:1; }
.boat-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.boat-close:hover { background:var(--bg); color:var(--text); }
.boat-scaleouter { overflow:hidden; }
.boat-body { width:320px; transform-origin:top left; padding:12px 14px 16px; box-sizing:border-box; }

.boat-rule { height:1px; background:var(--border); margin:9px 0 8px; }
.boat-sec-lbl {
  display:flex; justify-content:space-between; align-items:baseline;
  font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:6px;
}
.boat-sec-lbl .v { font-family:var(--mono); font-size:9px; letter-spacing:0; color:var(--text2); text-transform:none; }
.boat-sec-lbl .v.on { color:var(--amber); }

/* Chips: what the autopilot is doing, and the course it is steering */
.boat-chips { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.boat-chip {
  display:flex; flex-direction:column; gap:2px; padding:5px 8px;
  background:var(--bg); border:1px solid var(--border); border-radius:8px;
}
.boat-chip .cap { font-size:8px; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); }
.boat-chip .val { font-family:var(--mono); font-size:13px; color:var(--text); }
.boat-chip.on { border-color:var(--amber); background:var(--amber-dim); }
.boat-chip.on .val { color:var(--amber); }

/* Dials. A dial sits BESIDE its own readouts rather than over them - stacked, the two
   instruments alone ran the window past the height of a screen. */
.boat-instr { display:grid; grid-template-columns:134px 1fr; gap:9px; align-items:center; }
.boat-instr .boat-reads { grid-template-columns:1fr 1fr; }
.boat-dial { display:block; width:100%; height:auto; }
.boat-dial .rim  { fill:none; stroke:var(--border2); stroke-width:1.2; }
.boat-dial .tick { stroke:var(--border2); stroke-width:1; }
.boat-dial .card { fill:var(--text3); font-family:var(--sans); font-size:7px; text-anchor:middle; }
.boat-dial .bow  { fill:var(--text2); }
.boat-dial .hub  { fill:var(--bg); stroke:var(--border2); stroke-width:1; }
.boat-dial .ctrv { font-family:var(--mono); text-anchor:middle; fill:var(--text); }
.boat-dial .ctrc { font-family:var(--sans); text-anchor:middle; fill:var(--text3); font-size:6px; letter-spacing:.1em; }
.boat-nd-awa  { stroke-width:3; stroke-linecap:round; }
.boat-nd-twd  { stroke:var(--text2); stroke-width:1.2; stroke-linecap:round; stroke-dasharray:3 2.5; }
.boat-nd-boom { stroke:var(--amber); stroke-width:4; stroke-linecap:round; }
.boat-nd-hdg  { stroke:var(--text); stroke-width:2.6; stroke-linecap:round; }
.boat-nd-cog  { stroke:var(--cyan); stroke-width:2; stroke-linecap:round; stroke-dasharray:4 3; }
.boat-bug     { fill:var(--amber); }
.boat-bug.off { fill:var(--text3); }
.boat-setmark { fill:var(--blue); }
.boat-hidden  { display:none; }

/* Readout grid */
.boat-reads { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.boat-read {
  display:flex; flex-direction:column; gap:1px; padding:4px 6px;
  background:var(--bg); border:1px solid var(--border); border-radius:7px;
}
.boat-read .cap { font-size:8px; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); }
.boat-read .val { font-family:var(--mono); font-size:12px; color:var(--text); }
.boat-read .val.port { color:var(--red); }
.boat-read .val.stbd { color:var(--green); }
.boat-read .val.warn { color:var(--amber); }

/* Depth: the number over its own trace */
.boat-depth { position:relative; }
.boat-depth svg { display:block; width:100%; height:auto; }
.boat-trace-bg   { fill:var(--bg); stroke:var(--border); stroke-width:1; }
.boat-trace-warn { stroke:var(--red); stroke-width:.8; stroke-dasharray:3 3; opacity:.55; }
.boat-trace      { fill:none; stroke:var(--cyan); stroke-width:1.6; stroke-linejoin:round; }
.boat-trace.warn { stroke:var(--red); }
.boat-bed        { fill:var(--cyan); opacity:.28; stroke:none; }
.boat-bed.warn   { fill:var(--red); opacity:.32; }
.boat-depth-v {
  position:absolute; left:9px; top:3px; font-family:var(--mono); font-size:24px; line-height:1.1;
  color:var(--cyan); text-shadow:0 0 6px var(--bg2), 0 0 6px var(--bg2), 0 0 6px var(--bg2);
}
.boat-depth-v.warn { color:var(--red); }
.boat-depth-u {
  position:absolute; left:9px; bottom:4px; font-size:8px; text-transform:uppercase;
  letter-spacing:.12em; color:var(--text3);
}

/* Bars */
.boat-bar-row { margin-bottom:7px; }
/* A row of bars that belong to one instrument set, side by side rather than stacked */
.boat-bars { display:grid; gap:7px; }
.boat-bars.n2 { grid-template-columns:1fr 1fr; }
.boat-bars.n3 { grid-template-columns:repeat(3,1fr); }
.boat-bars .boat-bar-row { margin-bottom:0; }
.boat-bar-head { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:3px; }
.boat-bar-head .v { font-family:var(--mono); font-size:10px; color:var(--text); letter-spacing:0; }
.boat-bar-head .v.warn { color:var(--red); }
.boat-bar { height:8px; background:var(--bg); border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.boat-bar > i { display:block; height:100%; width:0%; border-radius:4px; background:var(--cyan); transition:width .12s linear; }
.boat-bar.warn > i { background:var(--red); }
/* Centre-origin bar, for a control that swings either side of neutral */
.boat-ctr { position:relative; height:8px; background:var(--bg); border:1px solid var(--border); border-radius:5px; }
.boat-ctr::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--border2); }
.boat-ctr > i { position:absolute; top:0; bottom:0; left:50%; width:0%; background:var(--blue); border-radius:3px; transition:all .12s linear; }

/* Tell-tales: text and colour only - the page font carries no icon glyphs */
.boat-tells { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
.boat-tell {
  text-align:center; padding:5px 2px; border-radius:7px; background:var(--bg);
  border:1px solid var(--border); color:var(--text3);
  font-size:9px; text-transform:uppercase; letter-spacing:.06em;
  transition:color .1s, background .1s, border-color .1s;
}
.boat-tell.on.green { color:var(--green); background:var(--green-dim); border-color:var(--green); }
.boat-tell.on.blue  { color:var(--blue);  background:var(--blue-dim);  border-color:var(--blue); }
.boat-tell.on.amber { color:var(--amber); background:var(--amber-dim); border-color:var(--amber); }
.boat-tell.on.red   { color:var(--red);   background:var(--red-dim);   border-color:var(--red); }

.boat-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(style);

  // ── Contract readers ────────────────────────────────────────────────────────
  // Ranges, warn thresholds and enum labels are the CONTRACT's and are never retyped here: a bar
  // that turns red at its own signal's `warn` is the same number the game's cluster uses, and a
  // mode label read off the table cannot drift from the mode the game resolved. Kept local rather
  // than shared - vehicle-panel.js owns the panel MECHANISM, not a utility surface, and drone.js
  // holds its own copy of the same handful for the same reason.
  const CONTRACT = window.CARLITO_CONTRACT || { signals: [] };
  const SIGS = CONTRACT.signals || [];
  const sigDef = (name, dir) => SIGS.find(s => s.name === name && s.dir === dir);
  function rangeOf(name) {
    const s = sigDef(name, 'out');
    return (s && Array.isArray(s.range) && s.range.length === 2) ? s.range : [0, 1];
  }
  // The caller passes the value the threshold is ABOUT: `roll` and `pitch` warn either way and
  // their ranges are symmetric about zero, so those two are handed a magnitude.
  function isWarn(name, v) {
    const s = sigDef(name, 'out');
    if (!s || !Number.isFinite(Number(s.warn)) || !Number.isFinite(v)) return false;
    return s.warn_side === 'low' ? v <= s.warn : v >= s.warn;
  }
  function enumLabel(name, v) {
    const tbl = (sigDef(name, 'out') || {}).enum;
    return (tbl && tbl[v] !== undefined) ? String(tbl[v]) : '–';
  }

  // ── Small helpers ───────────────────────────────────────────────────────────
  // An INSTANCED contract signal (count > 1) arrives as an ARRAY, so `+t.sig || 0` - which
  // Number()s an array into NaN and falls through to a plausible 0 - is exactly the wrong shape.
  const inst = (v, i) => { const n = Number(Array.isArray(v) ? v[i] : undefined); return Number.isFinite(n) ? n : NaN; };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  const fmt = (v, d, unit) => Number.isFinite(v) ? (v.toFixed(d) + (unit || '')) : '–';
  const whole = (v, unit) => Number.isFinite(v) ? (Math.round(v) + (unit || '')) : '–';
  const wrap180 = (d) => ((d % 360) + 540) % 360 - 180;
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  // A whole-degree bearing. It rounds BEFORE the final wrap on purpose: wrapping first leaves
  // 359.6 to round up to 360, and no compass has a 360 on it.
  const bearing = (v, unit) => Number.isFinite(v)
    ? ((Math.round(wrap360(v)) % 360) + (unit === undefined ? '°' : unit)) : '–';
  // A signed athwartships angle read as a magnitude and a side, which is how a helm says it.
  const sided = (v, unit) => Number.isFinite(v)
    ? (Math.round(Math.abs(v)) + (unit || '') + (Math.abs(v) < 0.5 ? '' : (v < 0 ? ' P' : ' S')))
    : '–';

  const BASE_W = 320;
  const PANEL_ID = 'boat';
  const FAMILY = 'boat';
  const VARIANT = 'boat-speed-a';   // VehicleCatalog.VARIANTS id, not the family
  const LABEL = 'boat';

  // A reading below this is no reading at all, and the contract names which signals say so with a
  // 0: `cog` has no course standing still, `twd` no direction in dead calm, `awa` none when the
  // apparent wind is genuinely calm. Blank those rather than draw a needle at due north.
  const CALM = 0.05;               // m/s
  // The boom lines up with the airflow once the sheet runs out past the apparent wind, and that
  // is luffing. A rigless hull publishes sail_angle 0 honestly - a boom on the centreline - so
  // the second test is what keeps both powerboats from reading as a luffing sailboat.
  const LUFF_AOA_DEG = 2.5;
  const LUFF_MIN_BOOM_DEG = 1;

  // contract `status`, whose bit layout is FROZEN: bit 1 is "on the ground", which for a hull is
  // AGROUND, and bit 6 is headlights at LOW or brighter, which on a boat is the navigation lights.
  const ST_IGNITION = 1 << 0, ST_GROUND = 1 << 1, ST_LIGHTS = 1 << 6;

  // THE INVALID SOUNDING IS THE RANGE FLOOR, not a hardcoded -1: the contract declares the
  // sentinel there ("the cluster's echo sounder reads range[0]"), so widening the range downward
  // moves the value that blanks the readout and nothing here has to be edited to follow it.
  const soundingValid = (v) => Number.isFinite(v) && v > rangeOf('depth')[0];

  // The depth trace: 30 s of soundings on their own clock rather than one per push, so the chart's
  // width is a duration and not a frame count.
  const TRACE_N = 120, TRACE_MS = 250;
  const trace = new Array(TRACE_N).fill(NaN);   // NaN = no sounding, and the path breaks there
  let traceLast = 0;

  // ── Window DOM ──────────────────────────────────────────────────────────────
  const win = document.createElement('div');
  win.className = 'boat-window';
  win.id = 'boatWindow';
  win.innerHTML = `
  <div class="boat-header" id="boatHeader" title="The boat's instruments, read off the game's own publish at ~20 Hz. Opens by itself when a boat appears on the Carlito link and takes the RAMN dashboard's place while it is up; the RAMN Control Panel stays, because a boat is driven on the same axes and it already shows what you are commanding. Drag to move, grip the bottom-right corner to resize.">
    <span class="boat-dot"></span>
    <span class="boat-title">Boat instruments</span>
    <button class="boat-close" id="boatCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="boat-scaleouter" id="boatScaleOuter">
   <div class="boat-body" id="boatBody">

    <div class="boat-chips">
      <div class="boat-chip" id="boatChipMode" title="contract nav_mode_actual - what the autopilot is ACTUALLY doing, against the mode that was asked for. Exactly one thing makes the two differ: a hand on the helm. Deflecting the rudder past the deadband hands it back for as long as it is held and reads STANDBY, and releasing re-engages the pilot on the NEW heading."><span class="cap">Autopilot</span><span class="val" id="boatMode">&ndash;</span></div>
      <div class="boat-chip" id="boatChipTgt" title="contract heading_target - the course the pilot is steering to, read back; the amber bug on the compass below is this value. In STANDBY it tracks the heading, which is the course an engage would capture. Its gap from the heading is the pilot's error, and its gap from COG is the leeway and set it does not correct for - a heading-hold pilot steers the BOW."><span class="cap">Target</span><span class="val" id="boatTgt">&ndash;</span></div>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-sec-lbl" title="contract awa / aws / twd / tws / sail_angle, bow up. The solid needle is the APPARENT wind (red from port, green from starboard), the dashed one the TRUE wind direction referenced to the bow, and the amber spar is the boom. THE GAP BETWEEN BOOM AND APPARENT NEEDLE IS THE ANGLE OF ATTACK, which is the whole reading a sail trimmer works from. A positive sail_angle lays the boom to port, the same rotational sense the wind angles use. Both powerboats publish sail_angle 0, which is honest - a boom on the centreline - so the spar sits fore-and-aft there and never reads as luffing."><span>Wind</span><span class="v" id="boatLuff"></span></div>
    <div class="boat-instr">
    <svg class="boat-dial" id="boatRose" viewBox="0 0 100 100">
      <circle class="rim" cx="50" cy="50" r="44"/>
      <g id="boatRoseTicks"></g>
      <polygon class="bow" points="50,3 47,9 53,9"/>
      <line class="boat-nd-twd"  id="boatNdTwd"  x1="50" y1="50" x2="50" y2="12"/>
      <line class="boat-nd-boom" id="boatNdBoom" x1="50" y1="50" x2="50" y2="14"/>
      <line class="boat-nd-awa"  id="boatNdAwa"  x1="50" y1="50" x2="50" y2="9"/>
      <circle class="hub" cx="50" cy="50" r="17"/>
      <text class="ctrv" id="boatAwsBig" x="50" y="51" font-size="15">&ndash;</text>
      <text class="ctrc" x="50" y="59">AWS m/s</text>
    </svg>
    <div class="boat-reads">
      <div class="boat-read" title="contract awa - apparent wind angle, the airflow over the hull measured from the bow. 0 is dead ahead, P is from port and S from starboard. It reads 0 running dead downwind at exactly wind speed, where the apparent wind really is calm, and blanks here rather than parking the needle."><span class="cap">AWA</span><span class="val" id="boatAwa">&ndash;</span></div>
      <div class="boat-read" title="contract twd - the bearing the TRUE wind comes FROM, which is what every marine instrument reads. The apparent wind above is this plus the hull's own motion, which is why it hauls forward as you sail faster. Dead calm reads no direction at all."><span class="cap">TWD</span><span class="val" id="boatTwd">&ndash;</span></div>
      <div class="boat-read" title="contract tws - true wind speed, read straight out of the level's wind field: measured, not modeled."><span class="cap">TWS</span><span class="val" id="boatTws">&ndash;</span></div>
      <div class="boat-read" title="contract sail_angle - the boom angle the sim settled on, degrees off the centreline, a positive angle laying the boom to port. The readback half of the sheet: the sheet says how far the boom MAY swing, this says where the wind put it."><span class="cap">Boom</span><span class="val" id="boatBoom">&ndash;</span></div>
      <div class="boat-read" title="Angle of attack, awa - sail_angle. The contract states that identity exactly, so this is the two instruments' gap and not a third model. It collapses to zero when the sheet is eased past the apparent wind and the sail luffs; hauling in opens it again."><span class="cap">AoA</span><span class="val" id="boatAoa">&ndash;</span></div>
      <div class="boat-read" title="contract rudder_actual - the rudder as APPLIED by the sim, slewed toward whatever was asked for, in the contract's own percent of full throw. The bar under Helm is the same number."><span class="cap">Rudder</span><span class="val" id="boatRud">&ndash;</span></div>
    </div>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-sec-lbl" title="contract depth - water under the TRANSDUCER, which rides the plane the hull floats on, so this is under-keel clearance and 0 is the bed reaching the hull. The trace is the last 30 seconds, and a bed walking up toward the hull is a shoal you are standing into - the reading a single number cannot give. The dashed red line is the contract's own shoal warn. -1 is the invalid sounding, off the terrain or out of the water, and it draws --- with a BREAK in the trace: never a zero, which is exactly the value a shoal alarm would act on."><span>Depth</span><span class="v">30 s</span></div>
    <div class="boat-depth">
      <svg viewBox="0 0 120 44" preserveAspectRatio="none">
        <rect class="boat-trace-bg" x="0.5" y="0.5" width="119" height="43" rx="3"/>
        <line class="boat-trace-warn" id="boatTraceWarn" x1="0" y1="0" x2="120" y2="0"/>
        <path class="boat-bed" id="boatBedPath" d=""/>
        <path class="boat-trace" id="boatTracePath" d=""/>
      </svg>
      <span class="boat-depth-v" id="boatDepthV">&ndash;</span>
      <span class="boat-depth-u">m under transducer</span>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-sec-lbl" title="contract heading against contract cog on ONE card, north up. The white needle is where the bow POINTS, the cyan dashed one the course the hull is actually MAKING, and the gap between them is the crab angle - leeway plus the set of the tide. The amber bug is the autopilot's heading_target, and the blue mark on the rim is contract current_set, the bearing the stream flows toward, which is what is pushing the two needles apart."><span>Course</span><span class="v" id="boatCrab">&ndash;</span></div>
    <div class="boat-instr">
    <svg class="boat-dial" id="boatCompass" viewBox="0 0 100 100">
      <circle class="rim" cx="50" cy="50" r="44"/>
      <g id="boatCompTicks"></g>
      <text class="card" x="50" y="19">N</text>
      <text class="card" x="83" y="54">E</text>
      <text class="card" x="50" y="88">S</text>
      <text class="card" x="17" y="54">W</text>
      <polygon class="boat-setmark" id="boatSetMark" points="50,4 46.5,11 53.5,11"/>
      <polygon class="boat-bug" id="boatBug" points="50,6 47,12.5 53,12.5"/>
      <line class="boat-nd-cog" id="boatNdCog" x1="50" y1="50" x2="50" y2="17"/>
      <line class="boat-nd-hdg" id="boatNdHdg" x1="50" y1="50" x2="50" y2="14"/>
      <circle class="hub" cx="50" cy="50" r="15"/>
      <text class="ctrv" id="boatHdgBig" x="50" y="51" font-size="14">&ndash;</text>
      <text class="ctrc" x="50" y="59">HDG</text>
    </svg>
    <div class="boat-reads">
      <div class="boat-read" title="contract cog - the compass bearing the hull is actually travelling, distinct from the heading by leeway and by the set of the tide. A hull that is not moving has no course, and blanks here rather than claiming due north."><span class="cap">COG</span><span class="val" id="boatCog">&ndash;</span></div>
      <div class="boat-read" title="contract current_set - the bearing the tidal stream flows TOWARD. Deliberately not inverted the way the wind is: marine practice names a wind by where it comes from and a current by where it goes. The ebb reverses this by 180 degrees rather than turning the drift negative."><span class="cap">Set</span><span class="val" id="boatSet">&ndash;</span></div>
      <div class="boat-read" title="contract current_drift - the rate of the tidal stream, read straight out of the level's current field. It rides a slow sinusoid, so the stream floods, goes slack and ebbs."><span class="cap">Drift</span><span class="val" id="boatDrift">&ndash;</span></div>
      <div class="boat-read" title="contract stw - speed THROUGH THE WATER, what a paddlewheel log reads. It equals SOG in still water and differs from it by the set and drift of the tide. Unsigned, so backing down reads positive."><span class="cap">STW</span><span class="val" id="boatStw">&ndash;</span></div>
      <div class="boat-read" title="contract sog - speed OVER GROUND. Not a second name for the speedometer, which is the signed component along the bow: a hull crabbing in a tide makes ground the bow is not pointing at, and only this counts it."><span class="cap">SOG</span><span class="val" id="boatSog">&ndash;</span></div>
      <div class="boat-read" title="SOG minus STW - the ground the tide is giving you or taking away. Positive means the stream is carrying you along, negative that you are punching into it."><span class="cap">Tide</span><span class="val" id="boatTide">&ndash;</span></div>
    </div>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-sec-lbl" title="The two things at the stern that swing. Both bars are centre-origin, because both controls run either side of neutral."><span>Helm</span></div>
    <div class="boat-bars n2">
    <div class="boat-bar-row" title="contract rudder_actual - the applied rudder in percent of full throw, port left of centre. The N2K frame it rides (PGN 127245) carries a real ANGLE, and the degrees-per-percent conversion lives in nmea2000.js rather than being re-declared here.">
      <div class="boat-bar-head"><span>Rudder</span><span class="v" id="boatRudV">&ndash;</span></div>
      <div class="boat-ctr"><i id="boatRudBar"></i></div>
    </div>
    <div class="boat-bar-row" title="contract trim - outdrive trim, a modeled position chasing forward throttle. Set-and-hold, so it moves over seconds rather than with the helm.">
      <div class="boat-bar-head"><span>Trim</span><span class="v" id="boatTrimV">&ndash;</span></div>
      <div class="boat-ctr"><i id="boatTrimBar"></i></div>
    </div>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-sec-lbl" title="The engine block. Every bar carries the contract's own range and warn threshold - the same numbers the game's own cluster colours on. contract engine_hours on the right is the hour meter, accumulated while the key is at Ignition."><span>Engine</span><span class="v" id="boatHours"></span></div>
    <div class="boat-bars n3">
    <div class="boat-bar-row" title="contract fuel - tank level in percent, red at the contract's low-fuel warn. Deliberately NOT one of the three tanks below: fuel is already this signal, and instancing it a second time would be two truths on one bus.">
      <div class="boat-bar-head"><span>Fuel</span><span class="v" id="boatFuelV">&ndash;</span></div>
      <div class="boat-bar" id="boatFuelBar"><i></i></div>
    </div>
    <div class="boat-bar-row" title="contract coolant - coolant temperature, red past the contract's overheat warn.">
      <div class="boat-bar-head"><span>Coolant</span><span class="v" id="boatCoolV">&ndash;</span></div>
      <div class="boat-bar" id="boatCoolBar"><i></i></div>
    </div>
    <div class="boat-bar-row" title="contract battery - terminal voltage, a labelled honest model, red below the contract's low warn. Distinct from the battery warning LED, which is an inbound signal this side owns.">
      <div class="boat-bar-head"><span>Battery</span><span class="v" id="boatBattV">&ndash;</span></div>
      <div class="boat-bar" id="boatBattBar"><i></i></div>
    </div>
    </div>
    <div class="boat-reads" style="margin-top:8px">
      <div class="boat-read" title="contract fuel_rate in L/h - a labelled honest model off applied throttle (idle burn plus a load term), not litres actually drawn from the tank, and it does not reconcile against the fuel level, which drains on its own clock. Range-less by contract, so it gets a number and not a bar."><span class="cap">Burn</span><span class="val" id="boatBurn">&ndash;</span></div>
      <div class="boat-read" title="contract oil_press in kPa - a labelled honest model off the engine's own rpm, rising from a low-idle floor to a nominal plateau. Zero with the key off. Range-less by contract."><span class="cap">Oil</span><span class="val" id="boatOil">&ndash;</span></div>
      <div class="boat-read" title="contract throttle - throttle as APPLIED by the sim, signed by direction, so backing down reads negative."><span class="cap">Thr</span><span class="val" id="boatThr">&ndash;</span></div>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-sec-lbl" title="contract tank_level, an instanced signal of three. Fresh water drains and waste rises together while the engine runs, one honest model running both directions; the live-well is held, since nothing in the sim fills or drains it. DELIBERATELY UNCOLOURED: the contract carries no warn for this array, because the three tanks have opposite dangerous directions - low fresh water, high waste - so no single threshold applies across it."><span>Tanks</span></div>
    <div class="boat-bars n3">
    <div class="boat-bar-row" title="contract tank_level index 0 - fresh water. It drains while the engine runs.">
      <div class="boat-bar-head"><span>Fresh</span><span class="v" id="boatTk0V">&ndash;</span></div>
      <div class="boat-bar" id="boatTk0Bar"><i></i></div>
    </div>
    <div class="boat-bar-row" title="contract tank_level index 1 - the waste tank. It rises as the fresh water drains.">
      <div class="boat-bar-head"><span>Waste</span><span class="v" id="boatTk1V">&ndash;</span></div>
      <div class="boat-bar" id="boatTk1Bar"><i></i></div>
    </div>
    <div class="boat-bar-row" title="contract tank_level index 2 - the live-well. Held rather than modeled: nothing in the sim fills or drains it.">
      <div class="boat-bar-head"><span>Live-well</span><span class="v" id="boatTk2V">&ndash;</span></div>
      <div class="boat-bar" id="boatTk2Bar"><i></i></div>
    </div>
    </div>

    <div class="boat-rule"></div>
    <div class="boat-tells">
      <div class="boat-tell" id="boatTellIgn" data-color="green" title="contract status bit 0 - ignition. The throttle is forced to zero without it.">Ign</div>
      <div class="boat-tell" id="boatTellAgnd" data-color="red" title="contract status bit 1 - 'on the ground', which for a hull means AGROUND: the bed has come up far enough to hold the boat off its rest depth. It reads the same seabed the sounding does, so the two cannot drift apart.">Aground</div>
      <div class="boat-tell" id="boatTellNav" data-color="blue" title="contract status bit 6 - headlights at LOW or brighter, which on a boat is the navigation lights.">Nav</div>
      <div class="boat-tell" id="boatTellShoal" data-color="red" title="contract depth against its own warn, a LOW-side threshold: a metre of water under a hull that draws a third of one is shallow but still swimming. The invalid -1 sounding is excluded, because it is not a shoal.">Shoal</div>
      <div class="boat-tell" id="boatTellHeel" data-color="amber" title="contract roll against its own warn, taken as a magnitude - a knockdown to port is the same reading as one to starboard.">Heel</div>
      <div class="boat-tell" id="boatTellPitch" data-color="amber" title="contract pitch against its own warn, taken as a magnitude. Bow up or bow down, out of the buoyancy sim.">Pitch</div>
      <div class="boat-tell" id="boatTellFuel" data-color="amber" title="contract fuel against its own low warn.">Fuel</div>
      <div class="boat-tell" id="boatTellBatt" data-color="red" title="contract battery voltage against its own low warn.">Batt</div>
    </div>

   </div>
  </div>
  <div class="boat-resize" id="boatResize"></div>
`;

  // ── State ───────────────────────────────────────────────────────────────────
  let tel = null;               // last telemetry pushed (null = link gone)
  let live = false;             // a boat is on the link
  let autoOpened = false;       // opened BY the telemetry, not by hand
  let scale = () => {};
  let rafPending = false;
  let el = {};

  const isOpen = () => win.classList.contains('open');

  // ── Follow the link ─────────────────────────────────────────────────────────
  // Only an AUTOMATIC open is undone by the automatic close.
  window.vehiclePanelSubscribe(function (t) {
    tel = t;
    const now = !!(window.vehiclePanelIsFamily && window.vehiclePanelIsFamily(FAMILY, t));
    if (now !== live) {
      live = now;
      if (live && !isOpen()) { autoOpened = true; setOpen(true); }
      else if (!live && autoOpened) { autoOpened = false; setOpen(false); }
    }
    sampleDepth();
    markDirty();
  });

  // The sounding history is kept whether or not the window is up, so re-opening it shows the water
  // you have just crossed rather than a blank chart.
  function sampleDepth() {
    const now = Date.now();
    if (now - traceLast < TRACE_MS) return;
    traceLast = now;
    const d = (live && tel) ? num(tel.depth) : NaN;
    trace.shift();
    // The sentinel is "no sounding", not a depth: it goes in as a gap.
    trace.push(soundingValid(d) ? d : NaN);
  }

  // ── Window open / close ─────────────────────────────────────────────────────
  function setOpen(open) {
    if (isOpen() === open) return;
    win.classList.toggle('open', open);
    if (open) { scale(win.offsetWidth || BASE_W); markDirty(); }
    const b = document.getElementById('boatBtn');
    if (b) b.classList.toggle('active', open);
    if (window.vehiclePanelClaim) window.vehiclePanelClaim(PANEL_ID, open, 'dash');
  }
  function boatToggle() {
    autoOpened = false;             // touched by hand: the telemetry hook stops closing it
    setOpen(!isOpen());
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  // On the telemetry push (~20 Hz), not per ingested frame: this window follows the link.
  function markDirty() {
    if (rafPending || !isOpen()) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function setTell(node, on) {
    // Idempotent: re-toggling every tick fights the transition and flickers on the ON→OFF edge.
    if (node.classList.contains('on') === on) return;
    node.classList.toggle('on', on);
    node.classList.toggle(node.dataset.color, on);
  }

  // A needle is HIDDEN rather than parked when its signal is absent or its reading is a calm-water
  // zero - a needle at due north is a claim the instrument is not making.
  function setNeedle(node, deg, show) {
    const draw = !!show && Number.isFinite(deg);
    node.classList.toggle('boat-hidden', !draw);
    if (draw) node.setAttribute('transform', `rotate(${deg.toFixed(1)} 50 50)`);
  }

  function setBar(barEl, vEl, name, v, digits, unit) {
    const [lo, hi] = rangeOf(name);
    const span = (hi - lo) || 1;
    const warn = isWarn(name, v);
    barEl.classList.toggle('warn', warn);
    barEl.firstElementChild.style.width =
      Number.isFinite(v) ? (Math.max(0, Math.min(100, (v - lo) / span * 100)) + '%') : '0%';
    vEl.textContent = fmt(v, digits, unit);
    vEl.classList.toggle('warn', warn);
  }

  // Centre-origin: the value is a percentage swinging either side of neutral. `label` differs by
  // what the control IS - the rudder swings to a SIDE, the outdrive tilts up and down.
  function setCtrBar(barEl, vEl, v, label) {
    const c = Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0;
    barEl.style.width = Math.abs(c) / 2 + '%';
    barEl.style.left = c >= 0 ? '50%' : (50 - Math.abs(c) / 2) + '%';
    vEl.textContent = label(v);
  }
  const asSide = (v) => sided(v, '%');
  const asSigned = (v) => Number.isFinite(v) ? ((v >= 0 ? '+' : '-') + Math.round(Math.abs(v)) + '%') : '–';

  function renderTrace(depth) {
    const [, top] = rangeOf('depth');
    const hi = top > 0 ? top : 10;
    const W = 120, H = 44;
    // Two paths off one walk: the sounding line, and the ground under it filled to the bottom of
    // the card. The fill is what makes the reading instant - the bed is a MASS coming up at the
    // hull, and without it the empty half of the card reads as the water instead.
    let d = '', bed = '', x0 = 0, pen = false;
    const closeRun = (xEnd) => { if (pen) bed += `L${xEnd.toFixed(1)} ${H} L${x0.toFixed(1)} ${H} Z `; };
    for (let i = 0; i < TRACE_N; i++) {
      const v = trace[i];
      const x = (i / (TRACE_N - 1)) * W;
      if (!Number.isFinite(v)) {                            // an invalid sounding BREAKS both paths
        if (pen) closeRun((i ? (i - 1) : 0) / (TRACE_N - 1) * W);
        pen = false;
        continue;
      }
      // The bed is drawn AT its depth, so shoaling water walks the line up toward the hull - the
      // way an echo sounder's own chart reads. Past the contract's full scale it simply pins.
      const y = Math.min(H - 1, Math.max(1, (Math.min(v, hi) / hi) * H));
      d   += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      bed += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      if (!pen) x0 = x;
      pen = true;
    }
    closeRun(W);
    el.tracePath.setAttribute('d', d);
    el.bedPath.setAttribute('d', bed);

    const shoal = soundingValid(depth) && isWarn('depth', depth);
    el.tracePath.classList.toggle('warn', shoal);
    el.bedPath.classList.toggle('warn', shoal);

    const s = sigDef('depth', 'out');
    const warnY = (s && Number.isFinite(Number(s.warn))) ? (Math.min(s.warn, hi) / hi) * H : -1;
    el.traceWarn.setAttribute('y1', warnY);
    el.traceWarn.setAttribute('y2', warnY);
    el.traceWarn.classList.toggle('boat-hidden', warnY < 0);

    // The invalid sounding reads '- - -'. A zero here would be the one value a shoal alarm acts on.
    el.depthV.textContent = !Number.isFinite(depth) ? '–'
      : (soundingValid(depth) ? depth.toFixed(1) : '- - -');
    el.depthV.classList.toggle('warn', shoal);
  }

  function render() {
    if (!isOpen()) return;
    // No boat on the link → the resting panel, not the last one's readings frozen.
    const t = (live && tel) ? tel : {};

    // ── Autopilot ──
    const navActual = num(t.nav_mode_actual);
    const engaged = navActual >= 1;
    el.mode.textContent = Number.isFinite(navActual) ? enumLabel('nav_mode_actual', navActual) : '–';
    el.chipMode.classList.toggle('on', engaged);
    const tgt = num(t.heading_target);
    el.tgt.textContent = bearing(tgt);
    el.chipTgt.classList.toggle('on', engaged);

    // ── Wind rose ──
    // ONE rotational sense on this dial, clockwise from the bow, and every mark uses it. The wind
    // angles are already bow-referenced; the boom is the AFT direction turned by sail_angle, which
    // is what makes the visible gap between spar and needle the angle of attack.
    const awa = num(t.awa), aws = num(t.aws), twd = num(t.twd), tws = num(t.tws);
    const heading = num(t.heading), boom = num(t.sail_angle);
    const windy = Number.isFinite(aws) ? aws > CALM : false;
    const trueWindy = Number.isFinite(tws) ? tws > CALM : false;

    setNeedle(el.ndAwa, awa, windy);
    el.ndAwa.style.stroke = (Number.isFinite(awa) && awa < 0) ? 'var(--red)' : 'var(--green)';
    setNeedle(el.ndTwd,
      (Number.isFinite(twd) && Number.isFinite(heading)) ? wrap180(twd - heading) : NaN, trueWindy);
    setNeedle(el.ndBoom, Number.isFinite(boom) ? 180 + boom : NaN, true);
    el.awsBig.textContent = fmt(aws, 1);

    el.awa.textContent = windy ? sided(awa, '°') : '–';
    el.awa.className = 'val' + (windy && Number.isFinite(awa) ? (awa < 0 ? ' port' : ' stbd') : '');
    el.twd.textContent = trueWindy ? bearing(twd) : '–';
    el.tws.textContent = fmt(tws, 1);
    el.boom.textContent = sided(boom, '°');

    // Derived from the apparent wind, so it blanks wherever the apparent wind does: an angle of
    // attack off a calm-water awa of 0 would be a number with nothing behind it.
    const aoa = (windy && Number.isFinite(awa) && Number.isFinite(boom)) ? awa - boom : NaN;
    el.aoa.textContent = Number.isFinite(aoa) ? (Math.round(Math.abs(aoa)) + '°') : '–';
    const luffing = Number.isFinite(aoa) && Math.abs(aoa) <= LUFF_AOA_DEG &&
                    Math.abs(boom) > LUFF_MIN_BOOM_DEG;
    el.aoa.classList.toggle('warn', luffing);
    el.luff.textContent = luffing ? 'LUFFING' : '';
    el.luff.classList.toggle('on', luffing);

    const rudder = num(t.rudder_actual);
    el.rud.textContent = sided(rudder, '%');

    // ── Depth ──
    renderTrace(num(t.depth));

    // ── Compass: north up, both needles absolute ──
    const cog = num(t.cog), sog = num(t.sog), stw = num(t.stw);
    const moving = Number.isFinite(sog) ? sog > CALM : false;
    const set = num(t.current_set), drift = num(t.current_drift);
    const streaming = Number.isFinite(drift) ? drift > CALM : false;

    setNeedle(el.ndHdg, heading, true);
    setNeedle(el.ndCog, cog, moving);
    setNeedle(el.bug, tgt, true);
    el.bug.classList.toggle('off', !engaged);
    setNeedle(el.setMark, set, streaming);
    el.hdgBig.textContent = bearing(heading, '');

    el.cog.textContent = moving ? bearing(cog) : '–';
    const crab = (moving && Number.isFinite(heading)) ? wrap180(cog - heading) : NaN;
    el.crab.textContent = Number.isFinite(crab) ? ('crab ' + sided(crab, '°')) : '–';
    // "slack" is a READING - the stream really has stopped - so an absent drift must not borrow
    // it. No signal at all blanks, the way every other readout here does.
    el.set.textContent = !Number.isFinite(drift) ? '–' : (streaming ? bearing(set) : 'slack');
    el.drift.textContent = fmt(drift, 2);
    el.stw.textContent = fmt(stw, 1);
    el.sog.textContent = fmt(sog, 1);
    const tide = (Number.isFinite(sog) && Number.isFinite(stw)) ? sog - stw : NaN;
    el.tide.textContent = Number.isFinite(tide) ? ((tide >= 0 ? '+' : '') + tide.toFixed(2)) : '–';

    // ── Helm ──
    setCtrBar(el.rudBar, el.rudV, rudder, asSide);
    setCtrBar(el.trimBar, el.trimV, num(t.trim), asSigned);

    // ── Engine ──
    const hrs = num(t.engine_hours);
    el.hours.textContent = Number.isFinite(hrs) ? (hrs.toFixed(1) + ' h') : '';
    setBar(el.fuelBar, el.fuelV, 'fuel', num(t.fuel), 0, '%');
    setBar(el.coolBar, el.coolV, 'coolant', num(t.coolant), 0, '°C');
    setBar(el.battBar, el.battV, 'battery', num(t.battery), 1, ' V');
    el.burn.textContent = fmt(num(t.fuel_rate), 1);
    el.oil.textContent = whole(num(t.oil_press));
    const thr = num(t.throttle);
    el.thr.textContent = Number.isFinite(thr)
      ? ((thr < 0 ? '-' : '') + Math.round(Math.abs(thr)) + '%') : '–';

    // ── Tanks ── (no warn in the contract, so no colour - see the section title)
    for (let i = 0; i < 3; i++) {
      const v = inst(t.tank_level, i);
      el.tkBar[i].firstElementChild.style.width =
        Number.isFinite(v) ? (Math.max(0, Math.min(100, v)) + '%') : '0%';
      el.tkV[i].textContent = whole(v, '%');
    }

    // ── Tell-tales ──
    const st = num(t.status) | 0;
    const depth = num(t.depth);
    setTell(el.tellIgn, !!(st & ST_IGNITION));
    setTell(el.tellAgnd, !!(st & ST_GROUND));
    setTell(el.tellNav, !!(st & ST_LIGHTS));
    setTell(el.tellShoal, soundingValid(depth) && isWarn('depth', depth));
    setTell(el.tellHeel, isWarn('roll', Math.abs(num(t.roll))));
    setTell(el.tellPitch, isWarn('pitch', Math.abs(num(t.pitch))));
    setTell(el.tellFuel, isWarn('fuel', num(t.fuel)));
    setTell(el.tellBatt, isWarn('battery', num(t.battery)));
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    document.body.appendChild(win);
    const q = (id) => win.querySelector('#' + id);

    // Dial ticks, built once: every 30 degrees, long on the quarters.
    const ticks = (host, r0) => {
      let s = '';
      for (let a = 0; a < 360; a += 30) {
        const y1 = (a % 90) === 0 ? r0 + 6 : r0 + 3;
        s += `<line class="tick" x1="50" y1="${r0}" x2="50" y2="${y1}" transform="rotate(${a} 50 50)"/>`;
      }
      host.innerHTML = s;
    };
    ticks(q('boatRoseTicks'), 6);
    ticks(q('boatCompTicks'), 6);

    el = {
      chipMode: q('boatChipMode'), mode: q('boatMode'), chipTgt: q('boatChipTgt'), tgt: q('boatTgt'),
      ndAwa: q('boatNdAwa'), ndTwd: q('boatNdTwd'), ndBoom: q('boatNdBoom'), awsBig: q('boatAwsBig'),
      awa: q('boatAwa'), twd: q('boatTwd'), tws: q('boatTws'), boom: q('boatBoom'),
      aoa: q('boatAoa'), rud: q('boatRud'), luff: q('boatLuff'),
      tracePath: q('boatTracePath'), bedPath: q('boatBedPath'),
      traceWarn: q('boatTraceWarn'), depthV: q('boatDepthV'),
      ndHdg: q('boatNdHdg'), ndCog: q('boatNdCog'), bug: q('boatBug'), setMark: q('boatSetMark'),
      hdgBig: q('boatHdgBig'), crab: q('boatCrab'),
      cog: q('boatCog'), set: q('boatSet'), drift: q('boatDrift'),
      stw: q('boatStw'), sog: q('boatSog'), tide: q('boatTide'),
      rudBar: q('boatRudBar'), rudV: q('boatRudV'), trimBar: q('boatTrimBar'), trimV: q('boatTrimV'),
      hours: q('boatHours'),
      fuelBar: q('boatFuelBar'), fuelV: q('boatFuelV'),
      coolBar: q('boatCoolBar'), coolV: q('boatCoolV'),
      battBar: q('boatBattBar'), battV: q('boatBattV'),
      burn: q('boatBurn'), oil: q('boatOil'), thr: q('boatThr'),
      tkBar: [q('boatTk0Bar'), q('boatTk1Bar'), q('boatTk2Bar')],
      tkV: [q('boatTk0V'), q('boatTk1V'), q('boatTk2V')],
      tellIgn: q('boatTellIgn'), tellAgnd: q('boatTellAgnd'), tellNav: q('boatTellNav'),
      tellShoal: q('boatTellShoal'), tellHeel: q('boatTellHeel'), tellPitch: q('boatTellPitch'),
      tellFuel: q('boatTellFuel'), tellBatt: q('boatTellBatt'),
    };

    q('boatCloseBtn').addEventListener('click', () => { autoOpened = false; setOpen(false); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; autoOpened = false; setOpen(false);
    });

    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: q('boatHeader'), grip: q('boatResize'),
        outer: q('boatScaleOuter'), body: q('boatBody'),
        baseW: BASE_W, closeSel: '.boat-close',
      });
    } else {
      console.warn('Boat panel: makeFloating is missing - load ramn.js before boat.js.');
    }

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: PANEL_ID, family: FAMILY, variant: VARIANT, label: LABEL,
        btn: 'boatBtn', isOpen,
        close: () => { autoOpened = false; setOpen(false); },
      });
    }
  })();

  window.boatToggle = boatToggle;
})();
