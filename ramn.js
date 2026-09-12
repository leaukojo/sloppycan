// ── RAMN Dashboard + Control Panel ──────────────────────────────────────────
// Self-contained module. Two floating, draggable, resizable windows:
//   1. RAMN dashboard - decodes the live CAN stream from a RAMN (Resistant
//      Automotive Miniature Network) board into vehicle signals (brake, accel,
//      steering, gear, lights, turn, key, handbrake, horn) and renders a car cluster.
//   2. RAMN Control Panel (DEMO MODE ONLY) - lets the user "drive" the simulated
//      car. Its control values replace the demo's fixed 0x0000 payload bytes, so
//      moving a control changes the demo CAN frames, which the dashboard reflects.
//
// Signal decode/encode is grounded in the RAMN firmware (ramn_sensors.h,
// ramn_signal_defs.h, ramn_can_database.c, ramn_actuators.h) and
// misc/busmaster_ramn.dbc. 16-bit analog values are big-endian, first 2 bytes.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   index.html    <script src="ramn.js" defer>  +  #ramnBtn (paired toggle opens dashboard + demo Control Panel)
//   sloppycan.js  ingestFrame():  if (window.ramnIngestFrame) ramnIngestFrame(frame);
//   sloppycan.js  clearFrames():  if (window.ramnClear) ramnClear();
//   sloppycan.js  disconnect path: if (window.ramnStop) ramnStop();
//   sloppycan.js  demoTick(): payload = window.ramnCtrlPayload ? ramnCtrlPayload(id) : [0,0];
//   sloppycan.js  startDemo(): if (window.ramnDemoStarted) ramnDemoStarted();  (records demo → pairs Control Panel)
//// Live-only: no persistence of window position/state.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.ramn-window {
  position:fixed; z-index:900; top:72px; left:90px; width:300px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.ramn-window.open { display:flex; }
.ramn-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.ramn-header .ramn-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; }
.ramn-header .ramn-dot.ctrl { background:var(--amber); }
.ramn-header .ramn-title { flex:1; }
.ramn-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.ramn-close:hover { background:var(--bg); color:var(--text); }
.ramn-scaleouter { overflow:hidden; }
.ramn-body { width:300px; transform-origin:top left; padding:14px 14px 16px; box-sizing:border-box; }

/* Top row: steering wheel + gear */
.ramn-top { display:flex; align-items:center; gap:14px; margin-bottom:14px; }
.ramn-wheel { width:80px; height:80px; color:var(--text2); flex-shrink:0; transition:transform .08s linear; }
.ramn-gearbox { flex:1; text-align:center; }
.ramn-gearcap { font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:4px; }
.ramn-gearbadge {
  display:inline-flex; align-items:center; justify-content:center; min-width:56px;
  padding:5px 14px; border:1px solid var(--border2); border-radius:9px; background:var(--bg);
}
.ramn-gear { font-family:var(--mono); font-size:38px; font-weight:500; line-height:1; color:var(--text); }
.ramn-gear.rev { color:var(--amber); }
.ramn-joy { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); margin-top:6px; min-height:12px; }
.ramn-joy.active { color:var(--blue); }

/* Pedal + steer bars */
.ramn-bar-row { margin-bottom:9px; }
.ramn-bar-head { display:flex; justify-content:space-between; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:3px; }
.ramn-bar-head .v { font-family:var(--mono); color:var(--text); letter-spacing:0; }
.ramn-bar { height:9px; background:var(--bg); border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.ramn-bar > i { display:block; height:100%; width:0%; border-radius:4px; transition:width .08s linear; }
.ramn-bar.brake > i { background:var(--red); }
.ramn-bar.accel > i { background:var(--green); }
/* Steering: centre-origin bar */
.ramn-steer { position:relative; height:9px; background:var(--bg); border:1px solid var(--border); border-radius:5px; }
.ramn-steer::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--border2); }
.ramn-steer > i { position:absolute; top:0; bottom:0; left:50%; width:0%; background:var(--blue); border-radius:3px; transition:all .08s linear; }

/* Tell-tale grid */
.ramn-tells {
  display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:14px;
  border-top:1px solid var(--border); padding-top:12px;
}
.ramn-tell {
  display:flex; flex-direction:column; align-items:center; gap:3px;
  padding:6px 2px; border-radius:8px; background:var(--bg); color:var(--text3);
  transition:color .1s, background .1s;
}
.ramn-tell svg { width:22px; height:22px; }
.ramn-tell .lbl { font-size:8px; text-transform:uppercase; letter-spacing:.05em; text-align:center; line-height:1.2; }
.ramn-tell.on.green { color:var(--green); background:var(--green-dim); }
.ramn-tell.on.blue  { color:var(--blue);  background:var(--blue-dim); }
.ramn-tell.on.amber { color:var(--amber); background:var(--amber-dim); }
.ramn-tell.on.red   { color:var(--red);   background:var(--red-dim); }
.ramn-tell.blink { animation:ramnBlink .85s steps(1) infinite; }
@keyframes ramnBlink { 0%,50%{opacity:1} 50.01%,100%{opacity:.18} }

