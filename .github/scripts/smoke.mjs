// Headless-Chrome smoke test: the pages load clean, every module self-test passes (fresh and
// after demo traffic), each demo base traffic runs, and telemetry reaches the frame table.
//
//   npm install --no-save --no-package-lock puppeteer
//   node .github/scripts/smoke.mjs [repo-root] [--update-golden]
//
// repo-root defaults to the checkout this script lives in; pass a copy to prove a check fails.
// --update-golden rewrites golden-frames.json after an INTENDED frame change (see golden-frames.mjs).
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { runGolden, runGoldenPackers, PAYLOADS, COMMON } from './golden-frames.mjs';

const ARGS = process.argv.slice(2);
const UPDATE_GOLDEN = ARGS.includes('--update-golden');
const ROOT = resolve(ARGS.find(a => !a.startsWith('--')) || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const url = (f) => pathToFileURL(resolve(ROOT, f)).href;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Console errors that are not the page's fault. Keep this short and say why for each.
const CONSOLE_ALLOW = [
  // Google Fonts is the one external dependency; a runner without network fails to fetch it.
  (text, loc) => /fonts\.(googleapis|gstatic)\.com/.test(loc || '') || /fonts\.(googleapis|gstatic)\.com/.test(text),
  // A failing self-test also console.error()s its list; runSelfTests reports each failure itself.
  (text) => /self-test: \d+ failure/.test(text),
];

const failures = [];
const fail = (where, what) => failures.push(`[${where}] ${what}`);

const browser = await puppeteer.launch({
  headless: true,
  // GitHub's Ubuntu runners cannot start Chrome's sandbox.
  args: process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
});

// One tab, re-used; `where` names the step that is running so a failure says where it came from.
let where = 'setup';
const page = await browser.newPage();
page.on('pageerror', (e) => fail(where, 'page error: ' + (e && e.message || e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const loc = m.location() && m.location().url;
  if (CONSOLE_ALLOW.some(ok => ok(m.text(), loc))) return;
  fail(where, 'console error: ' + m.text() + (loc ? ` (${loc})` : ''));
});
// Nothing this test does should prompt. Dismiss whatever does, and count it as a failure.
page.on('dialog', async (d) => {
  fail(where, `unexpected ${d.type()}: ${d.message()}`);
  await d.dismiss().catch(() => {});
});

async function load(file) {
  await page.goto(url(file), { waitUntil: 'load' });
  await sleep(300);   // let deferred modules finish their load-time work
}

// Every window.*SelfTest on the page. Return shapes differ (an array of failures, or
// { pass, failures }); both are normalised to a list here.
// `expected` filters failures a page is known to produce (see the bridge page below).
//
// HERMETICITY IS CHECKED, not assumed: each test runs twice and must give the same answer, and
// every form control's value, dcCfg and (with `sources`) every carlitoUplinkSources value must
// read the same after the run as before it. `sources` is off once demo traffic is running,
// because a bus-held command can expire on its own TTL while the tests run.
async function runSelfTests(label, expected = null, sources = true) {
  where = label;
  const res = await page.evaluate((sources) => {
    const snap = () => {
      const s = {};
      document.querySelectorAll('input, select, textarea').forEach((el, i) => {
        if (el.type === 'file') return;
        s['control ' + (el.id || el.name || '#' + i)] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
      });
      if (typeof dcCfg !== 'undefined') s['dcCfg'] = JSON.stringify(dcCfg);
      if (sources) for (const k of Object.keys(window.carlitoUplinkSources || {})) {
        try { s['source ' + k] = String(JSON.stringify(window.carlitoUplinkSources[k]())); } catch (e) { s['source ' + k] = 'threw'; }
      }
      return s;
    };
    const norm = (v) => Array.isArray(v) ? v : (v && v.failures) || (v && v.pass === false ? ['failed'] : []);
    const call = (k) => { try { return norm(window[k]()); } catch (e) { return ['threw: ' + (e && e.stack || e)]; } };
    const before = snap();
    const out = {}, unstable = [];
    for (const k of Object.keys(window).filter(k => /SelfTest$/.test(k) && typeof window[k] === 'function')) {
      out[k] = call(k);
      // First lines only: a throw's stack names the call site, which differs between the two runs.
      const key = (r) => JSON.stringify(r.map(f => String(f).split('\n')[0]));
      if (key(call(k)) !== key(out[k])) unstable.push(k);
    }
    const after = snap();
    const changed = Object.keys(before).filter(k => before[k] !== after[k]).map(k => `${k}: ${before[k]} -> ${after[k]}`);
    return { out, unstable, changed };
  }, sources);
  const names = Object.keys(res.out);
  if (!names.length) fail(label, 'no window.*SelfTest functions found');
  for (const n of names) for (const f of res.out[n]) if (!(expected && expected.test(f))) fail(label, `${n}: ${f}`);
  for (const n of res.unstable) fail(label, `${n} gave a different answer on a second run (order-dependent)`);
  for (const c of res.changed) fail(label, `self-tests left state changed - ${c}`);
  return names;
}

// Every name an inline on*="..." handler calls must be a function ON WINDOW - the static check
// only proves it is declared somewhere, which a function private to a module's IIFE also is.
// Run on the live DOM, so rows the page has rendered by now are covered too.
async function checkHandlers(label) {
  const missing = await page.evaluate(() => {
    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'function', 'typeof', 'new', 'catch']);
    const out = new Set();
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        if (!attr.startsWith('on')) continue;
        const code = el.getAttribute(attr);
        for (const m of code.matchAll(/(^|[^\w$.]|window\.)([A-Za-z_$][\w$]*)\s*\(/g)) {
          if (!KEYWORDS.has(m[2]) && typeof window[m[2]] !== 'function') out.add(`${attr}="${code}" calls ${m[2]}()`);
        }
      }
    }
    return [...out];
  });
  for (const m of missing) fail(label, `inline handler ${m}, which is not a function on window`);
}

