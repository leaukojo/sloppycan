// ── Carlito game link ─────────────────────────────────────────────────────────
// A floating window that embeds the Carlito Godot game (HTML5) in an <iframe> and
// pushes the RAMN-interpreted control values (accelerator / brake / steering) into
// it, so a RAMN board (or the demo) actually drives the car.
//
// Data path:
//   ramn.js  window.ramnGetState()  →  this push loop  →  iframe.postMessage(
//     {type:'carlitoInput', values:{accel,brake,steer}}, '*')
//   Carlito export head-include stashes them on window.__carlitoInput, and the
//   game's Bridge autoload feeds them into its input router (throttle/steering).
//
// Values come from ramnState (decoded from CAN), so this works with a real RAMN
// board AND with Demo + RAMN Control. No coupling beyond window.ramnGetState.
//
// INTEGRATION (sloppyCAN side, the only seams in core files):
//   index.html  <script src="carlito.js" defer>  +  #carlitoBtn toolbar button
//   ramn.js     exposes window.ramnGetState = () => ({ ...ramnState })//
// The matching game-side bridge lives in the carlito repo (src/bridge/bridge.gd +
// src/bridge/web/head_include.html); see carlito/CLAUDE.md.

(function () {
  const s = document.createElement('style');
  s.textContent = `
.carlito-window {
  position:fixed; z-index:900; top:90px; left:730px; width:480px; height:540px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden; min-width:320px; min-height:260px;
}
.carlito-window.open { display:flex; }
.carlito-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none; flex-shrink:0;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.carlito-header .dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; }
.carlito-header .title { flex:1; }
.carlito-src { color:var(--text3); text-decoration:none; font-size:10px; font-weight:500; padding:2px 4px; }
.carlito-src:hover { color:var(--text); }
/* stable | dev channel selector - which hosted Carlito build the iframe loads. */
.carlito-build { display:flex; border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.carlito-build.hidden { display:none; }
.carlito-build button {
  background:var(--bg); border:none; color:var(--text3); cursor:pointer;
  font-family:var(--sans); font-size:10px; font-weight:600; line-height:1; padding:3px 7px;
}
.carlito-build button + button { border-left:1px solid var(--border); }
.carlito-build button:hover { color:var(--text); }
.carlito-build button.on { background:var(--green-dim); color:var(--green); }
.carlito-iocaret {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:11px; line-height:1;
  padding:2px 5px; border-radius:5px;
}
.carlito-iocaret:hover { background:var(--bg); color:var(--text); }
.carlito-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.carlito-close:hover { background:var(--bg); color:var(--text); }
.carlito-bar {
  display:flex; align-items:center; gap:7px; flex-shrink:0;
  padding:6px 9px; background:var(--bg2); border-bottom:1px solid var(--border);
  font-size:11px; font-family:var(--sans);
}
.carlito-bar button {
  background:var(--bg); border:1px solid var(--border); color:var(--text2);
  border-radius:5px; padding:3px 9px; cursor:pointer; font-size:11px; white-space:nowrap;
}
.carlito-bar button:hover { background:var(--bg3); color:var(--text); }
.carlito-bar button.on { background:var(--green-dim); color:var(--green); border-color:transparent; }
.carlito-link { color:var(--text2); }
.carlito-link.on { background:var(--green-dim); color:var(--green); border-color:transparent; }
/* OUT | IN status panel: left = data sent from sloppyCAN, right = data received from Carlito. */
.carlito-io {
  display:flex; flex-shrink:0; background:var(--bg2); border-bottom:1px solid var(--border);
  font-family:var(--mono); font-size:10px;
}
.carlito-io.collapsed { display:none; }
.carlito-io-col { flex:1; padding:5px 9px; display:flex; flex-direction:column; gap:2px; }
.carlito-io-col.out { border-left:3px solid var(--green); }
.carlito-io-col.in  { border-left:3px solid var(--amber); }
.carlito-io-hdr { font-family:var(--sans); font-size:9px; font-weight:700; letter-spacing:.04em; margin-bottom:2px; }
.carlito-io-col.out .carlito-io-hdr { color:var(--green); }
.carlito-io-col.in  .carlito-io-hdr { color:var(--amber); }
.carlito-io-row { display:flex; justify-content:space-between; gap:8px; color:var(--text3); }
.carlito-io-row b { color:var(--text); font-weight:600; }
.carlito-io-col.out .carlito-io-row.applied > span::before { content:'●'; color:var(--green); font-size:6px; vertical-align:middle; margin-right:4px; }
.carlito-io-bar { height:5px; border-radius:3px; background:var(--bg); overflow:hidden; margin-top:3px; }
.carlito-io-bar > div { height:100%; width:0%; background:var(--amber); transition:width .08s linear; }
.carlito-framewrap { flex:1; position:relative; background:#000; }
.carlito-framewrap iframe { position:absolute; inset:0; width:100%; height:100%; border:0; display:block; }
.carlito-placeholder {
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  color:var(--text3); font-size:12px; text-align:center; padding:20px; line-height:1.6;
}
.carlito-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize; z-index:2;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(s);

  const win = document.createElement('div');
  win.className = 'carlito-window';
  win.id = 'carlitoWindow';
  win.innerHTML = `
    <div class="carlito-header" id="carlitoHeader">
      <span class="dot" id="carlitoDot"></span>
      <span class="title">Carlito</span>
      <span class="carlito-build" id="carlitoBuild" title="Which Carlito build to load: stable (promoted) or dev (latest)">
        <button data-build="stable">stable</button><button data-build="dev">dev</button>
      </span>
      <a class="carlito-src" id="carlitoSrc" href="https://github.com/leaukojo/carlito" target="_blank" rel="noopener" title="View source on GitHub">source ↗</a>
      <button class="carlito-close" id="carlitoClose" title="Close (Esc)">✕</button>
    </div>
    <div class="carlito-bar">
      <button id="carlitoReload" title="Reload the game">Reload</button>
      <button id="carlitoKbd" title="Block physical keyboard from reaching the game (JS bridge still drives)">⌨ on</button>
      <button class="carlito-link on" id="carlitoUp" title="Uplink: send RAMN controls into the game (SloppyCAN → Carlito)">Up ●</button>
      <button class="carlito-link on" id="carlitoDown" title="Downlink: forward the game's telemetry as CAN 0x520–0x528 (Carlito → SloppyCAN)">Down ●</button>
      <button class="carlito-iocaret" id="carlitoIoCaret" title="Show/hide debug panel">▸ debug</button>
    </div>
    <div class="carlito-io collapsed" id="carlitoIo">
      <div class="carlito-io-col out">
        <div class="carlito-io-hdr">sloppyCAN →</div>
        <div class="carlito-io-row applied"><span>accel</span><b id="co_accel">-</b></div>
        <div class="carlito-io-row applied"><span>brake</span><b id="co_brake">-</b></div>
        <div class="carlito-io-row applied"><span>steer</span><b id="co_steer">-</b></div>
        <div class="carlito-io-row applied"><span>handbrk</span><b id="co_hand">-</b></div>
        <div class="carlito-io-row applied"><span>key</span><b id="co_key">-</b></div>
        <div class="carlito-io-row applied"><span>lights</span><b id="co_lights">-</b></div>
        <div class="carlito-io-row"><span>gear</span><b id="co_gear">-</b></div>
        <div class="carlito-io-row"><span>turn</span><b id="co_turn">-</b></div>
        <div class="carlito-io-row"><span>horn</span><b id="co_horn">-</b></div>
        <div class="carlito-io-row"><span>check</span><b id="co_check">-</b></div>
        <div class="carlito-io-row"><span>batt</span><b id="co_batt">-</b></div>
        <div class="carlito-io-row"><span>brake⊥</span><b id="co_brakelamp">-</b></div>
      </div>
      <div class="carlito-io-col in">
        <div class="carlito-io-hdr">← Carlito</div>
        <div class="carlito-io-row"><span>speed</span><b id="ci_kmh">-</b></div>
        <div class="carlito-io-bar"><div id="ci_bar"></div></div>
        <div class="carlito-io-row"><span>rpm</span><b id="ci_rpm">-</b></div>
        <div class="carlito-io-row"><span>gear</span><b id="ci_gear">-</b></div>
        <div class="carlito-io-row"><span>throttle</span><b id="ci_throttle">-</b></div>
        <div class="carlito-io-row"><span>yaw</span><b id="ci_yaw">-</b></div>
        <div class="carlito-io-row"><span>accLong</span><b id="ci_acclong">-</b></div>
        <div class="carlito-io-row"><span>accLat</span><b id="ci_acclat">-</b></div>
        <div class="carlito-io-row"><span>steer</span><b id="ci_steer">-</b></div>
        <div class="carlito-io-row"><span>slip</span><b id="ci_slip">-</b></div>
        <div class="carlito-io-row"><span>ground</span><b id="ci_ground">-</b></div>
        <div class="carlito-io-row"><span>head</span><b id="ci_head">-</b></div>
        <div class="carlito-io-row"><span>pos</span><b id="ci_pos">-</b></div>
        <div class="carlito-io-row"><span>lat</span><b id="ci_lat">-</b></div>
        <div class="carlito-io-row"><span>lon</span><b id="ci_lon">-</b></div>
        <div class="carlito-io-row"><span>odo</span><b id="ci_odo">-</b></div>
        <div class="carlito-io-row"><span>status</span><b id="ci_status">-</b></div>
        <div class="carlito-io-row"><span>impact</span><b id="ci_impact">-</b></div>
        <div class="carlito-io-row"><span>fuel</span><b id="ci_fuel">-</b></div>
        <div class="carlito-io-row"><span>coolant</span><b id="ci_coolant">-</b></div>
        <div class="carlito-io-row"><span>batt</span><b id="ci_batt">-</b></div>
        <div class="carlito-io-row" style="opacity:.6"><span>CAN</span><b>520–528</b></div>
      </div>
    </div>
    <div class="carlito-framewrap" id="carlitoFrameWrap">
      <div class="carlito-placeholder" id="carlitoPlaceholder">Loading Carlito…<br>then drive it with the RAMN controls.</div>
    </div>
    <div class="carlito-resize" id="carlitoResize"></div>
    <input type="text" id="carlitoFocusSink" aria-hidden="true" tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;border:0;padding:0;left:-9999px;">
  `;

  // ── Which Carlito build to load ───────────────────────────────────────────────
  // Carlito ships two channels from one repo: `stable` (promoted, what anonymous visitors get)
  // and `dev` (latest push). Both URLs are HARDCODED here, absolute.
  // SECURITY: GAME_ORIGIN derived below is the inbound trust gate for CAN injection (frames
  // 0x520–0x528). An attacker-supplied ?carlitoUrl=https://evil.example would otherwise make
  // evil.example the trusted game and let it inject frames on a live bus. The rule that keeps that
  // shut is "the trusted cross-origin game is a constant in this file"; two constants satisfy it
  // exactly as one did, so this is a second entry, NOT a relaxation. The two channels are the same
  // origin anyway, so GAME_ORIGIN is identical either way and switching channels at runtime cannot
  // widen the gate. Absolute (not derived from location) because sloppyCAN is supported from
  // file://, where location.origin is null and a relative game path breaks.
  const GAME_URLS = {
    stable: 'https://leaukojo.github.io/carlito/stable/',
    dev:    'https://leaukojo.github.io/carlito/dev/',
  };
  // Selection: explicit ?carlitoBuild= / localStorage wins; otherwise auto-pair, so a sloppyCAN
  // served from a /dev/ path defaults to the dev game and everything else to stable.
  let BUILD = (new URLSearchParams(location.search).get('carlitoBuild') ||
               localStorage.getItem('carlitoBuild') || '').toLowerCase();
  if (BUILD !== 'stable' && BUILD !== 'dev') BUILD = /\/dev\//.test(location.pathname) ? 'dev' : 'stable';
  let GAME_URL = GAME_URLS[BUILD];
  // Override with ?carlitoUrl=<url> (e.g. ../carlito/build/web/index.html for a local export) or
  // localStorage.carlitoUrl, for contributors running Carlito locally instead of a hosted build.
  // Restricted to safe origins (same-origin, file:, or localhost); anything else falls back to the
  // hosted channel. An active override replaces both channels, so the build selector hides.
  let URL_OVERRIDDEN = false;
  const _ovr = new URLSearchParams(location.search).get('carlitoUrl') || localStorage.getItem('carlitoUrl');
  if (_ovr) {
    try {
      const u = new URL(_ovr, location.href);
      const safe = u.origin === location.origin || u.protocol === 'file:' ||
                   ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (safe) { GAME_URL = _ovr; URL_OVERRIDDEN = true; }
      else if (window.log) window.log('Ignoring carlitoUrl override (untrusted cross-origin): ' + _ovr, 'warn');
    } catch (_) { /* malformed override - keep the hosted channel */ }
  }
  const GAME_ORIGIN = new URL(GAME_URL, location.href).origin;   // postMessage target + inbound origin gate
  let iframe = null, loaded = false, upOn = true, downOn = true, rafId = null, kbdBlocked = false;
  let lastTel = null, lastTelT = 0, slowTick = false;   // last telemetry + ts + fast/slow forward toggle
  // Uplink/render are time-gated (not run every rAF). On Android the bridge runs the WebUSB read loop,
  // this push loop, the downlink drain AND a heavy WebGL game on the single main thread; rendering ~32
  // DOM writes at 60Hz into a (by-default hidden) debug panel was starving the read loop. ~33Hz is
  // plenty for control input. Safe in the full app too - controls don't need 60Hz.
  let lastPumpT = 0;
  const UPLINK_MS = 28;   // ~33–36 Hz
  const el = {};
  const OUT_IDS = ['co_accel','co_brake','co_steer','co_hand','co_key','co_lights','co_gear','co_turn','co_horn','co_check','co_batt','co_brakelamp'];
  const IN_IDS = ['ci_kmh','ci_rpm','ci_gear','ci_throttle','ci_yaw','ci_acclong','ci_acclat','ci_steer','ci_slip','ci_ground','ci_head','ci_pos','ci_lat','ci_lon','ci_odo','ci_status','ci_impact','ci_fuel','ci_coolant','ci_batt'];
  const KEY_LBL = ['', 'Off', 'Acc', 'Ign'], LIGHT_LBL = ['', 'Off', 'Clr', 'Low', 'High'];

  // ── Shared signal contract (window.CARLITO_CONTRACT, loaded before this file) ──
  // The contract (the carlito repo's contract/carlito_contract.json, synced here as carlito_contract.js)
  // is the single definition of the bridge's field names + version (plan §3). CAN frame IDs and
  // byte layout stay defined below, but are checked for coverage against it. Both sides warn on
  // version mismatch instead of failing silently.
  const CONTRACT = window.CARLITO_CONTRACT || { version: 0, signals: [] };
  const CONTRACT_VERSION = CONTRACT.version | 0;
  const CONTRACT_IN  = new Set(CONTRACT.signals.filter(s => s.dir === 'in').map(s => s.name));
  const CONTRACT_OUT = new Set(CONTRACT.signals.filter(s => s.dir === 'out' && s.status !== 'todo').map(s => s.name));
  if (!window.CARLITO_CONTRACT) console.warn('Carlito: window.CARLITO_CONTRACT missing — load carlito_contract.js before carlito.js.');
  const GEAR_R_BYTE = 0xFF;   // contract gear byte for reverse (was the v1 sentinel -1)
  let _verWarned = false, _outFieldsChecked = false;

  // Warn once if the game's contract version differs from ours (plan §3 change protocol). A game
  // that sends no version is an older build — warn too, so "old bridge omits field" is visible.
  function checkContractVersion(peerVersion) {
    if (_verWarned || peerVersion === CONTRACT_VERSION) return;
    _verWarned = true;
    const peer = (typeof peerVersion === 'number') ? ('v' + peerVersion) : 'unknown (older game)';
    console.warn(`Carlito: contract version mismatch — game ${peer} vs bridge v${CONTRACT_VERSION}; some signals may be missing or misread.`);
  }

  // Dev conformance: every field we send must be a contract "in" signal (plan §2 rule 4).
  function checkOutFields(v) {
    if (_outFieldsChecked) return;
    _outFieldsChecked = true;
    const extra = Object.keys(v).filter(k => !CONTRACT_IN.has(k));
    if (extra.length) console.warn('Carlito: OUT fields not declared "in" by the contract: ' + extra.join(', '));
  }

  function loadGame() {
    if (!iframe) {
      iframe = document.createElement('iframe');
      // Deliberately no `sandbox` attribute: the game is cross-origin so the same-origin policy
      // already isolates it from this page, and a working sandbox would need
      // allow-scripts + allow-same-origin (for WASM/WebGL/storage) - which together neuter the
      // sandbox anyway. The inbound postMessage gate (origin + source check) is the real boundary.
      iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad');
      iframe.addEventListener('load', () => { loaded = true; });
      el.wrap.appendChild(iframe);
    }
    loaded = false;
    el.placeholder.style.display = 'none';
    iframe.src = GAME_URL;
  }

  // ── Push loop: all RAMN controls → iframe (OUT), + render telemetry coming back (IN) ──
  function pump() {
    if (!win.classList.contains('open')) { rafId = null; return; }
    const now = performance.now();
    if (now - lastPumpT >= UPLINK_MS) {
      lastPumpT = now;
      let st = null;
      if (upOn && loaded && iframe && iframe.contentWindow && window.ramnGetState) {
        st = window.ramnGetState();
        // Gear byte follows the contract (0=N, 1–6=D1–D6, 0xFF=R) — same as the RAMN wire byte.
        const gearByte = st.gear === 'R' ? GEAR_R_BYTE : (+st.gear || 0);
        const v = {
          accel: +st.accel || 0, brake: +st.brake || 0, steer: +st.steer || 0,
          handbrake: st.handbrake ? 1 : 0, key: +st.key || 1, lights: +st.lights || 1,
          gear: gearByte, turnL: st.turnL ? 1 : 0, turnR: st.turnR ? 1 : 0, horn: st.horn ? 1 : 0,
          // Warning LEDs from the 0x1BB status bitfield, so Carlito's dashboard can show them.
          checkEngine: st.checkEngine ? 1 : 0, battery: st.battery ? 1 : 0,
          brakeLamp: st.brakeLamp ? 1 : 0   // 0x1BB bit 0x04 → rear stop lamp
        };
        checkOutFields(v);
        try { iframe.contentWindow.postMessage({ type: 'carlitoInput', version: CONTRACT_VERSION, values: v }, GAME_ORIGIN); } catch (e) { /* not ready */ }
      }
      // Skip the debug-panel DOM writes when it's collapsed (the default). renderOut/renderIn rewrite
      // ~32 elements that are display:none - pure main-thread waste that starves the read loop.
      if (!el.io.classList.contains('collapsed')) {
        renderOut(st);
        renderIn(now - lastTelT < 600 ? lastTel : null);
      }
    }
    rafId = requestAnimationFrame(pump);
  }

  function renderOut(st) {
    if (!st) { const t = upOn ? (loaded ? '-' : '·') : 'off'; OUT_IDS.forEach(id => el[id].textContent = t); return; }
    el.co_accel.textContent = Math.round(+st.accel || 0);
    el.co_brake.textContent = Math.round(+st.brake || 0);
    el.co_steer.textContent = Math.round(+st.steer || 0);
    el.co_hand.textContent = st.handbrake ? 'ON' : 'off';
    el.co_key.textContent = KEY_LBL[+st.key] || '-';
    el.co_lights.textContent = LIGHT_LBL[+st.lights] || '-';
    el.co_gear.textContent = st.gear === 'R' ? 'R' : (+st.gear || 0);
    el.co_turn.textContent = st.turnL && st.turnR ? 'L+R' : st.turnL ? 'L' : st.turnR ? 'R' : '-';
    el.co_horn.textContent = st.horn ? 'ON' : 'off';
    el.co_check.textContent = st.checkEngine ? 'ON' : 'off';
    el.co_batt.textContent = st.battery ? 'ON' : 'off';
    el.co_brakelamp.textContent = st.brakeLamp ? 'ON' : 'off';
  }

  function renderIn(t) {
    if (!t) {
      IN_IDS.forEach(id => el[id].textContent = '-');
      el.ci_bar.style.width = '0%';
      return;
    }
    // Values arrive in contract engineering units (plan §3): km/h, m/s, degrees, km, volts.
    el.ci_kmh.textContent = (+t.kmh || 0).toFixed(0) + ' km/h';
    el.ci_bar.style.width = Math.min(100, Math.abs(+t.speed || 0) / 40 * 100).toFixed(1) + '%';
    el.ci_rpm.textContent = (+t.rpm || 0);
    el.ci_gear.textContent = (+t.gear === GEAR_R_BYTE) ? 'R' : (+t.gear || 0);   // 0=N, 1–6, 0xFF=R
    el.ci_throttle.textContent = (+t.throttle || 0) + '%';
    el.ci_yaw.textContent = (+t.yaw || 0).toFixed(2);
    el.ci_acclong.textContent = (+t.accLong || 0).toFixed(2);
    el.ci_acclat.textContent = (+t.accLat || 0).toFixed(2);
    el.ci_steer.textContent = (+t.steer || 0) + '%';
    el.ci_slip.textContent = (+t.slip || 0).toFixed(2);
    el.ci_ground.textContent = (+t.ground || 0) ? 'yes' : 'no';
    el.ci_head.textContent = (+t.heading || 0).toFixed(0) + '°';
    el.ci_pos.textContent = (+t.posX || 0).toFixed(0) + ',' + (+t.posZ || 0).toFixed(0);
    el.ci_lat.textContent = (+t.lat || 0).toFixed(5);
    el.ci_lon.textContent = (+t.lon || 0).toFixed(5);
    el.ci_odo.textContent = (+t.odo || 0).toFixed(2) + ' km';
    el.ci_status.textContent = '0x' + ((+t.status || 0) & 0xFFFF).toString(16).toUpperCase();
    el.ci_impact.textContent = (+t.impact || 0).toFixed(1);
    el.ci_fuel.textContent = (+t.fuel || 0) + '%';
    el.ci_coolant.textContent = (+t.coolant || 0) + '°C';
    el.ci_batt.textContent = (+t.battery || 0).toFixed(1) + ' V';
  }

  // ── Return channel: Carlito → sloppyCAN telemetry ──
  // Game postMessages {type:'carlitoOutput', values:{…}} ~every 50 ms. We render it and emit CAN
  // frames 0x520–0x528 (big-endian) via window.canForward - ingested once for the dashboards and,
  // when a bus is open, transmitted on the wire and shown as a single "FW" dump entry (gateway model;
  // plain RX when no bus). Throttled in the message handler: fast IDs ~10/s, slow IDs ~5/s.
  // Big-endian fixed-point encoders. u16/i16 share byte ops (16-bit two's complement); the
  // receiver picks the interpretation. All inputs are rounded and masked to width.
  const enc = {
    u16: v => { v = Math.round(v) & 0xFFFF; return [(v >> 8) & 0xFF, v & 0xFF]; },
    i16: v => { v = Math.round(v) & 0xFFFF; return [(v >> 8) & 0xFF, v & 0xFF]; },
    u32: v => { v = Math.round(v) >>> 0; return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; },
    i8:  v => [Math.round(v) & 0xFF],
    u8:  v => [Math.round(v) & 0xFF],
  };
  // CAN layout: contract-unit telemetry → frames 0x520–0x528 (big-endian). postMessage carries
  // engineering units; the fixed-point scaling to bytes lives here (sloppyCAN's domain, per the
  // contract note). Each contract "out" signal is packed exactly once; checkCanCoverage() asserts
  // this map equals the contract's non-todo "out" set. `fast` IDs go every frame, others on `slow`.
  const CAN_MAP = [
    { id: 0x520, fast: true,  fields: [['speed', t => enc.i16((+t.speed || 0) * 100)], ['kmh', t => enc.u16((+t.kmh || 0) * 10)]] },
    { id: 0x521, fast: true,  fields: [['rpm', t => enc.u16(+t.rpm || 0)], ['gear', t => enc.u8(+t.gear || 0)], ['throttle', t => enc.i8(+t.throttle || 0)]] },
    { id: 0x522, fast: true,  fields: [['yaw', t => enc.i16((+t.yaw || 0) * 1000)], ['accLong', t => enc.i16((+t.accLong || 0) * 100)], ['accLat', t => enc.i16((+t.accLat || 0) * 100)]] },
    { id: 0x523, fast: true,  fields: [['steer', t => enc.i16(+t.steer || 0)], ['slip', t => enc.u8((+t.slip || 0) * 100)], ['ground', t => enc.u8(t.ground ? 1 : 0)]] },
    { id: 0x524, fast: false, fields: [['posX', t => enc.i16(+t.posX || 0)], ['posZ', t => enc.i16(+t.posZ || 0)], ['heading', t => enc.u16((+t.heading || 0) * 10)]] },
    { id: 0x525, fast: false, fields: [['lat', t => enc.u32((+t.lat || 0) * 1e7)], ['lon', t => enc.u32((+t.lon || 0) * 1e7)]] },
    { id: 0x526, fast: false, fields: [['odo', t => enc.u32((+t.odo || 0) * 1000)]] },
    { id: 0x527, fast: false, fields: [['status', t => enc.u16(+t.status || 0)], ['impact', t => enc.u8(+t.impact || 0)]] },
    { id: 0x528, fast: false, fields: [['fuel', t => enc.u8(+t.fuel || 0)], ['coolant', t => enc.u8(+t.coolant || 0)], ['battery', t => enc.u8((+t.battery || 0) * 10)]] },
  ];
  // One-time: the CAN map must pack exactly the contract's non-todo "out" signals (plan §3:
  // "CAN frame packing … generated/checked from the contract too").
  (function checkCanCoverage() {
    const packed = new Set(CAN_MAP.flatMap(f => f.fields.map(([sig]) => sig)));
    const missing = [...CONTRACT_OUT].filter(s => !packed.has(s));
    const extra = [...packed].filter(s => !CONTRACT_OUT.has(s));
    if (missing.length) console.warn('Carlito: CAN map missing contract out signals: ' + missing.join(', '));
    if (extra.length) console.warn('Carlito: CAN map packs signals not in contract out: ' + extra.join(', '));
  })();
  function injectTelemetry(t, slow) {
    if (!window.ingestFrame) return;
    // Gateway model: forward each telemetry frame - ingested once for the dashboards AND, when a bus
    // is open, transmitted on the wire, shown as a single "FW" dump entry. No bus ⇒ plain RX inject.
    const inj = (id, data) => {
      const frame = { id, isExt: false, isRtr: false, dlc: data.length, data };
      if (window.canForward) window.canForward(frame);
      else window.ingestFrame(frame);
    };
    for (const f of CAN_MAP) {
      if (!f.fast && !slow) continue;
      const data = [];
      for (const [, encode] of f.fields) data.push(...encode(t));
      inj(f.id, data);
    }
  }
  window.addEventListener('message', (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;          // only our game…
    if (e.origin !== GAME_ORIGIN) return;                             // …and only from the game origin - this
                                                                       // telemetry can reach the live CAN bus via canForward, so don't trust other origins
    const d = e.data;
    if (!d || d.type !== 'carlitoOutput' || !d.values) return;
    checkContractVersion(d.version);   // both sides warn on version mismatch (plan §3)
    lastTel = d.values; lastTelT = performance.now();
    // Forward at the game's native cadence: fast IDs (0x520–0x523) every message, slow/low-rate IDs
    // (0x524–0x528) every other message (the 50/100 ms fast:slow split). The bridge's drop-stale
    // backpressure self-paces to the link, so no artificial rate cap is needed.
    if (downOn && win.classList.contains('open')) {
      slowTick = !slowTick;
      injectTelemetry(lastTel, slowTick);
    }
  });
  function startPump() { if (!rafId) rafId = requestAnimationFrame(pump); }

  // ── Keyboard block: keep focus on the parent so physical keys never reach the (cross-origin) game
  // canvas. The JS/RAMN bridge still drives via postMessage. Steal focus back whenever the iframe grabs it.
  function stealFocus() {
    if (iframe) { try { iframe.blur(); } catch (e) { /* cross-origin */ } }
    if (el.focusSink) el.focusSink.focus({ preventScroll: true });
  }
  window.addEventListener('blur', () => {
    if (kbdBlocked && win.classList.contains('open') && document.activeElement === iframe) {
      setTimeout(stealFocus, 0);
    }
  });

  function carlitoIsOpen() { return win.classList.contains('open'); }

  // Set when the user clicks Carlito with no live bus; cleared once Carlito opens.
  let pendingOpen = false;
  // Called by the core when a bus/demo goes live - opens Carlito if the user asked for it.
  function carlitoBusReady() { if (pendingOpen && !win.classList.contains('open')) carlitoToggle(); }

  function carlitoToggle() {
    // Guard: opening Carlito needs a live bus/demo (#6). If none, nudge the user and
    // remember the intent so we auto-open once a bus/demo goes live (see carlitoBusReady).
    if (!win.classList.contains('open') && window.requireBusForCarlito && !window.requireBusForCarlito()) {
      pendingOpen = true;
      return;
    }
    pendingOpen = false;
    const open = win.classList.toggle('open');
    if (el.btn) el.btn.classList.toggle('active', open);
    if (open) {
      // Clamp into the viewport - the fixed default position can sit off-screen on small displays.
      const r = win.getBoundingClientRect();
      if (r.right  > window.innerWidth)  win.style.left = Math.max(8, window.innerWidth  - r.width  - 8) + 'px';
      if (r.bottom > window.innerHeight) win.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';
      // Auto-open the RAMN dashboard (+ Control Panel in demo) so controls are visible (#7).
      if (window.ramnIsOpen && !window.ramnIsOpen() && window.ramnToggle) window.ramnToggle();
      if (!iframe) loadGame();
      startPump();
    } else {
      // Fully stop the game: tear down the iframe so audio + CPU stop. Reopen reloads fresh.
      if (iframe) { iframe.remove(); iframe = null; }
      loaded = false; lastTel = null;
      if (el.placeholder) el.placeholder.style.display = '';
    }
    if (window.updateTermTrafficWarn) window.updateTermTrafficWarn(); // refresh serial-tab warning (#9)
  }

  // ── Wire ──
  (function wire() {
    document.body.appendChild(win);
    el.wrap = win.querySelector('#carlitoFrameWrap');
    el.placeholder = win.querySelector('#carlitoPlaceholder');
    [...OUT_IDS, ...IN_IDS, 'ci_bar'].forEach(id => el[id] = win.querySelector('#' + id));
    el.up = win.querySelector('#carlitoUp');
    el.down = win.querySelector('#carlitoDown');
    el.dot = win.querySelector('#carlitoDot');
    el.io = win.querySelector('#carlitoIo');
    el.ioCaret = win.querySelector('#carlitoIoCaret');
    el.kbd = win.querySelector('#carlitoKbd');
    el.focusSink = win.querySelector('#carlitoFocusSink');
    el.btn = document.getElementById('carlitoBtn');
    el.kbd.classList.toggle('on', kbdBlocked);   // keyboard ENABLED by default (not blocked)

    win.querySelector('#carlitoClose').addEventListener('click', carlitoToggle);
    win.querySelector('#carlitoReload').addEventListener('click', loadGame);

    // Channel selector. Hidden when a carlitoUrl override is in effect - the override replaces both
    // channels, so offering the choice would lie about what is loaded.
    el.build = win.querySelector('#carlitoBuild');
    el.build.classList.toggle('hidden', URL_OVERRIDDEN);
    function syncBuildButtons() {
      el.build.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.build === BUILD));
    }
    syncBuildButtons();
    el.build.addEventListener('click', e => {
      const b = e.target.dataset && e.target.dataset.build;
      if (!b || b === BUILD) return;
      BUILD = b;
      GAME_URL = GAME_URLS[b];
      try { localStorage.setItem('carlitoBuild', b); } catch (_) { /* storage blocked - session only */ }
      syncBuildButtons();
      if (window.log) window.log('Carlito: loading ' + b + ' build (' + GAME_URL + ')');
      if (iframe) loadGame();
    });
    el.ioCaret.addEventListener('click', () => {
      const collapsed = el.io.classList.toggle('collapsed');
      el.ioCaret.textContent = (collapsed ? '▸' : '▾') + ' debug';
    });
    el.kbd.addEventListener('click', () => {
      kbdBlocked = !kbdBlocked;
      el.kbd.textContent = kbdBlocked ? '⌨ off' : '⌨ on';
      el.kbd.classList.toggle('on', kbdBlocked);
      if (kbdBlocked) stealFocus();
    });
    // Uplink (SloppyCAN → Carlito control push) and Downlink (Carlito → SloppyCAN telemetry
    // forward) toggle independently. The header dot is green if either direction is live.
    function syncLinkDot() { el.dot.style.background = (upOn || downOn) ? 'var(--green)' : 'var(--text3)'; }
    el.up.addEventListener('click', () => {
      upOn = !upOn;
      el.up.classList.toggle('on', upOn);
      el.up.innerHTML = upOn ? 'Up ●' : 'Up ○';
      syncLinkDot();
    });
    el.down.addEventListener('click', () => {
      downOn = !downOn;
      el.down.classList.toggle('on', downOn);
      el.down.innerHTML = downOn ? 'Down ●' : 'Down ○';
      syncLinkDot();
    });
    // Esc closes only the topmost floating window: the first handler to act marks the shared event
    // so RAMN's independent Esc handler (and vice-versa) doesn't also fire and close two windows.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !e._scEscHandled && win.classList.contains('open')) { e._scEscHandled = true; carlitoToggle(); }
    });

    // Drag (header) - moves the window
    const header = win.querySelector('#carlitoHeader');
    let dg = false, sx = 0, sy = 0, sl = 0, st0 = 0;
    header.addEventListener('mousedown', e => {
      if (e.target.closest('.carlito-close')) return;
      e.preventDefault();
      dg = true; sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect(); sl = r.left; st0 = r.top;
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', e => {
      if (!dg) return;
      let nl = Math.max(0, Math.min(window.innerWidth - 40, sl + (e.clientX - sx)));
      let nt = Math.max(0, Math.min(window.innerHeight - 30, st0 + (e.clientY - sy)));
      win.style.left = nl + 'px'; win.style.top = nt + 'px';
    });
    window.addEventListener('mouseup', () => { if (dg) { dg = false; document.body.style.userSelect = ''; } });

    // Resize (grip) - real width/height so the game canvas gets real pixels.
    // An overlay during drag stops the iframe from swallowing mouse events.
    const grip = win.querySelector('#carlitoResize');
    let rz = false, rsx = 0, rsy = 0, rsw = 0, rsh = 0, rsl = 0, rst = 0, shield = null;
    grip.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      rz = true; rsx = e.clientX; rsy = e.clientY; rsw = win.offsetWidth; rsh = win.offsetHeight;
      const r = win.getBoundingClientRect(); rsl = r.left; rst = r.top;
      document.body.style.cursor = 'nwse-resize'; document.body.style.userSelect = 'none';
      shield = document.createElement('div');
      shield.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:nwse-resize';
      document.body.appendChild(shield);
    });
    window.addEventListener('mousemove', e => {
      if (!rz) return;
      // Clamp both ends (min size + viewport-bounded max from the window's top-left), so it can't be
      // dragged larger than the screen. (RAMN's makeFloating already clamps both ends.)
      const maxW = Math.max(320, window.innerWidth  - rsl - 8);
      const maxH = Math.max(260, window.innerHeight - rst - 8);
      win.style.width  = Math.min(maxW, Math.max(320, rsw + (e.clientX - rsx))) + 'px';
      win.style.height = Math.min(maxH, Math.max(260, rsh + (e.clientY - rsy))) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!rz) return;
      rz = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
      if (shield) { shield.remove(); shield = null; }
    });
  })();

  window.carlitoToggle = carlitoToggle;
  window.carlitoIsOpen = carlitoIsOpen;   // ← used by the serial-tab traffic warning (#9)
  window.carlitoBusReady = carlitoBusReady; // ← core calls this when a bus/demo goes live
  // True only for a message whose source IS our game iframe. Lets the standalone bridge add the
  // same e.source check this file's own inbound listener uses (defence-in-depth for its boot probe).
  window.carlitoIsGameFrame = (w) => !!iframe && w === iframe.contentWindow;
})();
