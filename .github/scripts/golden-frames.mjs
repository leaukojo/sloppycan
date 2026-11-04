// Golden frames: the exact bytes every telemetry packer, request server, driver-demand encoder and
// J1939-family demo generator produces for fixed inputs, compared against golden-frames.json.
// A refactor must leave this at zero differences; an INTENDED frame change regenerates the file
// (`node .github/scripts/smoke.mjs --update-golden`) and lists what changed and why.
//
// DETERMINISM: every capture runs in a fresh browser context (clean localStorage, so nothing an
// earlier smoke step saved leaks in), with Date.now / performance.now driven by a hand-advanced
// clock and Math.random seeded - all installed before any page script runs. --update-golden runs
// the whole capture twice and refuses to write if the two runs disagree.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), 'golden-frames.json');

// Typed out rather than generated from the contract, so a contract change cannot silently move
// the inputs. Names are the contract's out signals for each vehicle.
export const COMMON = {
  speed: 12.5, kmh: 45, throttle: 30, yaw: 0.05, accLong: 0.4, accLat: -0.2, steer: -15,
  posX: 120, posZ: -340, heading: 270, lat: 48.8566, lon: 2.3522, odo: 1234.5,
  status: 1, impact: 0, battery: 24.4,
};
export const PAYLOADS = {
  truck: {
    ...COMMON, rpm: 1400, gear: 4, slip: [0.02, 0.03], ground: true, fuel: 70, coolant: 88,
    brake_temp: 80, speed_limit: 90, pto_state: false, engine_load: 40, engine_hours: 1234.5,
    twd: 200, tws: 6, fuel_rate: 22.5, air_primary: 8, air_secondary: 7.8, retarder_state: 20,
    gear_ratio: 3.2, axle_load: 9500, body_state: 2, body_pos: 40, body_inhibit: false,
    body_bus: true, hopper_load: 35, trailer_connected: true, trailer_axle_load: 12000,
    trailer_brake_demand: 10, trailer_abs: false, trailer_vdc: false,
    status: 1 | (1 << 7) | (1 << 8) | (1 << 10),
  },
  tractor: {
    ...COMMON, rpm: 1900, gear: 6, slip: [0.08, 0.1], ground: true, fuel: 55, coolant: 92,
    brake_temp: 60, speed_limit: 40, hitch_pos_actual: 65, pto_state: true, pto_rpm: 540,
    engine_load: 72, implement_connected: true, implement_type: 6, diff_lock_state: true,
    fwd_drive_state: true, wheel_speed: 8.4, ground_speed: 7.6, wheel_slip: 9,
    engine_hours: 4321.25, draft_force: 30, twd: 90, tws: 3, fuel_rate: 18, gear_ratio: 12.5,
    axle_load: 6400, status: 1 | (1 << 3),
  },
  boat: {
    ...COMMON, fuel: 80, coolant: 75, engine_hours: 321, pitch: 1.5, roll: -3, rudder_actual: -20,
    trim: 15, awa: -45, aws: 12, twd: 310, tws: 9, stw: 6.2, sog: 6.8, cog: 265,
    current_set: 120, current_drift: 0.6, depth: 4.2, fuel_rate: 12, oil_press: 320,
    tank_level: [80, 50, 20], nav_mode_actual: 1, heading_target: 268, sail_angle: 25,
  },
  drone: {
    ...COMMON, pitch: -4, roll: 6, altitude: 42, vspeed: 1.2, agl: 38, sats: 12, fix_type: 3,
    hdop: 0.9, roll_rate: 0.1, pitch_rate: -0.05, acc_vert: 0.3, rotor_rpm: 6200,
    esc_rpm: [6100, 6200, 6250, 6300], esc_current: [12, 12.5, 13, 11.5],
    esc_temp: [45, 46, 47, 44], esc_fault: 0, pack_current: 50, soc: 76, pack_temp: 38,
    armed: true, node_health: [0, 0, 0, 0, 0, 1, 0, 0], node_online: 0xFF, mode_actual: 2,
    home_dist: 80, arming_state: 1, prearm_fail: 0, failsafe: 0, hardpoint_state: true,
    payload_weight: 0.8, gimbal_pitch_actual: -30, gimbal_yaw_actual: 10, baro_alt: 41,
    static_press: 100800, oat: 18,
  },
  train: {
    ...COMMON, pantograph_state: true, doors_state: false, catenary_volts: 24300, motor_current: 640.5,
    brake_pipe: 4.85, grade: 2, coupler_force: -35.2,
  },
  plane: {
    ...COMMON, pitch: 3, roll: -8, altitude: 250, vspeed: 2.5, roll_rate: 0.05, pitch_rate: 0.02,
    acc_vert: 0.2, flaps_actual: 40,
  },
  // Out of range, negative, huge, non-numeric, and fields missing (no rpm, no coolant, no
  // air_secondary, no awa/aws) - the clamps and the "absent writes nothing" paths.
  extremes: {
    speed: -40, kmh: 1e9, throttle: -200, yaw: 99, accLong: -1e6, accLat: 1e6, steer: 300,
    heading: 720, lat: -100, lon: 400, status: 0xFFFF, battery: -5, fuel: 'abc', gear: 99,
    slip: [2, -1], ground: false, engine_load: 1e6, engine_hours: -3, fuel_rate: -50,
    air_primary: 1e6, retarder_state: -50, gear_ratio: 1e9, axle_load: -1, speed_limit: 999,
    pto_state: true, pto_rpm: 1e6, hitch_pos_actual: -10, wheel_speed: 1e6, ground_speed: -1,
    implement_connected: true, implement_type: 999, draft_force: 1e6,
    rudder_actual: 500, trim: -500, tws: 1e6, twd: -10, stw: -1, sog: 1e9, cog: -90,
    depth: -1, oil_press: 1e9, tank_level: [150, -5, 'x'], nav_mode_actual: 9, heading_target: 1e4,
    esc_rpm: [1e9, -1, 0, 'x'], esc_current: [1e6, -1, 0, 0], esc_temp: [-300, 1e6, 0, 0],
    esc_fault: 0xFF, node_online: 0x0F, soc: 300, sats: 255, hdop: 1e6, agl: -1,
    static_press: -1, oat: 1e6, payload_weight: -1, gimbal_pitch_actual: 999,
  },
};