// A packer that throws is skipped with a console.warn, not an error, so it is caught here.
page.on('console', (m) => {
  if (m.type() === 'warn' && /packer threw/.test(m.text())) fail(where, 'console warning: ' + m.text());
  // carlito.js names every flavor no loaded module packs or declares; on either page that is a gap.
  if (m.type() === 'info' && /nothing loaded to pack or declare/.test(m.text())) fail(where, 'console info: ' + m.text());
});

// ── 1. Page loads ────────────────────────────────────────────────────────────
where = 'load carlito-bridge.html';
await load('carlito-bridge.html');
// The bridge loads the packer modules without j1939.js, so two self-tests report the round
// trip they could not run there - by design, in words that say so. Anything else is a failure.
const bridgeTests = await runSelfTests('self-tests (carlito-bridge.html)', /j1939\.js is not loaded on this page/);
console.log('bridge self-tests found: ' + bridgeTests.join(', '));
await checkHandlers('handlers (carlito-bridge.html)');

// ── 1b. The bridge downlink sends every frame it was given ────────────────────
// carlito-bridge.js coalesces stale telemetry by id. A Fast Packet or DroneCAN multi-frame
// transfer sends every frame under one id (so do 127505's tank instances), so coalescing that
// keeps one frame per id corrupts every one of them. With a fake open SLCAN port whose send
// resolves at once (no timer, so a slow runner cannot make a batch go stale before the next
// message), nothing is stale: every frame canForward is handed must go out. Two messages per
// payload, because the slow ids ride every other one.
where = 'bridge downlink';
const lost = await page.evaluate(async (P) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const sent = [], wanted = [];
  busIsOpen = true; port = {}; connMode = 'serial';
  document.getElementById('listenOnly').checked = false;
  sendCommand = async (line) => { sent.push(line); };
  const fwd = window.canForward;
  window.canForward = (f) => { wanted.push((f.id >>> 0).toString(16)); return fwd(f); };
  const lineId = (l) => parseInt(l[0] === 'T' ? l.slice(1, 9) : l.slice(1, 4), 16).toString(16);
  const count = (a) => a.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  const out = [];
  for (const name of ['boat', 'drone']) {
    sent.length = 0; wanted.length = 0;
    for (let i = 0; i < 2; i++) { window.carlitoDebugInjectTelemetry(P[name]); await sleep(300); }
    window.carlitoDebugInjectTelemetry(null);
    const w = count(wanted), s = count(sent.map(lineId));
    for (const id of Object.keys(w)) if (w[id] !== (s[id] || 0)) out.push(`${name}: id 0x${id.toUpperCase()} - ${w[id]} frame(s) forwarded, ${s[id] || 0} sent`);
    if (!wanted.length) out.push(`${name}: nothing was forwarded`);
  }
  window.canForward = fwd;
  return out;
}, PAYLOADS);
for (const l of lost) fail(where, l);

where = 'load index.html';
await load('index.html');
await checkHandlers('handlers (index.html)');

// ── 2. Self-tests, fresh ─────────────────────────────────────────────────────
where = 'self-tests (fresh)';
const tests = await runSelfTests(where);
console.log('self-tests found: ' + tests.join(', '));

// The DroneCAN self-test redraws its tab when the tab is on screen, and it pins the FC node to 1
// while it runs: with the tab up and a non-default FC node, the redraw must come from the
// RESTORED config, or the input keeps the test's 1 and the next edit saves it.
where = 'self-tests (DroneCAN tab on screen, FC node 5)';
await page.evaluate(() => {
  dcCfg.fcNode = 5;
  document.getElementById('dronecanWrap').style.display = 'flex';
  dronecanOnShow();
});
await runSelfTests(where);

// ── 3. Demo traffic, one base traffic per fresh page ─────────────────────────
const KINDS = ['ramn', 'j1939', 'iso11783', 'nmea2000', 'dronecan', 'canopen', 'chademo'];
for (const kind of KINDS) {
  where = `demo ${kind}`;
  await load('index.html');
  await page.evaluate((kind) => {
    window.__fwd = 0;
    const orig = window.canForward;
    window.canForward = function () { window.__fwd++; return orig.apply(this, arguments); };
    startDemo();
    demoSetBaseTraffic(kind);
    // startDemo() began on the default (RAMN) traffic; drop what it sent so the count below is
    // this kind's frames only.
    clearFrames();
  }, kind);
  await sleep(3000);
  const r = await page.evaluate(() => ({ frames: frames.size, fwd: window.__fwd, base: window.demoGetBaseTraffic() }));
  if (r.base !== kind) fail(where, `base traffic is ${r.base}, not ${kind}`);
  if (!(r.frames > 0)) fail(where, 'no frames reached the frame table');
  // Carlito is closed, so nothing may be forwarded - except under DroneCAN demo traffic, where
  // dronecan.js's answers to bus requests (allocator grants, service responses) ride the
  // gateway through dcEmit on purpose.
  if (kind !== 'dronecan' && r.fwd) fail(where, `${r.fwd} canForward call(s) with Carlito closed`);
  console.log(`demo ${kind}: ${r.frames} ids, ${r.fwd} forwarded`);
  await runSelfTests(`self-tests (after demo ${kind})`, null, false);
  await checkHandlers(`handlers (after demo ${kind})`);
}

// ── 4. The telemetry seam ────────────────────────────────────────────────────
// A truck payload carrying every 0x520-0x52C field but sail_angle, which is the boat's alone and would
// make the payload a boat's too (nmea2000.js would carry its share; altitude fills 0x52B). A truck
// is on a J1939 network, so that block is J1939 Proprietary B: PGN 0xFF20-0xFF2C from SA 0x25.
// Injected twice: the slow ids ride every other message, as they do from the game. The truck's
// own signals make the flavor packers run, and their groups are checked by PGN. What j1939-flavor.js
// carries instead (rpm, gear, kmh, yaw / accelerations, lat / lon, odo, fuel / coolant / battery)
// is absent from the block: 0xFF22 / 0xFF25 / 0xFF26 / 0xFF28 are not sent, and 0xFF21 reads n/a
// for rpm and gear.
where = 'telemetry seam';
await load('index.html');
const PACKED = { 61440: 'ERC1 (j1939-flavor.js)', 65198: 'AIR1 (j1939-flavor.js)', 61444: 'EEC1 (isobus.js)',
  61445: 'ETC2 (j1939-flavor.js)', 61449: 'VDC2 (j1939-flavor.js)', 65267: 'VP (j1939-flavor.js)', 65217: 'VDHR (j1939-flavor.js)' };
