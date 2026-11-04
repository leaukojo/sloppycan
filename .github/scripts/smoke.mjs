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
// A truck payload carrying every 0x520-0x52C field (sail_angle only because 0x52B carries it).
// Injected twice: the slow ids ride every other message, as they do from the game. The truck's
// own signals make the flavor packers run, and three of their groups are checked by PGN.
where = 'telemetry seam';
await load('index.html');
const PACKED = { 61440: 'ERC1 (j1939-flavor.js)', 65198: 'AIR1 (j1939-flavor.js)', 61443: 'EEC2 (isobus.js)' };
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
    altitude: 120, vspeed: 0, sail_angle: 0, brake_temp: 80,
    air_primary: 8, air_secondary: 7.8, retarder_state: 20, engine_load: 40,
  };
  if (typeof window.carlitoDebugInjectTelemetry !== 'function') return { missing: true };
  window.carlitoDebugInjectTelemetry(t);
  await new Promise(r => setTimeout(r, 60));
  window.carlitoDebugInjectTelemetry(t);
  await new Promise(r => setTimeout(r, 60));
  const ids = [], pgns = [];
  for (const f of frames.values()) {
    if (!f.isExt && f.id >= 0x520 && f.id <= 0x52C) ids.push(f.id);
    if (f.isExt) {
      const dp = (f.id >>> 24) & 1, pf = (f.id >>> 16) & 0xFF, ps = (f.id >>> 8) & 0xFF;
      pgns.push((dp << 16) | (pf << 8) | (pf >= 0xF0 ? ps : 0));
    }
  }
  const live = !!window.carlitoTelemetry();
  window.carlitoDebugInjectTelemetry(null);   // end the link, as closing the window would
  return { ids, pgns, live, ended: window.carlitoTelemetry() === null };
});
if (seen.missing) fail(where, 'window.carlitoDebugInjectTelemetry is not defined');
else {
  for (let id = 0x520; id <= 0x52C; id++)
    if (!seen.ids.includes(id)) fail(where, `0x${id.toString(16).toUpperCase()} never reached the frame table`);
  for (const [pgn, name] of Object.entries(PACKED))
    if (!seen.pgns.includes(+pgn)) fail(where, `no ${name} frame (PGN ${pgn}) - did its packer stop?`);
  if (!seen.live) fail(where, 'carlitoTelemetry() is null straight after an injection');
  if (!seen.ended) fail(where, 'carlitoTelemetry() is still live after carlitoDebugInjectTelemetry(null)');
}