const DRIVE_STATES = [
  { accel: 0, brake: 0, steer: 0, gear: 0, handbrake: 0 },
  { accel: 55, brake: 0, steer: -35, gear: 3, handbrake: 0 },
  { accel: 0, brake: 80, steer: 100, gear: 'R', handbrake: 1 },
  { accel: 100, brake: 100, steer: -100, gear: 'P', handbrake: 1 },
  { accel: 150, brake: -20, steer: 250, gear: 99, handbrake: 0 },
  { accel: 'x', brake: null, steer: undefined, gear: 0xFF, handbrake: 0 },
];
const RUDDER = [-150, -100, -3.3, 0, 50, 100, 'x'];

const BASE = 1_700_000_000_000;

// Installed before any page script: the clock only moves when the capture moves it.
function installStubs(base) {
  window.__gClock = base;
  Date.now = () => window.__gClock;
  performance.now = () => window.__gClock - base + 5000;
  let s = 0x2F6E2B1;   // mulberry32
  Math.random = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Frame -> plain JSON with id/data as hex; every other key is kept, so a shape change shows.
const SERIALISE = `
  window.__gSer = (f) => {
    if (!f || typeof f !== 'object') return f;
    const o = {};
    for (const k of Object.keys(f)) {
      if (k === 'id') o.id = (f.id >>> 0).toString(16).toUpperCase().padStart(f.isExt ? 8 : 3, '0');
      else if (k === 'data') o.data = Array.from(f.data, b => (b & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join('');
      else o[k] = f[k];
    }
    return o;
  };
  window.__gHex = (d) => d ? Array.from(d, b => (b & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join('') : d;
`;

async function freshPage(browser, url) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(installStubs, BASE);
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(url, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(SERIALISE);
  return { ctx, page };
}

async function capturePayload(browser, url, t) {
  const { ctx, page } = await freshPage(browser, url);
  try {
    return await page.evaluate((t) => {
      const out = { packers: {}, requests: {} };
      for (const p of window.carlitoFlavorPackers || []) out.packers[p.flavor] = [];
      for (let i = 0; i < 24; i++) {
        window.__gClock += 50;
        const slow = i % 2 === 1;
        for (const p of window.carlitoFlavorPackers || []) {
          let fr;
          try { fr = (p.pack(t, slow) || []).map(window.__gSer); } catch (e) { fr = 'threw: ' + e.message; }
          out.packers[p.flavor].push(fr);
        }
      }
      for (const s of window.j1939RequestServers || []) {
        let d;
        try { d = window.__gHex(s.build(t)); } catch (e) { d = 'threw: ' + e.message; }
        out.requests[`${s.pgn} ${s.abbr}`] = d === undefined ? null : d;
      }
      return out;
    }, t);
  } finally { await ctx.close(); }
}

async function captureEncoders(browser, url) {
  const { ctx, page } = await freshPage(browser, url);
  try {
    return await page.evaluate((drive, rudder) => {
      const out = { drive: [], ccvs: [], rudder: [], demo: {} };
      for (const c of drive) {
        out.drive.push(window.j1939DriveFrames(c).map(window.__gSer));
        out.ccvs.push(window.__gHex(window.j1939CcvsPatch([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], c)));
      }
      for (const r of rudder) out.rudder.push(window.__gSer(window.nmea2000RudderOrderFrame(r)));
      // The J1939-family demo generators, 3 ticks each (tick 1 of ISOBUS carries the ETP burst).
      const gens = {
        j1939: () => j1939BaseDemoFrames(),
        iso11783: () => isoDemoFrames(),
        nmea2000: () => { const m = j1939ProtoMode; j1939ProtoMode = 'nmea2000'; try { return j1939DemoFrames(); } finally { j1939ProtoMode = m; } },
      };
      for (const [k, g] of Object.entries(gens)) {
        out.demo[k] = [];
        for (let i = 0; i < 3; i++) { window.__gClock += 100; out.demo[k].push(g().map(window.__gSer)); }
      }
      return out;
    }, DRIVE_STATES, RUDDER);
  } finally { await ctx.close(); }
}

async function captureAll(browser, url) {
  const out = { payloads: {} };
  for (const [name, t] of Object.entries(PAYLOADS)) out.payloads[name] = await capturePayload(browser, url, t);
  out.encoders = await captureEncoders(browser, url);
  return out;
}

// Paths where two JSON values differ, depth-first, capped.
function diff(a, b, path = '', acc = [], cap = 20) {
  if (acc.length >= cap) return acc;
  if (JSON.stringify(a) === JSON.stringify(b)) return acc;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(a[k], b[k], path + '/' + k, acc, cap);
  } else {
    acc.push(`${path}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
  return acc;
}

// The same payloads on a page that loads only some packers (carlito-bridge.html): every packer
// that page has must produce exactly index.html's golden bytes. Never writes the file.
export async function runGoldenPackers(browser, url) {
  if (!existsSync(GOLDEN)) return [`${GOLDEN} is missing - run smoke.mjs --update-golden`];
  const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const acc = [];
  for (const [name, t] of Object.entries(PAYLOADS)) {
    const got = await capturePayload(browser, url, t);
    // Every flavor in the golden file is registered on carlito-bridge.html too (its script tags load
    // all eight packers), so a missing one is a failure, not a pass.
    for (const flavor of Object.keys(want.payloads[name].packers)) {
      if (!(flavor in got.packers)) acc.push(`/payloads/${name}/packers/${flavor}: packer not registered on ${url}`);
    }
    for (const flavor of Object.keys(got.packers)) {
      diff(got.packers[flavor], want.payloads[name].packers[flavor], `/payloads/${name}/packers/${flavor}`, acc);
    }
  }
  return acc;
}

export async function runGolden(browser, url, { update = false } = {}) {
  const got = await captureAll(browser, url);
  if (update) {
    const again = await captureAll(browser, url);
    const d = diff(again, got);
    if (d.length) return ['capture is not deterministic, golden file NOT written:', ...d];
    writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n');
    console.log('golden frames written to ' + GOLDEN);
    return [];
  }
  if (!existsSync(GOLDEN)) return [`${GOLDEN} is missing - run smoke.mjs --update-golden`];
  const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  return diff(got, want);
}