const CARRIED_ELSEWHERE = [0x522, 0x525, 0x526, 0x528];
const seen = await page.evaluate(async () => {
  const t = {
    speed: 12.5, kmh: 45, rpm: 1400, gear: 4, throttle: 30,
    yaw: 0.05, accLong: 0.4, accLat: -0.2,
    steer: -15, slip: [0.02, 0.03], ground: true,
    posX: 120, posZ: -340, heading: 270,
    lat: 48.8566, lon: 2.3522, odo: 1234.5,
    status: 1, impact: 0,
    fuel: 70, coolant: 88, battery: 24.4,
    pitch: 2, roll: -1, roll_rate: 0.01, pitch_rate: -0.02, acc_vert: 0.1,
    altitude: 120, vspeed: 0, brake_temp: 80,
    air_primary: 8, air_secondary: 7.8, retarder_state: 20, engine_load: 40, gear_ratio: 3.2,
  };
  if (typeof window.carlitoDebugInjectTelemetry !== 'function') return { missing: true };
  window.carlitoDebugInjectTelemetry(t);
  await new Promise(r => setTimeout(r, 60));
  window.carlitoDebugInjectTelemetry(t);
  await new Promise(r => setTimeout(r, 60));
  const ids = [], pgns = [], blockPgns = [], blockData = {};
  let ff21 = null;
  for (const f of frames.values()) {
    if (!f.isExt && f.id >= 0x520 && f.id <= 0x52C) ids.push(f.id);
    if (f.isExt) {
      const dp = (f.id >>> 24) & 1, pf = (f.id >>> 16) & 0xFF, ps = (f.id >>> 8) & 0xFF;
      const pgn = (dp << 16) | (pf << 8) | (pf >= 0xF0 ? ps : 0);
      pgns.push(pgn);
      if ((f.id & 0xFF) === 0x25 && pgn >= 0xFF20 && pgn <= 0xFF2C) blockPgns.push(pgn);
      if ((f.id & 0xFF) === 0x25 && pgn === 0xFF21) ff21 = Array.from(f.data);
      if ((f.id & 0xFF) === 0x25) blockData[pgn] = Array.from(f.data);
    }
  }
  // The J1939 tab's names for the block, generated from CAN_MAP (carlito.js), on the same frames.
  const decoded = {};
  for (const pgn of [0xFF20, 0xFF21, 0xFF23, 0xFF2C]) {
    const e = J1939_DB[pgn];
    decoded[pgn.toString(16).toUpperCase()] = e && e.decode && blockData[pgn]
      ? e.abbr + ': ' + e.decode(blockData[pgn]).map(r => r.name + '=' + r.display).join(', ') : 'none';
  }
  decoded.iso = typeof ISOBUS_DB !== 'undefined' && ISOBUS_DB[0xFF21] === J1939_DB[0xFF21];
  const live = !!window.carlitoTelemetry();
  window.carlitoDebugInjectTelemetry(null);   // end the link, as closing the window would
  return { ids, pgns, blockPgns, ff21, decoded, live, ended: window.carlitoTelemetry() === null };
});
if (seen.missing) fail(where, 'window.carlitoDebugInjectTelemetry is not defined');
else {
  for (let id = 0x520; id <= 0x52C; id++) {
    const pgn = 0xFF00 | (id & 0xFF), name = `PGN 0x${pgn.toString(16).toUpperCase()} (the truck's 0x${id.toString(16).toUpperCase()})`;
    if (CARRIED_ELSEWHERE.includes(id)) {
      if (seen.blockPgns.includes(pgn)) fail(where, `${name} was sent, though J1939 groups carry all its signals`);
    } else if (!seen.blockPgns.includes(pgn)) fail(where, `${name} from SA 0x25 never reached the frame table`);
  }
  // rpm FF FF, gear FD (both not available: EEC1 / ETC2 carry them), throttle 30 %, padding.
  const ff21 = (seen.ff21 || []).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  if (ff21 !== 'FF FF FD 1E FF FF FF FF') fail(where, `the truck's PGN 0xFF21 is ${ff21 || 'missing'}, not FF FF FD 1E FF FF FF FF`);
  const DECODED = {
    FF20: '0x520: speed=12.50 m/s, kmh=N/A',
    FF21: '0x521: rpm=N/A, gear=N/A, throttle=30 %',
    FF23: '0x523: steer=-15 %, slip[0]=0.02, slip[1]=0.03, ground=1',
    FF2C: '0x52C: brake_temp=80.00 degC',
  };
  for (const [k, want] of Object.entries(DECODED))
    if (seen.decoded[k] !== want) fail(where, `the J1939 tab decodes PGN 0x${k} as "${seen.decoded[k]}", not "${want}"`);
  if (!seen.decoded.iso) fail(where, 'the ISO 11783 dictionary has no Carlito Proprietary B entries (the tractor\'s tab)');
  if (seen.ids.length) fail(where, `a truck sent 11-bit telemetry ids: ${seen.ids.map(i => '0x' + i.toString(16).toUpperCase()).join(' ')}`);
  for (const [pgn, name] of Object.entries(PACKED))
    if (!seen.pgns.includes(+pgn)) fail(where, `no ${name} frame (PGN ${pgn}) - did its packer stop?`);
  if (!seen.live) fail(where, 'carlitoTelemetry() is null straight after an injection');
  if (!seen.ended) fail(where, 'carlitoTelemetry() is still live after carlitoDebugInjectTelemetry(null)');
}

