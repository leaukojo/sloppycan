# CLAUDE.md

Browser CAN bus monitor for **SLCAN** and **gs_usb** (candleLight / CANable / RAMN) adapters. No
build, no dependencies, no backend: open `index.html` in Chrome/Edge (Web Serial; WebUSB for gs_usb
and the Android fallback), or `python -m http.server 8000`. No hardware: the **Demo** button.

## Where things are documented

- **A file's own behaviour lives in that file:** its header comment for the overview, the code's
  comments for the detail. Read the header before editing a module.
- **`.claude/modules.md`** holds only what spans files: integration points into the core,
  cross-module flows, and features with no file of their own (OBD-II / KWP2000 in `sloppycan.js`,
  the N2K / ISOBUS modes of `j1939.js`, `dtc.html`). **`.claude/core-arch.md`**: core sections,
  data structures, wire formats, UI helpers.
- This file: repo-wide rules and the file map only. Keep it under the budget
  `static-checks.mjs` enforces.

## File map

Every script is in `js/` (flat, no subfolders), the stylesheet is `css/sloppycan.css`. The pages
(`index.html`, `carlito-bridge.html`) stay at the root: deployed URLs and the `/dev/` pairing need it.

Core (classic scripts, one shared global scope, loaded in this order):
- `can-link.js` - CAN transport (gs_usb + SLCAN open, RX pumps, parse, serialized write); reused by the bridge
- `diag-parse.js` - OBD-II / UDS / KWP2000 decoders + tables; also loaded by `explainers/dtc.html`
- `sloppycan.js` - the app (navigate by `// ── Section ──`); `index.html`, `css/sloppycan.css`

Shared (deferred, before their users):
- `carlito-registry.js` - every Carlito registry, created empty first; `carlitoIsFamily`, the which-machine rule;
  `carlitoSig(name, dir)`, the one contract lookup, and `carlitoGearTop()`
- `j1939-pack.js` - `window.J1939Pack`, the one J1939/N2K packing helper (self-contained)
- `j1939-tables.js` - the one J1939 / N2K / ISOBUS dictionary + pure decoders; **edit tables here, never copy them**
- `carlito_contract.js` - generated contract (see below); `vehicle-panel.js` - the shared panel mechanism

Tabs: `graph.js`, `fuzz.js`, `j1939.js` (J1939 / N2K / ISOBUS + the J1939-21 request path),
`chademo.js`, `xcp.js`, `canopen.js`, `dronecan-core.js` (codec, roster, packer; no DOM) +
`dronecan.js` (receive path, services, tab).

Flavor packers (no tab): `isobus.js`, `j1939-flavor.js`, `nmea2000.js`, `cleanopen.js`,
`iso11992.js`, `canaerospace.js`.

Carlito link and panels: `carlito.js` (the game window, telemetry → CAN, uplink), `ramn.js`
(RAMN dashboard + Control Panel, `makeFloating`), `drone.js`, `truck.js`, `tractor.js`,
`boat.js`, `boat-pilot.js`, `train.js`, `plane.js`.

Other: `script-link.js` (live CAN I/O with scripts via `scripting/sloppycan_relay.py`) ·
`carlito-bridge.html` + `.js` (standalone RAMN↔Carlito bridge, no link to the app) ·
`explainers/` (standalone reference pages) · `.github/scripts/` (CI checks).

## Conventions and gotchas

- **Shared global scope:** `can-link.js`, `diag-parse.js`, `sloppycan.js` (and `j1939-tables.js`)
  share one lexical scope. **Never redeclare a name across them** (a SyntaxError spanning scripts).
  Bolt-on modules are deferred, talk via `window.*`, and should reuse core helpers
  (`window.withTxLock`, `canHexBytes`, `txReady`, …) rather than copy them.
- **`… remove to revert` hook comments are navigation aids**, not a promise that every module is
  independently removable.
- **Bus data is untrusted:** ids, bytes and decoded strings go through `escHtml()` or
  `textContent` before any `innerHTML`. `log()` escapes its message already.
