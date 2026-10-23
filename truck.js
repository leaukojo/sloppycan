// ── Truck dashboard ─────────────────────────────────────────────────────────
// One floating window, following the Carlito link through vehicle-panel.js. Takes 'dash':
// a truck is driven with the RAMN controls, so it replaces the cluster and the Control Panel
// keeps driving. Claims no uplink signal and owns none: its Commands section is a view over the
// modules that do - isobus.js (pto), cleanopen.js (body_cmd), j1939-flavor.js (retarder).
//
// A STARTING POINT: currently the RAMN cluster verbatim, off window.ramnGetState(). The
// signals that belong here are air_primary / air_secondary / retarder_state / axle_load /
// body_state / trailer_*, and they arrive in the payload this file is already handed.
//
// Integration: index.html (script after vehicle-panel.js; #truckBtn ships style="display:none",
// vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list). Live-only.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.truck-window {
  position:fixed; z-index:900; top:72px; left:90px; width:300px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.truck-window.open { display:flex; }
.truck-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.truck-header .truck-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; }
.truck-header .truck-title { flex:1; }
.truck-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.truck-close:hover { background:var(--bg); color:var(--text); }
.truck-scaleouter { overflow:hidden; }
.truck-body { width:300px; transform-origin:top left; padding:14px 14px 16px; box-sizing:border-box; }

/* Top row: steering wheel + gear */
.truck-top { display:flex; align-items:center; gap:14px; margin-bottom:14px; }
.truck-wheel { width:80px; height:80px; color:var(--text2); flex-shrink:0; transition:transform .08s linear; }
.truck-gearbox { flex:1; text-align:center; }
.truck-gearcap { font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:4px; }
.truck-gearbadge {
  display:inline-flex; align-items:center; justify-content:center; min-width:56px;
  padding:5px 14px; border:1px solid var(--border2); border-radius:9px; background:var(--bg);
}
.truck-gear { font-family:var(--mono); font-size:38px; font-weight:500; line-height:1; color:var(--text); }
.truck-gear.rev { color:var(--amber); }
.truck-joy { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); margin-top:6px; min-height:12px; }
.truck-joy.active { color:var(--blue); }

/* Pedal + steer bars */
.truck-bar-row { margin-bottom:9px; }
.truck-bar-head { display:flex; justify-content:space-between; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:3px; }
.truck-bar-head .v { font-family:var(--mono); color:var(--text); letter-spacing:0; }
.truck-bar { height:9px; background:var(--bg); border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.truck-bar > i { display:block; height:100%; width:0%; border-radius:4px; transition:width .08s linear; }
.truck-bar.brake > i { background:var(--red); }
.truck-bar.accel > i { background:var(--green); }
/* Steering: centre-origin bar */
.truck-steer { position:relative; height:9px; background:var(--bg); border:1px solid var(--border); border-radius:5px; }
.truck-steer::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--border2); }
.truck-steer > i { position:absolute; top:0; bottom:0; left:50%; width:0%; background:var(--blue); border-radius:3px; transition:all .08s linear; }

/* Tell-tale grid */
.truck-tells {
  display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:14px;
  border-top:1px solid var(--border); padding-top:12px;
}
.truck-tell {
  display:flex; flex-direction:column; align-items:center; gap:3px;
  padding:6px 2px; border-radius:8px; background:var(--bg); color:var(--text3);
  transition:color .1s, background .1s;
}
.truck-tell svg { width:22px; height:22px; }
.truck-tell .lbl { font-size:8px; text-transform:uppercase; letter-spacing:.05em; text-align:center; line-height:1.2; }
.truck-tell.on.green { color:var(--green); background:var(--green-dim); }
.truck-tell.on.blue  { color:var(--blue);  background:var(--blue-dim); }
.truck-tell.on.amber { color:var(--amber); background:var(--amber-dim); }
.truck-tell.on.red   { color:var(--red);   background:var(--red-dim); }