// ── 4b. Carlito traffic sync ─────────────────────────────────────────────────
// Demo traffic follows the vehicle; the game's groups get no synthetic twin (one producer per
// group); a vehicle sends no 0x52x frame with nothing in it; the J1939 groups carry the game's
// numbers. The payload is re-injected every 50 ms: carlitoTelemetry() goes stale after 600 ms.
where = 'carlito traffic sync';
await load('index.html');
// A car publishes only signals it shares with other vehicles, so it is detected as none of them.
const CAR = { ...COMMON, rpm: 1700, gear: 3, slip: [0.01, 0.01], ground: true, fuel: 60, coolant: 85,
  brake_temp: 50, speed_limit: 50, twd: 180, tws: 4, fuel_rate: 6 };
const sync = await page.evaluate(async (P) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { follow: {}, problems: [], rpm: null, ramnBack: false };
  // A frame reaching ingestFrame from inside canForward is the game's (the telemetry path); any
  // other is the demo's. canForward's own ingestFrame call resolves through the global, so this
  // one wrapper sees both.
  let inFwd = false, rec = null;
  const oF = window.canForward, oI = window.ingestFrame;
  window.canForward = function () { inFwd = true; try { return oF.apply(this, arguments); } finally { inFwd = false; } };
  window.ingestFrame = function (f) {
    if (rec && f) rec.push({ id: f.id >>> 0, isExt: !!f.isExt, game: inFwd, data: Array.from(f.data || []) });
    return oI.apply(this, arguments);
  };
  let cur = null;
  const pump = setInterval(() => { if (cur) window.carlitoDebugInjectTelemetry(cur); }, 50);
  const live = async (t, ms) => { cur = t; window.carlitoDebugInjectTelemetry(t); await sleep(ms); };
  const record = async (ms) => { rec = []; await sleep(ms); const r = rec; rec = null; return r; };
  const parse = (f) => J1939Pack.parseId(f.id);
  // Keyed by PGN: a second sender of a group is a second device. The address claim and 127245
  // (rudder ORDER from the steering head beside the rudder's POSITION) are per address.
  const oneProducer = (label, frames) => {
    const by = new Map();
    for (const f of frames) {
      if (!f.isExt) continue;
      const { pgn, sa } = parse(f);
      const key = (pgn === 0xEE00 || pgn === 127245) ? pgn + ' from 0x' + sa.toString(16) : String(pgn);
      if (!by.has(key)) by.set(key, new Set());
      by.get(key).add(f.game ? 'game' : 'demo');
    }
    for (const [k, s] of by) if (s.size > 1) out.problems.push(`${label}: PGN ${k} has a demo AND a game producer`);
  };
  const demoPgns = (frames) => frames.filter(f => f.isExt && !f.game).map(parse);
  const sent = (frames, id) => frames.some(f => !f.isExt && f.id === id);
  // The truck / tractor form of the same 0x52N block: J1939 Proprietary B, PGN 0xFF00 | N, from SA 0x25.
  const sentB = (frames, id) => frames.some(f => f.isExt && f.game && parse(f).sa === 0x25 && parse(f).pgn === (0xFF00 | (id & 0xFF)));
  try {
    startDemo();
    await live(P.truck, 300);
    out.follow.truck = demoGetBaseTraffic();
    let fr = await record(2200);
    oneProducer('truck / J1939', fr);
    for (const id of [0x529, 0x52A, 0x52B]) if (sentB(fr, id)) out.problems.push(`a truck sent PGN 0x${(0xFF00 | (id & 0xFF)).toString(16).toUpperCase()} (its 0x${id.toString(16).toUpperCase()})`);
    // The blocks it does have go out as 29-bit frames only: the 11-bit form is every other vehicle's.
    if (!sentB(fr, 0x521)) out.problems.push('a truck sent no PGN 0xFF21 (its 0x521)');
    // ...but not the ones its J1939 groups carry in full (fuel / coolant / battery, lat / lon, odo).
    for (const id of [0x525, 0x526, 0x528]) if (sentB(fr, id)) out.problems.push(`a truck sent PGN 0x${(0xFF00 | (id & 0xFF)).toString(16).toUpperCase()}, which its J1939 groups carry`);
    if (fr.some(f => !f.isExt && f.id >= 0x520 && f.id <= 0x52C)) out.problems.push('a truck sent an 11-bit 0x520-0x52C frame');
    const eec1 = fr.find(f => f.isExt && f.game && parse(f).pgn === 0xF004 && parse(f).sa === 0);
    if (eec1) out.rpm = j1939DecodeSPN(J1939_DB[0xF004].spns.find(s => s.spn === 190), eec1.data).display;
    if (eec1) out.load = j1939DecodeSPN(J1939_DB[0xF004].spns.find(s => s.spn === 513), eec1.data).display;
    if (fr.some(f => f.isExt && f.game && parse(f).pgn === 0xF003)) out.problems.push('the game sent EEC2 (engine_load is SPN 513 in EEC1)');

    demoSetBaseTraffic('iso11783');   // the shared groups (pto_state, engine_load) are the game's
    oneProducer('truck / ISO 11783', await record(2200));
    demoSetBaseTraffic('nmea2000');   // a deliberate choice: showing the J1939 tab must not undo it
    switchViewTab('j1939');
    out.follow.tabKeepsChoice = demoGetBaseTraffic();
    switchViewTab('ids');

    await live(P.tractor, 300);
    out.follow.tractor = demoGetBaseTraffic();
    fr = await record(3200);          // past one 3 s demo address-claim tick
    oneProducer('tractor / ISO 11783', fr);
    if (!sentB(fr, 0x521)) out.problems.push('a tractor sent no PGN 0xFF21 (its 0x521)');
    if (fr.some(f => !f.isExt && f.id >= 0x520 && f.id <= 0x52C)) out.problems.push('a tractor sent an 11-bit 0x520-0x52C frame');
    for (const p of demoPgns(fr)) {
      if (p.pgn === 0xFEE8) out.problems.push('a tractor on the link, and the demo still sends VDS');
      if (p.pgn === 0xEE00 && p.sa === 0x80) out.problems.push('the demo sprayer claimed 0x80 over the game\'s implement');
    }
    demoSetBaseTraffic('j1939');
    oneProducer('tractor / J1939', await record(2200));

    await live(P.boat, 300);
    out.follow.boat = demoGetBaseTraffic();
    fr = await record(2800);          // past one 2.5 s Fluid Level period
    oneProducer('boat / NMEA 2000', fr);
    for (const p of demoPgns(fr)) if ([127250, 129025].includes(p.pgn)) out.problems.push(`a boat on the link, and the demo still sends PGN ${p.pgn}`);
    // The boat's block is NMEA 2000 proprietary: PGN 0xFF2N from SA 0x25 under the header FF 9F
    // (manufacturer 2047, industry 4 Marine), never 11-bit...
    if (fr.some(f => !f.isExt && f.id >= 0x520 && f.id <= 0x52C)) out.problems.push('a boat sent an 11-bit 0x520-0x52C frame');
    for (const id of [0x520, 0x521, 0x522, 0x523, 0x524, 0x527, 0x52B]) if (!sentB(fr, id)) out.problems.push(`a boat sent no PGN 0x${(0xFF00 | (id & 0xFF)).toString(16).toUpperCase()} (its 0x${id.toString(16).toUpperCase()})`);
    // ...but not the ones its NMEA 2000 groups carry in full (lat / lon, odo, fuel / coolant / battery, pitch / roll).
    for (const id of [0x525, 0x526, 0x528, 0x529]) if (sentB(fr, id)) out.problems.push(`a boat sent PGN 0x${(0xFF00 | (id & 0xFF)).toString(16).toUpperCase()}, which its NMEA 2000 groups carry`);
    const blockB = fr.filter(f => f.isExt && f.game && parse(f).sa === 0x25 && parse(f).pgn >= 0xFF20 && parse(f).pgn <= 0xFF2C);
    if (blockB.some(f => f.data[0] !== 0xFF || f.data[1] !== 0x9F)) out.problems.push('a boat\'s 0xFF2x frame lacks the proprietary header FF 9F');
    // The NMEA 2000 tab's names for the block: what the boat's groups carry reads not available.
    out.boatDecoded = {};
    for (const pgn of [0xFF22, 0xFF24]) {
      const f = blockB.find(x => parse(x).pgn === pgn), e = NMEA2K_DB[pgn];
      out.boatDecoded[pgn.toString(16).toUpperCase()] = f && e && e.decode
        ? e.abbr + ': ' + e.decode(f.data).map(r => r.name + '=' + r.display).join(', ') : 'none';
    }
    const game = (pgn) => fr.filter(f => f.isExt && f.game && parse(f).pgn === pgn);
    for (const pgn of [127251, 127257, 127508, 128275]) if (!game(pgn).length) out.problems.push(`a boat sent no PGN ${pgn}`);
    if (!game(127505).some(f => (f.data[0] >> 4) === 0)) out.problems.push('a boat sent no 127505 of Type Fuel');

    await live(P.drone, 300);
    out.follow.drone = demoGetBaseTraffic();
    fr = await record(1500);
    if (fr.some(f => f.isExt && !f.game)) out.problems.push('the demo quad kept flying beside the game\'s drone');
    if (sent(fr, 0x52C)) out.problems.push('a drone sent 0x52C');
    // One carrier: ahrs.Solution / Fix2 / BatteryInfo carry the drone's attitude, rates, position,
    // altitude and battery, so those 0x52x frames go silent; the rest of its block stays 11-bit
    // (DroneCAN shares its bus with CAN 2.0A), with heading and altitude not available.
    for (const id of [0x522, 0x525, 0x528, 0x529, 0x52A]) if (sent(fr, id)) out.problems.push(`a drone sent 0x${id.toString(16).toUpperCase()}, which its DroneCAN messages carry`);
    for (const id of [0x520, 0x524, 0x527, 0x52B]) if (!sent(fr, id)) out.problems.push(`a drone sent no 11-bit 0x${id.toString(16).toUpperCase()}`);
    const last = (id) => { const f = fr.filter(x => !x.isExt && x.id === id).pop(); return f ? f.data : []; };
    if (last(0x524)[4] !== 0xFF || last(0x524)[5] !== 0xFF) out.problems.push('a drone\'s 0x524 heading is not "not available"');
    if (last(0x52B)[0] !== 0xFF || last(0x52B)[1] !== 0xFF) out.problems.push('a drone\'s 0x52B altitude is not "not available"');
    // ahrs.Solution goes out on every call, Fix2 on the slow tick: count transfers (start-of-transfer bit).
    const transfers = (dtid) => fr.filter(f => f.isExt && f.game && dcParseMsgId(f.id).dataTypeId === dtid && (f.data[f.data.length - 1] & 0x80)).length;
    if (!(transfers(1000) > transfers(1063) * 1.5)) out.problems.push(`a drone's ahrs.Solution is not at the fast rate (${transfers(1000)} transfers against Fix2's ${transfers(1063)})`);
    // Publish drone telemetry off: nothing carries them on DroneCAN, so the block takes them back.
    const txWas = dcCfg.txEnabled;
    dcCfg.txEnabled = false;
    try { fr = await record(500); } finally { dcCfg.txEnabled = txWas; }
    if (!sent(fr, 0x529)) out.problems.push('with DroneCAN publishing off, a drone sent no 0x529');

    await live(P.car, 300);
    out.follow.car = demoGetBaseTraffic();
    fr = await record(500);
    out.ramnBack = sent(fr, 0x024);
    if (!sent(fr, 0x520)) out.problems.push('a car sent no 11-bit 0x520');
    // A car has no J1939 network: the signals a truck sends in J1939 groups stay in its block.
    for (const id of [0x522, 0x525, 0x526, 0x528]) if (!sent(fr, id)) out.problems.push(`a car sent no 11-bit 0x${id.toString(16).toUpperCase()}`);
    const c521 = fr.find(f => !f.isExt && f.id === 0x521);
    if (c521 && ((c521.data[0] << 8) | c521.data[1]) !== 1700) out.problems.push(`a car's 0x521 carries rpm ${(c521.data[0] << 8) | c521.data[1]}, not 1700`);
    if (fr.some(f => f.isExt && f.game && parse(f).pgn >= 0xFF20 && parse(f).pgn <= 0xFF2C)) out.problems.push('a car sent a Proprietary B 0xFF2x frame');
  } finally {
    clearInterval(pump);
    window.carlitoDebugInjectTelemetry(null);
    window.canForward = oF; window.ingestFrame = oI;
  }
  return out;
}, { ...PAYLOADS, truck: { ...PAYLOADS.truck, rpm: 1500 }, car: CAR });
const WANT = { truck: 'j1939', tabKeepsChoice: 'nmea2000', tractor: 'iso11783', boat: 'nmea2000', drone: 'dronecan', car: 'ramn' };
for (const [k, v] of Object.entries(WANT))
  if (sync.follow[k] !== v) fail(where, `demo traffic with ${k}: ${sync.follow[k]}, not ${v}`);