.ramn-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}

/* ── Control Panel ─────────────────────────────────────────────────────────── */
.ramn-sec { margin-bottom:11px; }
.ramn-sec-lbl { display:flex; justify-content:space-between; align-items:center; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:5px; }
.ramn-sec-lbl .v { font-family:var(--mono); color:var(--text); letter-spacing:0; text-transform:none; }
.ramn-range { width:100%; margin:0; cursor:pointer; }
.ramn-range.brake { accent-color:var(--red); }
.ramn-range.accel { accent-color:var(--green); }
.ramn-range.steer { accent-color:var(--blue); }
.ramn-seg { display:flex; gap:4px; }
.ramn-seg button, .ramn-toggle {
  flex:1; padding:6px 0; font-size:11px; font-family:var(--sans); text-align:center;
  background:var(--bg); color:var(--text2); border:1px solid var(--border);
  border-radius:6px; cursor:pointer; user-select:none; transition:background .08s,color .08s;
}
.ramn-seg button:hover, .ramn-toggle:hover { background:var(--bg3); color:var(--text); }
.ramn-seg button.active { background:var(--blue-dim); color:var(--blue); border-color:transparent; }
.ramn-seg button.active.rev { background:var(--amber-dim); color:var(--amber); }
.ramn-toggle.on.green { background:var(--green-dim); color:var(--green); border-color:transparent; }
.ramn-toggle.on.amber { background:var(--amber-dim); color:var(--amber); border-color:transparent; }
.ramn-toggle.on.red   { background:var(--red-dim);   color:var(--red);   border-color:transparent; }
.ramn-row2 { display:flex; gap:6px; }
.ramn-mini {
  font-size:9px; font-family:var(--sans); padding:2px 8px; background:var(--bg);
  color:var(--text2); border:1px solid var(--border); border-radius:5px; cursor:pointer;
}
.ramn-mini:hover { background:var(--bg3); color:var(--text); }
.ramn-joypad { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; width:128px; margin:0 auto; }
.ramn-joypad button {
  padding:9px 0; font-size:14px; background:var(--bg); color:var(--text2);
  border:1px solid var(--border); border-radius:6px; cursor:pointer; user-select:none;
}
.ramn-joypad button.sp { visibility:hidden; }
.ramn-joypad button.held { background:var(--blue-dim); color:var(--blue); border-color:transparent; }
.ramn-joypad button.on { background:var(--green-dim); color:var(--green); border-color:transparent; }
.ramn-hint {
  margin-top:6px; padding-top:9px; border-top:1px solid var(--border);
  font-size:9.5px; color:var(--text3); line-height:1.5;
}
.ramn-hint b { color:var(--text2); font-weight:600; }
.ramn-hint a { color:var(--blue); text-decoration:none; }
.ramn-hint a:hover { text-decoration:underline; }
`;
  document.head.appendChild(s);
})();

// ── Shared window mechanics ──────────────────────────────────────────────────
// Drag (header, clamped to viewport) + resize (grip → uniform scale of body).
// Returns applyScale(width). Adapted from the resize-handle idiom in sloppycan.js.
function makeFloating({ win, header, grip, outer, body, baseW, minW = 220, maxW = 640 }) {
  // Drag and resize each attach their window-level move/up listeners only while the
  // gesture is active and remove them on release, so no global listeners persist
  // between interactions (the windows are toggled, never destroyed - there is no
  // teardown hook to detach a permanent listener from).
  let sx = 0, sy = 0, sl = 0, st0 = 0;
  header.addEventListener('mousedown', e => {
    if (e.target.closest('.ramn-close')) return;
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    const r = win.getBoundingClientRect(); sl = r.left; st0 = r.top;
    win.style.right = 'auto';
    document.body.style.userSelect = 'none';
    const onMove = ev => {
      let nl = sl + (ev.clientX - sx), nt = st0 + (ev.clientY - sy);
      nl = Math.max(0, Math.min(window.innerWidth - 40, nl));
      nt = Math.max(0, Math.min(window.innerHeight - 30, nt));
      win.style.left = nl + 'px'; win.style.top = nt + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  function applyScale(w) {
    const scale = w / baseW;
    win.style.width = w + 'px';
    body.style.transform = `scale(${scale})`;
    outer.style.height = (body.offsetHeight * scale) + 'px';
  }
  let rsx = 0, rsw = 0;
  grip.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    rsx = e.clientX; rsw = win.offsetWidth;
    document.body.style.cursor = 'nwse-resize'; document.body.style.userSelect = 'none';
    const onMove = ev => applyScale(Math.max(minW, Math.min(maxW, rsw + (ev.clientX - rsx))));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  applyScale(baseW);
  return applyScale;
}

const BASE_W = 300;

// ── Dashboard window DOM ──────────────────────────────────────────────────────
const win = document.createElement('div');
win.className = 'ramn-window';
win.id = 'ramnWindow';
win.innerHTML = `
  <div class="ramn-header" id="ramnHeader">
    <span class="ramn-dot"></span>
    <span class="ramn-title">RAMN dashboard</span>
    <button class="ramn-close" id="ramnCloseBtn" title="Close (Esc)">✕</button>
  </div>
  <div class="ramn-scaleouter" id="ramnScaleOuter">
   <div class="ramn-body" id="ramnBody">
    <div class="ramn-top">
      <svg class="ramn-wheel" id="ramnWheel" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round">
        <circle cx="50" cy="50" r="44"/>
        <circle cx="50" cy="50" r="10" fill="currentColor" stroke="none"/>
        <path d="M50 50 H94 M50 50 H6 M50 50 V94"/>
      </svg>
      <div class="ramn-gearbox">
        <div class="ramn-gearcap">Gear</div>
        <div class="ramn-gearbadge"><span class="ramn-gear" id="ramnGear">–</span></div>
        <div class="ramn-joy" id="ramnJoy"></div>
      </div>
    </div>

    <div class="ramn-bar-row">
      <div class="ramn-bar-head"><span>Brake</span><span class="v" id="ramnBrakeV">0%</span></div>
      <div class="ramn-bar brake"><i id="ramnBrakeBar"></i></div>
    </div>
    <div class="ramn-bar-row">
      <div class="ramn-bar-head"><span>Accel</span><span class="v" id="ramnAccelV">0%</span></div>
      <div class="ramn-bar accel"><i id="ramnAccelBar"></i></div>
    </div>
    <div class="ramn-bar-row">
      <div class="ramn-bar-head"><span>Steer</span><span class="v" id="ramnSteerV">C 0%</span></div>
      <div class="ramn-steer"><i id="ramnSteerBar"></i></div>
    </div>

    <div class="ramn-tells">
      <div class="ramn-tell" id="ramnTellTurnL" data-color="green">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="15,4 5,12 15,20"/></svg>
        <span class="lbl">Left</span>
      </div>
      <div class="ramn-tell" id="ramnTellTurnR" data-color="green">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="9,4 19,12 9,20"/></svg>
        <span class="lbl">Right</span>
      </div>
      <div class="ramn-tell" id="ramnTellClear" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="10.5" y="7" width="3" height="10" rx="1.5" fill="currentColor" stroke="none"/>
          <path d="M8 8 L4 6.5M8 12 H4M8 16 L4 17.5"/>
          <path d="M16 8 L20 6.5M16 12 H20M16 16 L20 17.5"/>
        </svg>
        <span class="lbl">Clearance</span>
      </div>
      <div class="ramn-tell" id="ramnTellLow" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6c5.5 0 5.5 12 0 12 a6 6 0 0 0 0-12z" fill="currentColor" stroke="none"/>
          <path d="M14 8 l6 1M14 12 l6 1M14 16 l6 1"/>
        </svg>
        <span class="lbl">Low beam</span>
      </div>
      <div class="ramn-tell" id="ramnTellHigh" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6c5.5 0 5.5 12 0 12 a6 6 0 0 0 0-12z" fill="currentColor" stroke="none"/>
          <path d="M14 8 h6M14 12 h6M14 16 h6"/>
        </svg>
        <span class="lbl">High</span>
      </div>
      <div class="ramn-tell" id="ramnTellKey" data-color="green">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="8" cy="8" r="4"/><path d="M11 11 l8 8M16 16 l2-2M18 18 l2-2"/>
        </svg>
        <span class="lbl" id="ramnKeyLbl">Off</span>
      </div>
      <div class="ramn-tell" id="ramnTellHand" data-color="red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/><path d="M7 12 h10" stroke-linecap="round"/>
          <text x="12" y="10" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">P</text>
        </svg>
        <span class="lbl">Brake</span>
      </div>
      <div class="ramn-tell" id="ramnTellHorn" data-color="amber">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 9 h4 l6-4 v14 l-6-4 H3 z"/>
          <path d="M17 8 a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span class="lbl">Horn</span>
      </div>
      <div class="ramn-tell" id="ramnTellBatt" data-color="red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="3" y="8" width="18" height="10" rx="1.5"/>
          <path d="M7 6 v2M7 5 h3M16 6 v2M14.5 7 h3"/>
        </svg>
        <span class="lbl">Batt</span>
      </div>
      <div class="ramn-tell" id="ramnTellChk" data-color="amber">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
          <path d="M4 11 V9 h2 V7 h3 l2-2 h3 v2 h2 l2 2 v2 h-1 v5 h-2 v-2 h-8 v2 H6 v-5 z"/>
        </svg>
        <span class="lbl">Check</span>
      </div>
    </div>
   </div>
  </div>
  <div class="ramn-resize" id="ramnResize"></div>