- **Live tables update in place** (`renderKeyedTable` / `renderKeyedRows` / `setHtmlIfChanged`),
  never a whole-table `innerHTML`, which restarts the hover fade, splits clicks and wipes
  selection. Generated rows use `data-*` + one delegated listener, never inline `onclick`. Tables
  keyed by bus ids are capped (`FRAMES_MAX`, `J1939_PGN_MAX`, DroneCAN's reassembly caps).
- **Flavored contract signals are packed by their flavor module, not `CAN_MAP`.** A module pushes
  `{ flavor, signals, pack(t, slow) }` (+ optional `unpackable`, `onRequest`, `mirrors`,
  `reset()`) onto `window.carlitoFlavorPackers`; `carlito.js`'s `checkCanCoverage()` holds
  `CAN_MAP` to the unflavored out signals and each packer to its flavor, and the smoke test fails
  on an unpacked flavor. `mirrors` (decision 1: truck / tractor J1939 copies of rpm / kmh / …) is
  the one sanctioned "same signal twice".
- **Inbound:** a module owning a contract "in" signal registers `{ name: () => value }` on
  `window.carlitoUplinkSources` (one signal, one source) and **decodes that command off the bus**
  via `window.carlitoUplinkDecoders`, into its own state. A decoder **skips frames from the
  address its module transmits that message from**, or it would read its own echo (127237's
  `nav_mode_actual`) back as the command. Periodic commands expire to the panel value; on-change
  ones latch; a panel edit clears a bus value. `window.carlitoUplinkOverrides` is a *claim*
  checked first, entries compose, and an override **must return `undefined` when not in control**
  (0 would mean "centred").
- **Numbers come off a primary source, never a plan document or web summary:** DSDL files +
  pydronecan for DroneCAN; J1939-71 / J1939-81 / isobus.net for J1939 and ISOBUS. This has caught
  wrong tables more than once. One approved exception: `iso11992.js`'s [SEC]-tagged PGNs
  (ISO 11992-2 is paywalled). J1939-71 Table 1 judges a value by its **top byte**, so encoders
  (`J1939Pack.put`) clamp to 0xFA / 0xFAFF / 0xFAFFFFFF. A mode or value shown only in a figure is
  not written; leave the field "not available".
- **`carlito_contract.js` is generated:** never hand-edit it; regenerate in the `carlito` repo
  (`node tools/gen_js_contract.mjs`). It loads before `carlito.js`. The runtime version-mismatch
  warning is the only drift guard.
- **A contract change is paired across two repos:** the version bump lands on `dev` of **both**
  `carlito` and `sloppycan`, and both are promoted to stable together. Promoting one alone puts
  stable on mismatched versions and signals are misread.

## Verifying

`node --check js/<file>.js`, then the three CI checks:
`node .github/scripts/static-checks.mjs` (inline handlers, script tags, this file's size) ·
`python -m unittest discover -s scripting -p "test_*.py"` (relay) ·
`node .github/scripts/smoke.mjs` (headless Chrome: load, every `window.*SelfTest` fresh and per
demo traffic, golden frames; needs `npm install --no-save --no-package-lock puppeteer` once).
After an **intended** frame change: `node .github/scripts/smoke.mjs --update-golden` and list each
difference. Self-tests stay hermetic (snapshot/restore state, explicit database, never the tab's
mode). `window.carlitoDebugInjectTelemetry(values, opts)` feeds telemetry with no game (re-inject every
50–100 ms; stale after 600 ms). Behaviour beyond that: Demo mode in a browser.

## Deploy: two channels

CI rewrites `gh-pages` as one orphan commit. **dev** (<https://leaukojo.github.io/sloppycan/dev/>)
updates on every push to `dev`; **stable** (the gh-pages root) only via Actions → *Promote dev →
stable*, which copies the published `/dev/` bytes, so what was approved on dev is what goes
stable. No service worker, so no subdirectory is needed for stable. A page served from a `/dev/`
path pairs with Carlito's dev game, anything else with stable; the header selector,
`?carlitoBuild=` and `?carlitoUrl=` override that.