for (const p of sync.problems) fail(where, p);
if (!sync.ramnBack) fail(where, 'no RAMN frames after the car took the traffic back to RAMN');
const BOAT_DECODED = {
  FF22: '0x522: yaw=N/A, accLong=0.40 m/s^2, accLat=-0.20 m/s^2',
  FF24: '0x524: posX=120 m, posZ=-340 m, heading=N/A',
};
for (const [k, want] of Object.entries(BOAT_DECODED))
  if (sync.boatDecoded[k] !== want) fail(where, `the NMEA 2000 tab decodes the boat's PGN 0x${k} as "${sync.boatDecoded[k]}", not "${want}"`);
if (parseFloat(sync.rpm) !== 1500) fail(where, `EEC1 reads ${sync.rpm}, not the truck's 1500 rpm`);
if (parseFloat(sync.load) !== 40) fail(where, `EEC1's SPN 513 reads ${sync.load}, not the truck's 40 % engine_load`);
console.log('carlito traffic sync: ' + JSON.stringify(sync.follow) + ', EEC1 ' + sync.rpm);

// Outside demo, the J1939 / NMEA 2000 / ISOBUS tabs pick their mode and mark their own tab -
// whatever machine is on the link - and a bare switchViewTab('j1939') keeps the mode it has.
where = 'J1939-family tabs select their mode (no demo)';
await load('index.html');
const tabMode = await page.evaluate((truck) => {
  window.carlitoDebugInjectTelemetry(truck);
  const out = {};
  for (const m of ['nmea2000', 'iso11783', 'j1939']) {
    switchViewTab('j1939', m);
    out[m] = [window.j1939GetProto(), document.querySelector('.view-tabs .view-tab.active')?.id];
  }
  switchViewTab('ids');
  switchViewTab('j1939');
  out.bare = window.j1939GetProto();
  switchViewTab('ids');
  window.carlitoDebugInjectTelemetry(null);
  return out;
}, PAYLOADS.truck);
for (const m of ['nmea2000', 'iso11783', 'j1939']) {
  const [mode, tab] = tabMode[m];
  if (mode !== m || tab !== 'vtab-' + m) fail(where, `${m} tab: mode ${mode}, active tab ${tab}`);
}
if (tabMode.bare !== 'j1939') fail(where, `a bare show changed the mode to ${tabMode.bare}`);