`;

// ── Control Panel window DOM ───────────────────────────────────────────────────
const ctrlWin = document.createElement('div');
ctrlWin.className = 'ramn-window';
ctrlWin.id = 'ramnCtrlWindow';
ctrlWin.style.left = '410px';
ctrlWin.innerHTML = `
  <div class="ramn-header" id="ramnCtrlHeader">
    <span class="ramn-dot ctrl"></span>
    <span class="ramn-title">RAMN Control</span>
    <button class="ramn-close" id="ramnCtrlCloseBtn" title="Close (Esc)">✕</button>
  </div>
  <div class="ramn-scaleouter" id="ramnCtrlScaleOuter">
   <div class="ramn-body" id="ramnCtrlBody">
    <div class="ramn-sec">
      <div class="ramn-sec-lbl"><span>Brake</span><span class="v" id="ramnCtrlBrakeV">0%</span></div>
      <input type="range" class="ramn-range brake" id="ramnCtrlBrake" min="0" max="100" value="0">
    </div>
    <div class="ramn-sec">
      <div class="ramn-sec-lbl"><span>Accel</span><span class="v" id="ramnCtrlAccelV">0%</span></div>
      <input type="range" class="ramn-range accel" id="ramnCtrlAccel" min="0" max="100" value="0">
    </div>
    <div class="ramn-sec">
      <div class="ramn-sec-lbl"><span>Steer</span><span><button class="ramn-mini" id="ramnCtrlCentre">Centre</button> <span class="v" id="ramnCtrlSteerV">C 0%</span></span></div>
      <input type="range" class="ramn-range steer" id="ramnCtrlSteer" min="-100" max="100" value="0">
    </div>
    <div class="ramn-sec">
      <div class="ramn-sec-lbl"><span>Shift joystick</span><span class="v" id="ramnCtrlGearV">Gear 1</span></div>
      <div class="ramn-joypad" id="ramnCtrlJoy">
        <button class="sp"></button><button data-joy="2">↑</button><button class="sp"></button>
        <button data-joy="5">←</button><button data-joy="6">●</button><button data-joy="4">→</button>
        <button class="sp"></button><button data-joy="3">↓</button><button class="sp"></button>
      </div>
    </div>
    <div class="ramn-sec">
      <div class="ramn-sec-lbl"><span>Lights</span></div>
      <div class="ramn-seg" id="ramnCtrlLights">
        <button data-val="1">Off</button><button data-val="2">Clr</button><button data-val="3">Low</button><button data-val="4">High</button>
      </div>
    </div>
    <div class="ramn-sec">
      <div class="ramn-sec-lbl"><span>Engine key</span></div>
      <div class="ramn-seg" id="ramnCtrlKey">
        <button data-val="1">Off</button><button data-val="2">Acc</button><button data-val="3">Ign</button>
      </div>
    </div>
    <div class="ramn-sec">
      <div class="ramn-toggle" id="ramnCtrlHand" data-color="red">Handbrake</div>
    </div>
    <div class="ramn-hint">
      <b>Joystick</b>: ↑/↓ shift gear · ←/→ toggle turn signal · ● horn.<br>
      <b>Keys</b> (panel open): <b>W</b>/<b>S</b> accel/brake · <b>A</b>/<b>D</b> steer · <b>Space</b> handbrake - hold to drive.<br>
      <a href="https://github.com/ToyotaInfoTech/RAMN" target="_blank" rel="noopener">Learn more about RAMN ↗</a>
    </div>
   </div>
  </div>
  <div class="ramn-resize" id="ramnCtrlResize"></div>