/* Commands: views over the modules that own them (isobus.js, j1939-flavor.js, cleanopen.js) */
.truck-ctl { margin-top:12px; border-top:1px solid var(--border); padding-top:10px; }
.truck-ctl-cap { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:8px; }
.truck-ctl-cap .bus-key { color:var(--amber); letter-spacing:.06em; }
.truck-ctl-row { display:flex; align-items:center; gap:6px; margin-bottom:7px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); }
.truck-ctl-row .lbl { width:52px; flex-shrink:0; }
.truck-ctl-row input[type=range] { flex:1; min-width:0; }
.truck-ctl-row .v { font-family:var(--mono); color:var(--text); letter-spacing:0; width:44px; text-align:right; flex-shrink:0; }
.truck-ctl-row button {
  padding:4px 7px; font-size:10px; font-family:var(--sans); text-transform:uppercase; letter-spacing:.06em;
  color:var(--text2); background:var(--bg); border:1px solid var(--border); border-radius:6px; cursor:pointer;
}
.truck-ctl-row button.on { color:var(--green); border-color:var(--green); background:var(--green-dim); }
.truck-ctl .bus { outline:1px solid var(--amber); outline-offset:1px; }

.truck-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(style);

  const BASE_W = 300;
  const PANEL_ID = 'truck';
  const FAMILY = 'truck';
  const VARIANT = 'semi';            // VehicleCatalog.VARIANTS id, not the family
  const LABEL = 'truck';

  // ── Window DOM ──────────────────────────────────────────────────────────────
  const win = document.createElement('div');
  win.className = 'truck-window';
  win.id = 'truckWindow';
  win.innerHTML = `
  <div class="truck-header" id="truckHeader" title="The truck's cluster. Opens by itself when a truck appears on the Carlito link and takes the RAMN dashboard's place while it is up; the RAMN Control Panel stays, because a truck is driven with the same pedals and gearbox. Drag to move, grip the bottom-right corner to resize.">
    <span class="truck-dot"></span>
    <span class="truck-title">Truck dashboard</span>
    <button class="truck-close" id="truckCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="truck-scaleouter" id="truckScaleOuter">
   <div class="truck-body" id="truckBody">
    <div class="truck-top">
      <svg class="truck-wheel" id="truckWheel" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round">
        <circle cx="50" cy="50" r="44"/>
        <circle cx="50" cy="50" r="10" fill="currentColor" stroke="none"/>
        <path d="M50 50 H94 M50 50 H6 M50 50 V94"/>
      </svg>
      <div class="truck-gearbox">
        <div class="truck-gearcap">Gear</div>
        <div class="truck-gearbadge"><span class="truck-gear" id="truckGear">&ndash;</span></div>
        <div class="truck-joy" id="truckJoy"></div>
      </div>
    </div>

    <div class="truck-bar-row">
      <div class="truck-bar-head"><span>Brake</span><span class="v" id="truckBrakeV">0%</span></div>
      <div class="truck-bar brake"><i id="truckBrakeBar"></i></div>
    </div>
    <div class="truck-bar-row">
      <div class="truck-bar-head"><span>Accel</span><span class="v" id="truckAccelV">0%</span></div>
      <div class="truck-bar accel"><i id="truckAccelBar"></i></div>
    </div>
    <div class="truck-bar-row">
      <div class="truck-bar-head"><span>Steer</span><span class="v" id="truckSteerV">C 0%</span></div>
      <div class="truck-steer"><i id="truckSteerBar"></i></div>
    </div>

    <div class="truck-tells">
      <div class="truck-tell" id="truckTellTurnL" data-color="green">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="15,4 5,12 15,20"/></svg>
        <span class="lbl">Left</span>
      </div>
      <div class="truck-tell" id="truckTellTurnR" data-color="green">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="9,4 19,12 9,20"/></svg>
        <span class="lbl">Right</span>
      </div>
      <div class="truck-tell" id="truckTellClear" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="10.5" y="7" width="3" height="10" rx="1.5" fill="currentColor" stroke="none"/>
          <path d="M8 8 L4 6.5M8 12 H4M8 16 L4 17.5"/>
          <path d="M16 8 L20 6.5M16 12 H20M16 16 L20 17.5"/>
        </svg>
        <span class="lbl">Clearance</span>
      </div>
      <div class="truck-tell" id="truckTellLow" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6c5.5 0 5.5 12 0 12 a6 6 0 0 0 0-12z" fill="currentColor" stroke="none"/>
          <path d="M14 8 l6 1M14 12 l6 1M14 16 l6 1"/>
        </svg>
        <span class="lbl">Low beam</span>
      </div>
      <div class="truck-tell" id="truckTellHigh" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6c5.5 0 5.5 12 0 12 a6 6 0 0 0 0-12z" fill="currentColor" stroke="none"/>
          <path d="M14 8 h6M14 12 h6M14 16 h6"/>
        </svg>
        <span class="lbl">High</span>
      </div>
      <div class="truck-tell" id="truckTellKey" data-color="green">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="8" cy="8" r="4"/><path d="M11 11 l8 8M16 16 l2-2M18 18 l2-2"/>
        </svg>
        <span class="lbl" id="truckKeyLbl">Off</span>
      </div>
      <div class="truck-tell" id="truckTellHand" data-color="red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/><path d="M7 12 h10" stroke-linecap="round"/>
          <text x="12" y="10" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">P</text>
        </svg>
        <span class="lbl">Brake</span>
      </div>
      <div class="truck-tell" id="truckTellHorn" data-color="amber">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 9 h4 l6-4 v14 l-6-4 H3 z"/>
          <path d="M17 8 a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span class="lbl">Horn</span>
      </div>
      <div class="truck-tell" id="truckTellBatt" data-color="red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="3" y="8" width="18" height="10" rx="1.5"/>
          <path d="M7 6 v2M7 5 h3M16 6 v2M14.5 7 h3"/>
        </svg>
        <span class="lbl">Batt</span>
      </div>
      <div class="truck-tell" id="truckTellChk" data-color="amber">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
          <path d="M4 11 V9 h2 V7 h3 l2-2 h3 v2 h2 l2 2 v2 h-1 v5 h-2 v-2 h-8 v2 H6 v-5 z"/>
        </svg>
        <span class="lbl">Check</span>
      </div>
    </div>

    <div class="truck-ctl" title="The truck's commands, sent to Carlito over the uplink. Each is owned by the module for its bus, and the PTO and body command are also read off the bus: while a frame is holding one it is ringed amber, and touching the control takes it back. The trailer lamps are injected from the J1939 tab, beside the DM1 lamps.">
      <div class="truck-ctl-cap"><span>Commands</span><span class="bus-key">amber = held by the bus</span></div>
      <div class="truck-ctl-row">
        <span class="lbl">PTO</span>
        <button id="truckCtlPto" title="contract pto - the chassis PTO that drives the body. Shared with the tractor and owned with it by isobus.js. Bus: PGN 65090 SPN 1894.">Engage</button>
      </div>
      <div class="truck-ctl-row" title="contract body_cmd - the refuse body command on the CiA 422 body network (cleanopen.js). Bus: CANopen RPDO1 of body node 0x10 (COB-ID 0x210), byte 0, held only while it keeps arriving.">
        <span class="lbl">Body</span><span id="truckCtlBody"></span>
      </div>
      <div class="truck-ctl-row" title="contract retarder - driveline retarder request, 0 released (j1939-flavor.js). Panel only: its J1939 carrier (TSC1 to the retarder) has no decoder here yet.">
        <span class="lbl">Retarder</span><input type="range" id="truckCtlRet" min="0" max="100" value="0"><span class="v" id="truckCtlRetV">0%</span>
      </div>
    </div>
   </div>
  </div>
  <div class="truck-resize" id="truckResize"></div>
`;

  // ── State ───────────────────────────────────────────────────────────────────
  let tel = null;               // last telemetry pushed (null = link gone)
  let live = false;             // a truck is on the link
  let autoOpened = false;       // opened BY the telemetry, not by hand
  let scale = () => {};
  let rafPending = false;
  let el = {};

  const isOpen = () => win.classList.contains('open');

  const JOY = { 1: '', 2: 'Up', 3: 'Down', 4: 'Right', 5: 'Left', 6: 'Press' };
  const KEYPOS = { 1: 'Off', 2: 'Acc', 3: 'Ign' };
  const BLANK = { brake: 0, accel: 0, steer: 0, gear: null, joy: 1, horn: false, key: 1,
                  turnL: false, turnR: false, handbrake: false, battery: false, checkEngine: false,
                  clearance: false, lowbeam: false, highbeam: false, brakeRaw: 0 };
  const state = () => (window.ramnGetState ? window.ramnGetState() : BLANK);

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
    markDirty();
  });

  // ── Window open / close ─────────────────────────────────────────────────────
  function setOpen(open) {
    if (isOpen() === open) return;
    win.classList.toggle('open', open);
    if (open) { scale(win.offsetWidth || BASE_W); markDirty(); }
    const b = document.getElementById('truckBtn');
    if (b) b.classList.toggle('active', open);
    if (window.vehiclePanelClaim) window.vehiclePanelClaim(PANEL_ID, open, 'dash');
  }
  function truckToggle() {
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

  function render() {
    if (!isOpen()) return;
    // No truck on the link → the resting cluster, not the last one's readings frozen.
    const st = (live && tel) ? state() : BLANK;

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

    setTell(el.turnL, st.turnL);
    setTell(el.turnR, st.turnR);
    setTell(el.clear, st.clearance);
    setTell(el.low, st.lowbeam);
    setTell(el.high, st.highbeam);
    setTell(el.key, st.key >= 2);
    el.keyLbl.textContent = KEYPOS[st.key] || 'Off';
    setTell(el.hand, st.handbrake || st.brakeRaw > 10);
    setTell(el.horn, st.horn);
    setTell(el.batt, st.battery);
    setTell(el.chk, st.checkEngine);
    renderCtl();
  }

  // ── Commands ────────────────────────────────────────────────────────────────
  // A view over the modules that own the truck's commands: the PTO is isobus.js's (shared with
  // the tractor), the body command cleanopen.js's, the retarder j1939-flavor.js's. The first two
  // are also read off the bus - a control a frame is holding right now is ringed amber, and
  // touching it takes it back. Rendered with the cluster, on the telemetry push and after every
  // click.
  const ctl = () => ({
    ib: window.isobusCtl ? window.isobusCtl() : null,
    co: window.cleanopenCtl ? window.cleanopenCtl() : null,
    jf: window.j1939FlavorCtl ? window.j1939FlavorCtl() : null,
  });
  const setCtl = (fn, p) => { if (window[fn]) window[fn](p); markDirty(); };
  function renderCtl() {
    const c = ctl();
    if (c.ib) { el.pto.classList.toggle('on', !!c.ib.pto); el.pto.classList.toggle('bus', c.ib.bus.pto); }
    if (c.co) {
      for (const b of el.body.querySelectorAll('button')) {
        const on = Number(b.dataset.body) === c.co.body_cmd;
        b.classList.toggle('on', on);
        b.classList.toggle('bus', on && c.co.bus.body_cmd);
      }
    }
    if (c.jf) {
      if (document.activeElement !== el.ret) el.ret.value = c.jf.retarder;
      el.retV.textContent = c.jf.retarder + '%';
    }
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    document.body.appendChild(win);
    const q = (id) => win.querySelector('#' + id);
    el = {
      wheel: q('truckWheel'), gear: q('truckGear'), joy: q('truckJoy'),
      brakeBar: q('truckBrakeBar'), brakeV: q('truckBrakeV'),
      accelBar: q('truckAccelBar'), accelV: q('truckAccelV'),
      steerBar: q('truckSteerBar'), steerV: q('truckSteerV'),
      turnL: q('truckTellTurnL'), turnR: q('truckTellTurnR'), clear: q('truckTellClear'),
      low: q('truckTellLow'), high: q('truckTellHigh'), key: q('truckTellKey'),
      keyLbl: q('truckKeyLbl'), hand: q('truckTellHand'), horn: q('truckTellHorn'),
      batt: q('truckTellBatt'), chk: q('truckTellChk'),
      pto: q('truckCtlPto'), body: q('truckCtlBody'), ret: q('truckCtlRet'), retV: q('truckCtlRetV'),
    };

    // The body command's positions come off the CONTRACT's enum rather than being typed here.
    const bodySig = ((window.CARLITO_CONTRACT || {}).signals || []).find(s => s.name === 'body_cmd' && s.dir === 'in');
    for (const [v, name] of Object.entries((bodySig && bodySig.enum) || {})) {
      const b = document.createElement('button');
      b.dataset.body = v;
      b.textContent = name;
      b.addEventListener('click', () => setCtl('cleanopenSetCtl', { body_cmd: Number(v) }));
      el.body.appendChild(b);
    }
    el.pto.addEventListener('click', () => { const c = ctl().ib; setCtl('isobusSetCtl', { pto: c && c.pto ? 0 : 1 }); });
    el.ret.addEventListener('input', () => setCtl('j1939FlavorSetCtl', { retarder: +el.ret.value }));

    q('truckCloseBtn').addEventListener('click', () => { autoOpened = false; setOpen(false); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; autoOpened = false; setOpen(false);
    });

    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: q('truckHeader'), grip: q('truckResize'),
        outer: q('truckScaleOuter'), body: q('truckBody'),
        baseW: BASE_W, closeSel: '.truck-close',
      });
    } else {
      console.warn('Truck panel: makeFloating is missing - load ramn.js before truck.js.');
    }

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: PANEL_ID, family: FAMILY, variant: VARIANT, label: LABEL,
        btn: 'truckBtn', isOpen,
        close: () => { autoOpened = false; setOpen(false); },
      });
    }
  })();

  window.truckToggle = truckToggle;
})();