// ── 4c. Contract coverage ────────────────────────────────────────────────────
// One frame assertion per packer the 2026-10-31 audit's bundle 06 added (CleANopen TPDO1, ISO 11992
// EBS21 / EBS22, EBS11 since; the train's 0x52D / 0x52E, CANaerospace on 1500), the TC / ESC
// switches' sources, the implement's claim answered on request and re-sent when a bus opens, and decision 2's DroneCAN
// re-emit on link-up. Two injections cover one slow tick.
where = 'contract coverage';
await load('index.html');
const cov = await page.evaluate(async (P) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const problems = [];
  const bad = (m) => problems.push(m);
  let rec = null;
  const oF = window.canForward;
  window.canForward = function (f) {
    if (rec && f) rec.push({ id: f.id >>> 0, isExt: !!f.isExt, data: Array.from(f.data || []) });
    return oF.apply(this, arguments);
  };
  const run = async (t, n = 2) => {
    rec = [];
    for (let i = 0; i < n; i++) { window.carlitoDebugInjectTelemetry(t); await sleep(20); }
    const r = rec; rec = null; return r;
  };
  const find = (fr, id, ext) => fr.filter(f => f.id === id && f.isExt === !!ext);
  const hex = (d) => d.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  const expect = (label, fr, id, ext, want) => {
    const f = find(fr, id, ext);
    if (!f.length) bad(`${label}: no frame 0x${id.toString(16).toUpperCase()}`);
    else if (want && hex(f[0].data) !== want) bad(`${label}: ${hex(f[0].data)}, not ${want}`);
  };
  try {
    let fr = await run(P.truck);
    expect('CleANopen TPDO1', fr, 0x190, false, '02280023');
    expect('ISO 11992 EBS21 (VDC passive)', fr, 0x180320C8, true, 'FFFCFFFFFFFFFFFF');
    expect('ISO 11992 EBS22 (ABS passive)', fr, 0x18FEC4C8, true, 'FCFFFFFFFFFFFFFF');
    expect('ISO 11992 EBS11 (10 % demand)', fr, 0x0C02C820, true, 'FFFF000DFFFFFFFF');
    fr = await run({ ...P.truck, body_bus: false, trailer_connected: false });
    if (find(fr, 0x190).length) bad('a TPDO1 while body_bus is false');
    if (find(fr, 0x18FEC4C8, true).length) bad('an EBS22 while no trailer is connected');
    if (find(fr, 0x0C02C820, true).length) bad('an EBS11 while no trailer is connected');

    const train = { ...P.train }; delete train.grade;
    fr = await run(train);
    expect('train 0x52D', fr, 0x52D, false, '5EEC1905FEA0');
    expect('train 0x52E (grade absent -> 7F)', fr, 0x52E, false, '01E57F0100');

    fr = await run(P.plane);
    const f32 = (d) => new DataView(new Uint8Array(d.slice(4, 8)).buffer).getFloat32(0, false);
    const nod = find(fr, 0x5DC);
    if (!nod.length) bad('plane: no CANaerospace NOD on 1500');
    else {
      const d = nod[0].data;
      if (d[0] !== 14 || d[1] !== 2 || d[2] !== 0 || Math.abs(f32(d) - 0.4) > 1e-6) bad(`CANaerospace NOD ${hex(d)}, not node 14 / FLOAT / 0.4`);
    }
    // One carrier: canaerospace.js carries every plane signal, so its 0x52x block is empty (1312-1326
    // is CANaerospace's reserved NOD range), and a boat's pitch / roll stay off CANaerospace.
    for (let id = 0x520; id <= 0x52E; id++) if (find(fr, id).length) bad(`a plane sent 11-bit 0x${id.toString(16).toUpperCase()}, which its CANaerospace messages carry`);
    for (const id of [300, 305, 311, 320, 500, 1036, 1501, 1508]) if (!find(fr, id).length) bad(`a plane sent no CANaerospace NOD ${id}`);
    const hdg = find(fr, 321);
    if (!hdg.length || Math.abs(f32(hdg[0].data) + 90) > 1e-4) bad(`a plane's heading 270 is not -90 on CANaerospace 321 (${hdg.length ? hex(hdg[0].data) : 'none'})`);
    fr = await run(P.boat);
    if (find(fr, 311).length || find(fr, 0x5DC).length) bad('a boat sent CANaerospace messages');

    // The implement's claim: answered on request with one attached, silence without, and re-sent
    // when a bus opens.
    const req = () => ({ id: J1939Pack.buildId(0xEA00, 6, 0xF9, 0xFF), isExt: true, isRtr: false, dlc: 3, data: [0x00, 0xEE, 0x00] });
    const CLAIM = 0x18EEFF80;
    await run(P.tractor);
    rec = []; window.ingestFrame(req()); fr = rec; rec = null;
    if (!find(fr, CLAIM, true).length) bad('a 59904 request for 60928 went unanswered with an implement attached');
    fr = await run(P.tractor);
    if (find(fr, CLAIM, true).length) bad('the claim was re-sent with nothing changed');
    window.carlitoBusReady();
    fr = await run(P.tractor);
    if (!find(fr, CLAIM, true).length) bad('no claim after a bus opened');
    await run({ ...P.tractor, implement_connected: false });
    rec = []; window.ingestFrame(req()); fr = rec; rec = null;
    if (fr.some(f => f.isExt && (f.id & 0xFF) === 0x80)) bad('the detached implement answered (or NACKed) a request');

    // Address Claim (60928) once per J1939 source, before its first frame, and again when a bus opens.
    const claimsIn = (fr) => fr.filter(f => f.isExt && (f.id >>> 8) === 0x18EEFF).map(f => f.id & 0xFF);
    window.carlitoBusReady();
    fr = await run(P.truck);
    // Every J1939 source that sent in these two ticks (the 1 s groups may not have): 0x00 and 0x0B always do.
    const sent = [0x00, 0x03, 0x0B, 0x10, 0x17].filter(sa => fr.some(f => f.isExt && (f.id & 0xFF) === sa && (f.id >>> 8) !== 0x18EEFF));
    if (!sent.includes(0x00) || !sent.includes(0x0B)) bad('truck: no traffic from Engine #1 / the brakes controller');
    for (const sa of sent) {
      const n = claimsIn(fr).filter(s => s === sa).length;
      const at = fr.findIndex(f => f.isExt && (f.id & 0xFF) === sa);
      if (n !== 1) bad(`truck: SA 0x${sa.toString(16)} claimed ${n} times after a bus opened, not once`);
      else if (!(at >= 0 && (fr[at].id >>> 8) === 0x18EEFF)) bad(`truck: SA 0x${sa.toString(16)} sent before claiming`);
    }
    fr = await run(P.truck);
    if (claimsIn(fr).length) bad('truck: claims re-sent with nothing changed: ' + claimsIn(fr).join(','));
    // A global request for 60928 is answered by every source holding a claim, not by one server.
    rec = []; window.ingestFrame(req()); const back = claimsIn(rec); rec = null;
    for (const sa of sent) if (!back.includes(sa)) bad(`truck: SA 0x${sa.toString(16)} did not answer a global request for 60928`);
    // A vehicle switch on a live link re-claims: truck -> boat -> truck, and truck -> tractor as
    // agricultural (industry group 2, NAME byte 8 bits 5-7).
    await run(P.boat);
    fr = await run(P.truck);
    if (!claimsIn(fr).includes(0x00)) bad('truck after a boat: Engine #1 did not claim again');
    fr = await run(P.tractor);
    const eng = fr.find(f => f.isExt && f.id === 0x18EEFF00);
    if (!eng || ((eng.data[7] >> 4) & 7) !== 2) bad('tractor after a truck: Engine #1 not re-claimed as agricultural');

    // The request server answers only a vehicle with a J1939 network: nothing (no answer, no NACK)
    // for a car's CCSS or a boat's HOURS. A truck's CCSS is answered.
    const reqFor = (pgn) => ({ id: J1939Pack.buildId(0xEA00, 6, 0xF9, 0xFF), isExt: true, isRtr: false, dlc: 3,
                               data: [pgn & 0xFF, (pgn >> 8) & 0xFF, (pgn >> 16) & 0xFF] });
    const answered = async (t, pgn) => {
      await run(t);
      rec = []; window.ingestFrame(reqFor(pgn)); const r = rec; rec = null;
      return r.filter(f => f.isExt && (f.id & 0xFF) !== 0xF9);
    };
    if ((await answered(P.truck, 0xFEED)).every(f => ((f.id >>> 8) & 0xFFFF) !== 0xFEED)) bad('a truck\'s CCSS request went unanswered');
    let a = await answered({ speed: 12.5, kmh: 45, heading: 270, status: 1, speed_limit: 50 }, 0xFEED);   // a car
    if (a.length) bad('a car answered (or NACKed) a CCSS request: ' + a.map(f => f.id.toString(16)).join(','));
    a = await answered(P.boat, 0xFEE5);
    if (a.length) bad('a boat answered (or NACKed) an HOURS request on J1939: ' + a.map(f => f.id.toString(16)).join(','));

    // Decision 2: a drone after none sends each command once (the gimbal as 1040 + 1010).
    await run(P.truck);
    fr = await run(P.drone, 4);
    const fc = dcCfg.fcNode & 0x7F, n = {};
    for (const f of fr) {
      if (!f.isExt || !(f.data[f.data.length - 1] & 0x80)) continue;   // one per transfer
      const m = dcParseMsgId(f.id);
      if (m.srcNode === fc && [1081, 1080, 1070, 1040, 1010].includes(m.dataTypeId)) n[m.dataTypeId] = (n[m.dataTypeId] || 0) + 1;
    }
    for (const id of [1081, 1080, 1070, 1040, 1010]) if (n[id] !== 1) bad(`DroneCAN ${id} sent ${n[id] || 0} times on link-up, not once`);

    // TC / ESC off: no source without the panel, the toggle's value with it.
    const src = window.carlitoUplinkSources;
    if (src.tcs_off() !== undefined || src.esc_off() !== undefined) bad('tcs_off / esc_off sourced with no demo');
    startDemo();
    if (src.tcs_off() !== false || src.esc_off() !== false) bad('tcs_off / esc_off not false in demo');
    document.getElementById('ramnCtrlTcsOff').click();
    document.getElementById('ramnCtrlEscOff').click();
    if (src.tcs_off() !== true || src.esc_off() !== true) bad('tcs_off / esc_off not true after the toggles');
  } finally {
    window.canForward = oF;
    window.carlitoDebugInjectTelemetry(null);
  }
  return problems;
}, PAYLOADS);
for (const p of cov) fail(where, p);
console.log('contract coverage: ' + (cov.length ? cov.length + ' problem(s)' : 'ok'));