`;

// ── Dashboard state ─────────────────────────────────────────────────────────────
function blankState() {
  return {
    brake: 0, accel: 0, steer: 0,           // %, % , -100(L)..+100(R)
    gear: null, joy: 1,                      // gear: 'R'|1..6|null ; joy enum 1..6
    horn: false, lights: 1, key: 1,          // lights 1..4 (derived from 0x1BB), key 1..3
    turnL: false, turnR: false,              // from 0x1BB LED status (0x1A7 control too)
    handbrake: false, battery: false, checkEngine: false,
    clearance: false, lowbeam: false, highbeam: false,  // 0x1BB lamp bits
    brakeLamp: false,                        // 0x1BB bit 0x04 (sidebrake) - forwarded to Carlito
    brakeRaw: 0                              // raw 12-bit 0x024 brake (for parking-brake LED)
  };
}
let ramnState = blankState();
let dirty = true, rafPending = false;
let dashScale = () => {}, ctrlScale = () => {};

// ── Control state + demo payload encoder ───────────────────────────────────────
// Defaults give a sane resting car (centred wheel, lights/key off, first gear).
const ramnCtrl = {
  brake: 0, accel: 0, steer: 0,   // steer -100(L)..+100(R)
  gear: 1, joy: 1,                // gear 1..6 or 'R'
  horn: 0, lights: 1, key: 3,     // key defaults to Ignition so demo driving passes Carlito's engine gate
  turnL: 0, turnR: 0, handbrake: 0
};

// big-endian first two data bytes
function be16(d) { return ((d[0] || 0) << 8) | (d[1] || 0); }
function be12bytes(pct, lo, hi) { // map pct of [lo,hi] of a 12-bit value to 2 BE bytes
  const v = Math.max(0, Math.min(0xFFF, Math.round(lo + (hi - lo) * pct)));
  return [(v >> 8) & 0xFF, v & 0xFF];
}

// Demo blinker phase (~1 Hz): the dashboard now mirrors the 0x1BB turn bit directly, so the
// demo must toggle that bit at blink rate to make the indicator visibly blink.
const ramnBlinkOn = () => (Math.floor(Date.now() / 500) % 2) === 0;

// Returns the 2 payload bytes for a demo RAMN ID, from current control state.
function ramnCtrlPayload(id) {
  const c = ramnCtrl;
  switch (id) {
    case 0x024: return be12bytes(c.brake / 100, 0, 0xFFF);
    case 0x039: return be12bytes(c.accel / 100, 0, 0xFFF);
    // steer: L100→0x000, centre→0x7FF, R100→0xFFF (per user spec). Span the positive side by 0x800
    // (not 0x7FF) so steer=100 reaches the documented 0xFFF; steer=-100 → -1 clamps back to 0x000.
    case 0x062: { const v = Math.max(0, Math.min(0xFFF, Math.round(0x7FF + c.steer / 100 * 0x800))); return [(v >> 8) & 0xFF, v & 0xFF]; }
    case 0x077: return [c.gear === 'R' ? 0xFF : c.gear, c.joy];
    case 0x098: return [c.horn ? 1 : 0, 0];
    case 0x150: return [c.lights, 0];
    case 0x1A7: return [c.turnL ? 1 : 0, c.turnR ? 1 : 0];
    // LED status byte mirrors the actual lit LEDs, built from the control state, matching
    // ramnIngestFrame's decode. Lamp bits are cumulative by level (clearance≤low≤high).
    case 0x1BB: {
      let b = 0;
      const blink = ramnBlinkOn();
      if (c.turnL && blink) b |= 0x40;
      if (c.turnR && blink) b |= 0x80;
      if (c.handbrake || c.brake > 5) b |= 0x04;   // sidebrake / brake-pedal → rear stop lamp
      if (c.lights >= 2) b |= 0x08;   // clearance / taillamp
      if (c.lights >= 3) b |= 0x10;   // low beam
      if (c.lights >= 4) b |= 0x20;   // high beam
      return [b, 0];
    }
    case 0x1B8: return [c.key, 0];
    case 0x1D3: return [c.handbrake ? 1 : 0, 0];
    default: return [0x00, 0x00];
  }
}

// ── Frame ingest ──────────────────────────────────────────────────────────────
function ramnIngestFrame(frame) {
  if (frame.isExt) return;            // RAMN uses 11-bit IDs
  const d = frame.data, st = ramnState;
  switch (frame.id) {
    case 0x024: st.brakeRaw = be16(d) & 0xFFF; st.brake = st.brakeRaw / 0xFFF * 100; break;
    case 0x039: st.accel = (be16(d) & 0xFFF) / 0xFFF * 100; break;
    case 0x062: {                      // user spec: 0x000=L100%, 0x7FF=centre, 0xFFF=R100%
      const raw = be16(d) & 0xFFF;
      st.steer = (raw - 0x7FF) / 0x7FF * 100;
      break;
    }
    case 0x077:
      st.gear = (d[0] === 0xFF) ? 'R' : (d[0] >= 1 && d[0] <= 6 ? d[0] : null);
      st.joy  = d[1] || 1;
      break;
    case 0x098: st.horn = (d[0] || 0) !== 0; break;
    case 0x1B8: if (d[0] >= 1 && d[0] <= 3) st.key = d[0]; break;
    // 0x1A7 (turn-indicator CONTROL) deliberately does NOT drive the lit state: the indicator
    // mirrors only the 0x1BB LED-status bit. 0x1A7 is the held button command and would fight
    // 0x1BB's blink toggling, causing flicker.
    case 0x1BB: {                      // LED STATUS bitfield - authoritative lit-LED state
      const b = d[0] || 0;
      st.battery     = !!(b & 0x01);
      st.checkEngine = !!(b & 0x02);
      st.brakeLamp   = !!(b & 0x04);   // sidebrake bit - forwarded to Carlito as rear brake lamp
      st.clearance   = !!(b & 0x08);   // taillamp
      st.lowbeam     = !!(b & 0x10);
      st.highbeam    = !!(b & 0x20);
      st.turnL       = !!(b & 0x40);
      st.turnR       = !!(b & 0x80);
      st.lights      = st.highbeam ? 4 : st.lowbeam ? 3 : st.clearance ? 2 : 1; // exported for carlito.js
      break;
    }
    case 0x1D3: st.handbrake = (d[0] || 0) !== 0; break;
    default: return;                   // not a dashboard signal - skip render
  }
  dirty = true;
  // Only schedule a render when the dashboard is actually open - otherwise renderDashboard just
  // early-returns, burning one no-op rAF per ingested frame on a busy bus. setDashOpen(true) forces
  // a catch-up render on open, so the dirty flag set above isn't lost.
  if (!rafPending && win && win.classList.contains('open')) { rafPending = true; requestAnimationFrame(renderDashboard); }
}

// ── Render (rAF-throttled) ──────────────────────────────────────────────────────
const JOY = { 1: '', 2: 'Up', 3: 'Down', 4: 'Right', 5: 'Left', 6: 'Press' };
const KEYPOS = { 1: 'Off', 2: 'Acc', 3: 'Ign' };
let el = {};

function setTell(node, on, blink) {
  // Idempotent: only touch classes when the state actually flips. renderDashboard
  // runs per ingested frame (~10ms); re-toggling every frame fought the .ramn-tell
  // color/background transition and flickered the tell-tale on the ON→OFF edge.
  const wantBlink = on && !!blink;
  if (node.classList.contains('on') === on &&
      (blink === undefined || node.classList.contains('blink') === wantBlink)) return;
  node.classList.toggle('on', on);
  node.classList.toggle(node.dataset.color, on);
  if (blink !== undefined) node.classList.toggle('blink', wantBlink);
}

function renderDashboard() {
  rafPending = false;
  if (!dirty || !win.classList.contains('open')) return;
  dirty = false;
  const st = ramnState;

  el.wheel.style.transform = `rotate(${(st.steer / 100 * 150).toFixed(1)}deg)`;

  el.brakeBar.style.width = Math.max(0, Math.min(100, st.brake)) + '%';
  el.brakeV.textContent = Math.round(st.brake) + '%';
  el.accelBar.style.width = Math.max(0, Math.min(100, st.accel)) + '%';
  el.accelV.textContent = Math.round(st.accel) + '%';

  const sclamp = Math.max(-100, Math.min(100, st.steer));
  el.steerBar.style.width = Math.abs(sclamp) / 2 + '%';
  el.steerBar.style.left = sclamp >= 0 ? '50%' : (50 - Math.abs(sclamp) / 2) + '%';
  const dir = Math.abs(sclamp) < 2 ? 'C' : (sclamp < 0 ? 'L' : 'R');
  el.steerV.textContent = dir + ' ' + Math.round(Math.abs(sclamp)) + '%';

  el.gear.textContent = st.gear == null ? '–' : st.gear;
  el.gear.classList.toggle('rev', st.gear === 'R');
  el.joy.textContent = JOY[st.joy] || '';
  el.joy.classList.toggle('active', !!JOY[st.joy]);

  setTell(el.turnL, st.turnL, false);
  setTell(el.turnR, st.turnR, false);
  setTell(el.clear, st.clearance, false);
  setTell(el.low, st.lowbeam, false);
  setTell(el.high, st.highbeam, false);
  setTell(el.key, st.key >= 2, false);
  el.keyLbl.textContent = KEYPOS[st.key] || 'Off';
  // Non-standard (per request): OR the brake pedal into the parking-brake indicator.
  // Firmware's real sidebrake is 0x1BB bit 0x04 / 0x1D3 - deliberately not used here.
  setTell(el.hand, st.handbrake || st.brakeRaw > 10, false);
  setTell(el.horn, st.horn, false);
  setTell(el.batt, st.battery, false);
  setTell(el.chk, st.checkEngine, false);
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────────
function ramnClear() { ramnState = blankState(); dirty = true; requestAnimationFrame(renderDashboard); }
function ramnStop()  { ramnClear(); }

// Demo mode pairs the driving Control Panel with the dashboard (#3). Recorded when
// the core calls ramnDemoStarted(); on a live bus only the dashboard opens.
let demoEnabled = false;

function ramnIsOpen() { return win.classList.contains('open'); }

function setDashOpen(open) {
  win.classList.toggle('open', open);
  if (el.btn) el.btn.classList.toggle('active', open);
  if (open) { dashScale(win.offsetWidth || BASE_W); dirty = true; requestAnimationFrame(renderDashboard); }
}

function setCtrlOpen(open) {
  ctrlWin.classList.toggle('open', open);
  if (open) { syncCtrlUI(); ctrlScale(ctrlWin.offsetWidth || BASE_W); }
}

// Paired toolbar toggle: opens BOTH dashboard + (in demo) the Control Panel; if
// everything is already open, closes both. The window close buttons / Esc still
// close each window individually.
function ramnToggle() {
  const dashOpen = win.classList.contains('open');
  const ctrlOpen = ctrlWin.classList.contains('open');
  const allOpen = dashOpen && (!demoEnabled || ctrlOpen);
  const open = !allOpen;
  setDashOpen(open);
  if (demoEnabled) setCtrlOpen(open);
  else if (!open && ctrlOpen) setCtrlOpen(false); // stray panel safety
}

// Single toggle for the Control Panel - used by its close button + Esc only.
function ramnCtrlToggle() { setCtrlOpen(!ctrlWin.classList.contains('open')); }

// Demo started - remember it so the paired toggle includes the Control Panel. If the
// dashboard was already opened (pre-demo, no bus), pair the Control Panel in now too.
function ramnDemoStarted() {
  demoEnabled = true;
  if (win.classList.contains('open')) setCtrlOpen(true);
}

// ── Control UI sync (reflects ramnCtrl into the panel widgets) ─────────────────
let cel = {};
function syncCtrlUI() {
  cel.brake.value = ramnCtrl.brake; cel.brakeV.textContent = Math.round(ramnCtrl.brake) + '%';
  cel.accel.value = ramnCtrl.accel; cel.accelV.textContent = Math.round(ramnCtrl.accel) + '%';
  cel.steer.value = ramnCtrl.steer;
  const s = ramnCtrl.steer, dir = Math.abs(s) < 2 ? 'C' : (s < 0 ? 'L' : 'R');
  cel.steerV.textContent = dir + ' ' + Math.round(Math.abs(s)) + '%';
  cel.gearV.textContent = 'Gear ' + (ramnCtrl.gear === 'R' ? 'R' : ramnCtrl.gear);
  cel.lights.querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.val === ramnCtrl.lights));
  cel.key.querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.val === ramnCtrl.key));
  // joystick ←/→ buttons latch green while their turn signal is on
  cel.joypad.querySelector('button[data-joy="5"]').classList.toggle('on', !!ramnCtrl.turnL);
  cel.joypad.querySelector('button[data-joy="4"]').classList.toggle('on', !!ramnCtrl.turnR);
  cel.hand.classList.toggle('on', !!ramnCtrl.handbrake); cel.hand.classList.toggle('red', !!ramnCtrl.handbrake);
}

// ── Wire DOM + window mechanics ───────────────────────────────────────────────
(function wire() {
  document.body.appendChild(win);
  document.body.appendChild(ctrlWin);

  el = {
    wheel: win.querySelector('#ramnWheel'),
    brakeBar: win.querySelector('#ramnBrakeBar'), brakeV: win.querySelector('#ramnBrakeV'),
    accelBar: win.querySelector('#ramnAccelBar'), accelV: win.querySelector('#ramnAccelV'),
    steerBar: win.querySelector('#ramnSteerBar'), steerV: win.querySelector('#ramnSteerV'),
    gear: win.querySelector('#ramnGear'), joy: win.querySelector('#ramnJoy'),
    turnL: win.querySelector('#ramnTellTurnL'), turnR: win.querySelector('#ramnTellTurnR'),
    clear: win.querySelector('#ramnTellClear'), low: win.querySelector('#ramnTellLow'),
    high: win.querySelector('#ramnTellHigh'),
    key: win.querySelector('#ramnTellKey'), keyLbl: win.querySelector('#ramnKeyLbl'),
    hand: win.querySelector('#ramnTellHand'), horn: win.querySelector('#ramnTellHorn'),
    batt: win.querySelector('#ramnTellBatt'), chk: win.querySelector('#ramnTellChk'),
    btn: document.getElementById('ramnBtn')
  };

  // Window close buttons + Esc close each window individually (the toolbar button is the paired toggle).
  win.querySelector('#ramnCloseBtn').addEventListener('click', () => setDashOpen(false));
  ctrlWin.querySelector('#ramnCtrlCloseBtn').addEventListener('click', () => setCtrlOpen(false));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e._scEscHandled) return;   // shared flag: Carlito's Esc handler may have already claimed this press
    if (ctrlWin.classList.contains('open')) { e._scEscHandled = true; setCtrlOpen(false); }
    else if (win.classList.contains('open')) { e._scEscHandled = true; setDashOpen(false); }
  });

  dashScale = makeFloating({
    win, header: win.querySelector('#ramnHeader'), grip: win.querySelector('#ramnResize'),
    outer: win.querySelector('#ramnScaleOuter'), body: win.querySelector('#ramnBody'), baseW: BASE_W
  });
  ctrlScale = makeFloating({
    win: ctrlWin, header: ctrlWin.querySelector('#ramnCtrlHeader'), grip: ctrlWin.querySelector('#ramnCtrlResize'),
    outer: ctrlWin.querySelector('#ramnCtrlScaleOuter'), body: ctrlWin.querySelector('#ramnCtrlBody'), baseW: BASE_W
  });

  // ── Control widgets ──
  cel = {
    brake: ctrlWin.querySelector('#ramnCtrlBrake'), brakeV: ctrlWin.querySelector('#ramnCtrlBrakeV'),
    accel: ctrlWin.querySelector('#ramnCtrlAccel'), accelV: ctrlWin.querySelector('#ramnCtrlAccelV'),
    steer: ctrlWin.querySelector('#ramnCtrlSteer'), steerV: ctrlWin.querySelector('#ramnCtrlSteerV'),
    joypad: ctrlWin.querySelector('#ramnCtrlJoy'), gearV: ctrlWin.querySelector('#ramnCtrlGearV'),
    lights: ctrlWin.querySelector('#ramnCtrlLights'), key: ctrlWin.querySelector('#ramnCtrlKey'),
    hand: ctrlWin.querySelector('#ramnCtrlHand')
  };

  cel.brake.addEventListener('input', () => { ramnCtrl.brake = +cel.brake.value; cel.brakeV.textContent = ramnCtrl.brake + '%'; });
  cel.accel.addEventListener('input', () => { ramnCtrl.accel = +cel.accel.value; cel.accelV.textContent = ramnCtrl.accel + '%'; });
  cel.steer.addEventListener('input', () => { ramnCtrl.steer = +cel.steer.value; syncSteerLbl(); });
  function syncSteerLbl() {
    const s = ramnCtrl.steer, dir = Math.abs(s) < 2 ? 'C' : (s < 0 ? 'L' : 'R');
    cel.steerV.textContent = dir + ' ' + Math.round(Math.abs(s)) + '%';
  }
  ctrlWin.querySelector('#ramnCtrlCentre').addEventListener('click', () => { ramnCtrl.steer = 0; cel.steer.value = 0; syncSteerLbl(); });

  cel.lights.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; ramnCtrl.lights = +b.dataset.val; syncCtrlUI(); });
  cel.key.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; ramnCtrl.key = +b.dataset.val; syncCtrlUI(); });

  // Gear is driven by the shift joystick (like real RAMN): ↑ up, ↓ down.
  const GEAR_SEQ = ['R', 1, 2, 3, 4, 5, 6];
  function gearShift(delta) {
    let i = GEAR_SEQ.indexOf(ramnCtrl.gear); if (i < 0) i = 1;
    ramnCtrl.gear = GEAR_SEQ[Math.max(0, Math.min(GEAR_SEQ.length - 1, i + delta))];
  }
  // Joystick pad - momentary (sets 0x077 byte1). Side effects on press:
  // ↑/↓ shift gear, ←/→ toggle turn signal, ● horn (held). Reverts to released (1) on mouse-up.
  function joyPress(e) {
    const b = e.target.closest('button[data-joy]'); if (!b) return;
    const v = +b.dataset.joy;
    ramnCtrl.joy = v; b.classList.add('held');
    if      (v === 2) gearShift(+1);
    else if (v === 3) gearShift(-1);
    else if (v === 4) { ramnCtrl.turnR = ramnCtrl.turnR ? 0 : 1; ramnCtrl.turnL = 0; } // mutually exclusive
    else if (v === 5) { ramnCtrl.turnL = ramnCtrl.turnL ? 0 : 1; ramnCtrl.turnR = 0; } // last-pressed wins
    else if (v === 6) ramnCtrl.horn = 1;
    syncCtrlUI();
  }
  function joyRelease() {
    ramnCtrl.joy = 1; ramnCtrl.horn = 0;
    cel.joypad.querySelectorAll('button').forEach(b => b.classList.remove('held'));
  }
  cel.joypad.addEventListener('mousedown', joyPress);

  cel.hand.addEventListener('click', () => { ramnCtrl.handbrake = ramnCtrl.handbrake ? 0 : 1; syncCtrlUI(); });

  // Global mouse-up releases momentary joystick state (joy byte + horn).
  window.addEventListener('mouseup', () => {
    if (ramnCtrl.joy !== 1 || ramnCtrl.horn) { joyRelease(); syncCtrlUI(); }
  });
  // Also release on window blur (right-click context menu, alt-tab) - otherwise a missed mouse-up
  // leaves the horn/joy byte stuck on.
  window.addEventListener('blur', () => {
    if (ramnCtrl.joy !== 1 || ramnCtrl.horn) { joyRelease(); syncCtrlUI(); }
  });

  // ── Keyboard driving (panel open, not focused in a form field) ──
  const isField = t => t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  const DRIVE = {
    w: ['accel', 100], arrowup: ['accel', 100],
    s: ['brake', 100], arrowdown: ['brake', 100],
    a: ['steer', -100], arrowleft: ['steer', -100],
    d: ['steer', 100], arrowright: ['steer', 100]
  };
  document.addEventListener('keydown', e => {
    if (!ctrlWin.classList.contains('open') || isField(e.target) || e.repeat) return;
    if (e.key === ' ') { e.preventDefault(); ramnCtrl.handbrake = 1; syncCtrlUI(); return; } // Space = handbrake (momentary)
    const m = DRIVE[e.key.toLowerCase()]; if (!m) return;
    e.preventDefault();
    ramnCtrl[m[0]] = m[1];
    syncCtrlUI();
  });
  document.addEventListener('keyup', e => {
    if (!ctrlWin.classList.contains('open')) return;
    if (e.key === ' ') { ramnCtrl.handbrake = 0; syncCtrlUI(); return; } // Space released → handbrake off
    const m = DRIVE[e.key.toLowerCase()]; if (!m) return;
    ramnCtrl[m[0]] = 0;        // pedals → 0, steer → centre
    syncCtrlUI();
  });

  syncCtrlUI();
})();

// ── Expose hooks ────────────────────────────────────────────────────────────────
window.ramnIngestFrame = ramnIngestFrame;
window.ramnClear = ramnClear;
window.ramnStop = ramnStop;
window.ramnToggle = ramnToggle;
window.ramnIsOpen = ramnIsOpen;       // ← used by carlito.js (#7)
window.ramnCtrlPayload = ramnCtrlPayload;
window.ramnCtrlToggle = ramnCtrlToggle;
window.ramnDemoStarted = ramnDemoStarted;
// Live interpreted signal state (decoded from CAN - hardware or demo). Read by carlito.js.
window.ramnGetState = () => ({ ...ramnState });