// ── 4b. Carlito traffic sync ─────────────────────────────────────────────────
// Demo traffic follows the vehicle; the game's groups get no synthetic twin (one producer per
// group); a vehicle sends no 0x52x frame with nothing in it; the J1939 mirrors carry the game's
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
  try {
    startDemo();
    await live(P.truck, 300);
    out.follow.truck = demoGetBaseTraffic();
    let fr = await record(2200);
    oneProducer('truck / J1939', fr);
    for (const id of [0x529, 0x52A, 0x52B]) if (sent(fr, id)) out.problems.push(`a truck sent 0x${id.toString(16).toUpperCase()}`);
    const eec1 = fr.find(f => f.isExt && f.game && parse(f).pgn === 0xF004 && parse(f).sa === 0);
    if (eec1) out.rpm = j1939DecodeSPN(J1939_DB[0xF004].spns.find(s => s.spn === 190), eec1.data).display;

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
    for (const p of demoPgns(fr)) {
      if (p.pgn === 0xFEE8) out.problems.push('a tractor on the link, and the demo still sends VDS');
      if (p.pgn === 0xEE00 && p.sa === 0x80) out.problems.push('the demo sprayer claimed 0x80 over the game\'s implement');
    }
    demoSetBaseTraffic('j1939');
    oneProducer('tractor / J1939', await record(2200));

    await live(P.boat, 300);
    out.follow.boat = demoGetBaseTraffic();
    fr = await record(2200);
    oneProducer('boat / NMEA 2000', fr);
    for (const p of demoPgns(fr)) if ([127250, 129025].includes(p.pgn)) out.problems.push(`a boat on the link, and the demo still sends PGN ${p.pgn}`);

    await live(P.drone, 300);
    out.follow.drone = demoGetBaseTraffic();
    fr = await record(1500);
    if (fr.some(f => f.isExt && !f.game)) out.problems.push('the demo quad kept flying beside the game\'s drone');
    if (sent(fr, 0x52C)) out.problems.push('a drone sent 0x52C');

    await live(P.car, 300);
    out.follow.car = demoGetBaseTraffic();
    out.ramnBack = sent(await record(500), 0x024);
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
if (parseFloat(sync.rpm) !== 1500) fail(where, `the EEC1 mirror reads ${sync.rpm}, not 1500 rpm`);
console.log('carlito traffic sync: ' + JSON.stringify(sync.follow) + ', EEC1 ' + sync.rpm);

// Outside demo, the J1939 tab with a truck on the link selects the J1939 mode - once per vehicle
// per link, so a mode the user picks afterwards stands on the next show.
where = 'J1939 tab follows the link (no demo)';
await load('index.html');
const tabMode = await page.evaluate((truck) => {
  window.j1939SetProto('nmea2000');
  window.carlitoDebugInjectTelemetry(truck);
  switchViewTab('j1939');
  const first = window.j1939GetProto();
  switchViewTab('ids');
  window.j1939SetProto('nmea2000');
  window.carlitoDebugInjectTelemetry(truck);
  switchViewTab('j1939');
  const again = window.j1939GetProto();
  switchViewTab('ids');
  window.carlitoDebugInjectTelemetry(null);
  return { first, again };
}, PAYLOADS.truck);
if (tabMode.first !== 'j1939') fail(where, `first show: mode is ${tabMode.first}, not j1939`);
if (tabMode.again !== 'nmea2000') fail(where, `second show: mode is ${tabMode.again}, not the chosen nmea2000`);

// ── 4c. Contract coverage ────────────────────────────────────────────────────
// One frame assertion per packer the 2026-10-31 audit's bundle 06 added (CleANopen TPDO1, ISO 11992
// EBS21 / EBS22, the train's 0x52D / 0x52E, CANaerospace on 1500), the TC / ESC switches' sources,
// the implement's claim answered on request and re-sent when a bus opens, and decision 2's DroneCAN
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
    fr = await run({ ...P.truck, body_bus: false, trailer_connected: false });
    if (find(fr, 0x190).length) bad('a TPDO1 while body_bus is false');
    if (find(fr, 0x18FEC4C8, true).length) bad('an EBS22 while no trailer is connected');

    const train = { ...P.train }; delete train.grade;
    fr = await run(train);
    expect('train 0x52D', fr, 0x52D, false, '5EEC1905FEA0');
    expect('train 0x52E (grade absent -> 7F)', fr, 0x52E, false, '01E57F0100');

    fr = await run(P.plane);
    const nod = find(fr, 0x5DC);
    if (!nod.length) bad('plane: no CANaerospace NOD on 1500');
    else {
      const d = nod[0].data, v = new DataView(new Uint8Array(d.slice(4, 8)).buffer).getFloat32(0, false);
      if (d[0] !== 1 || d[1] !== 2 || d[2] !== 0 || Math.abs(v - 0.4) > 1e-6) bad(`CANaerospace NOD ${hex(d)}, not node 1 / FLOAT / 0.4`);
    }

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
// (and render a reading off it, not the resting '–'), train / plane - which open only by hand -
// show their toolbar button. The link is ended between machines, as closing Carlito would.
where = 'vehicle panels';
await load('index.html');
const panels = await page.evaluate(async (P) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const shown = (id) => { const b = document.getElementById(id); return !!b && getComputedStyle(b).display !== 'none'; };
  const open = (id) => { const w = document.getElementById(id); return !!w && w.classList.contains('open'); };
  const CASES = [
    ['drone', () => open('droneWindow') && open('droneCtrlWindow')],
    ['truck', () => open('truckWindow') && document.getElementById('truckRpmV').textContent === '1400'],
    ['tractor', () => open('tractorWindow') && document.getElementById('tractorGroundV').textContent === '7.6 km/h'],
    ['boat', () => open('boatWindow') && document.getElementById('boatSog').textContent === '6.8'],
    ['train', () => shown('trainBtn')],
    ['plane', () => shown('planeBtn')],
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