// ── 4d. Vehicle panels ───────────────────────────────────────────────────────
// Each panel answers its own family's payload: drone / truck / tractor / boat open their window
// (and render a reading off it, not the resting '–'); every machine with commands shows them as a
// section of the Control panel, titled after it. The link is ended between machines, as closing
// Carlito would.
where = 'vehicle panels';
await load('index.html');
const panels = await page.evaluate(async (P) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const open = (id) => { const w = document.getElementById(id); return !!w && w.classList.contains('open'); };
  // The machine's commands are a shown section of the Control panel, which is named after it.
  const ctrlSec = (id, label) => {
    const c = document.querySelector('#ramnCtrlWindow #' + id);
    return !!c && !c.closest('.vp-hidden') &&
      document.querySelector('#ramnCtrlWindow .ramn-title').textContent === 'Control panel (' + label + ')';
  };
  // A machine's read-backs with no dashboard of their own are a shown section of the RAMN one.
  const dashSec = (id) => { const c = document.querySelector('#ramnWindow #' + id); return !!c && !c.closest('.vp-hidden'); };
  const CASES = [
    ['drone', () => open('droneWindow') && open('droneCtrlWindow')],
    ['truck', () => open('truckWindow') && document.getElementById('truckRpmV').textContent === '1400' && ctrlSec('truckCtlPto', 'Truck')],
    ['tractor', () => open('tractorWindow') && document.getElementById('tractorGroundV').textContent === '7.6 km/h' && ctrlSec('tractorCtlPto', 'Tractor')],
    ['boat', () => open('boatWindow') && document.getElementById('boatSog').textContent === '6.8' && ctrlSec('bapAuto', 'Boat')],
    ['train', () => ctrlSec('trnPanto', 'Train') && dashSec('trnPantoState')],
    ['plane', () => ctrlSec('plnElev', 'Plane') && dashSec('plnFlapsActual')],
  ];
  const problems = [];
  try {
    for (const [fam, ok] of CASES) {
      window.carlitoDebugInjectTelemetry(null);
      await sleep(50);
      for (let i = 0; i < 3; i++) { window.carlitoDebugInjectTelemetry(P[fam]); await sleep(50); }
      await new Promise(r => requestAnimationFrame(() => r()));
      if (!ok()) problems.push(`the ${fam} panel did not answer a ${fam} payload`);
    }
  } finally {
    window.carlitoDebugInjectTelemetry(null);
  }
  return problems;
}, PAYLOADS);
for (const p of panels) fail(where, p);
console.log('vehicle panels: ' + (panels.length ? panels.length + ' problem(s)' : 'ok'));

// ── 5. Golden frames ─────────────────────────────────────────────────────────
where = 'golden frames';
for (const f of await runGolden(browser, url('index.html'), { update: UPDATE_GOLDEN })) fail(where, f);
// The bridge page loads the packers without the app around them (dronecan-core.js, not dronecan.js),
// and no self-test covers DroneCAN there - so its packers are held to the same bytes.
where = 'golden frames (carlito-bridge.html)';
if (!UPDATE_GOLDEN) for (const f of await runGoldenPackers(browser, url('carlito-bridge.html'))) fail(where, f);

await browser.close();

// ── 6. Exit status ───────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nSMOKE TEST FAILED - ${failures.length} problem(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nsmoke test passed');
