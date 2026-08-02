# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based CAN bus monitor for **SLCAN** and **gs_usb** (candleLight / CANable / RAMN) USB-to-CAN adapters. No build step, no dependencies, no backend required. Open `index.html` directly in Chrome or Edge (Web Serial API required on desktop; Android Chrome uses a WebUSB fallback). The adapter protocol is chosen with the **Adapter** dropdown (`SLCAN` / `gs_usb`); gs_usb is WebUSB-only.

## Running Locally

Open `index.html` directly in Chrome/Edge. Web Serial API requires `file://` or HTTPS:

```
python -m http.server 8000
# open http://localhost:8000/index.html
```

Web Serial works from `file://` or `localhost`; HTTPS is only needed to reach the page from another device on the network.

Demo mode (no hardware): click the **Demo** button.

## Architecture

Core files:

- **`index.html`** - layout skeleton and inline styles; links CSS and JS
- **`sloppycan.css`** - dark theme, CSS variables, component styles (~1840 lines)
- **`sloppycan.js`** - all application logic (~4700 lines), structured with `// ── Section ──` comments
- **`can-link.js`** - shared CAN transport layer (gs_usb + SLCAN device open / RX pumps / frame parse / serialized write), split out of `sloppycan.js`. Loaded (non-`defer`) **before** `sloppycan.js`; all three core scripts share one global lexical scope, so the connection state (`connMode`/`port`/`usbSerDev`/`busIsOpen`/…) and primitives it declares are the same bindings `sloppycan.js` references. Reused as-is by the standalone bridge (see below)
- **`diag-parse.js`** - pure OBD-II / UDS / KWP2000 payload decoders + reference tables (~420 lines), split out of `sloppycan.js`. Loaded (non-`defer`) immediately **before** `sloppycan.js` because the core's DIAG-MODE palettes read these tables at eval time

Standalone page (not part of the SloppyCAN app, no link to/from it):

- **`carlito-bridge.html`** + **`carlito-bridge.js`** - a minimal RAMN↔Carlito bridge for users who bring their own CAN tooling. Loads `can-link.js` (transport) + `ramn.js` (decode → `ramnGetState`) + `carlito.js` (the game link), with `carlito-bridge.js` supplying small host shims (`log`/`ingestFrame`/`connectSerial`/`disconnectSerial`/`canForward` + the connect bar). It just decodes RAMN control frames into the embedded game and forwards the game's telemetry (`0x520`–`0x528`) back onto the wire - no dashboards, tabs, demo, or workspaces. Connect bar offers gs_usb + SLCAN; Carlito opens automatically on connect

Optional bolt-on modules (deferred scripts; integration hooks live in the core files, and modules may share core helpers exposed on `window.*`):

| File | Tab / feature |
|------|---------------|
| `j1939.js` | J1939 / N2K / ISOBUS tab |
| `graph.js` | Graph tab |
| `fuzz.js` | Fuzzing tab |
| `chademo.js` | CHAdeMO tab |
| `xcp.js` | XCP-on-CAN tab |
| `canopen.js` | CANopen tab |
| `ramn.js` | RAMN dashboard (floating instrument-cluster window) + RAMN Control Panel (demo-only driving window) |
| `carlito.js` | Carlito game link - floating window embedding the Godot game (loaded from one of two hardcoded channels, `…/carlito/stable/` or `…/carlito/dev/`, picked by the header selector / `?carlitoBuild=` / auto-pair on a `/dev/` path); sends all RAMN controls into it (drive + handbrake/ignition/headlights) and emits the car telemetry it sends back as CAN `0x520`–`0x528` (50/100 ms) via `window.canForward` - ingested once for the dashboards and, when a bus is open, transmitted on the wire and shown as a single `FW` (forward) dump entry (gateway model: counts as RX+TX; plain RX when no bus). Closing the window tears down the iframe (stops the game). Consumes `window.CARLITO_CONTRACT` (from `carlito_contract.js`, loaded first) for the message field names + CAN-map coverage check; sends gear `R` as `0xFF`; both sides `console.warn` once on contract-version mismatch. Game-side bridge lives in the `carlito` repo |

OBD-II, KWP2000, UDS, DTC decoder, NMEA 2000, and ISOBUS are sub-modes implemented inside the core files or `j1939.js` - no separate feature module (the OBD/UDS/KWP payload **decoders + tables** live in the core-split `diag-parse.js`; the sub-mode UI controllers stay in `sloppycan.js`).

Many module integration hooks in the core files carry `// … remove to revert` comments. Treat these as navigation aids that mark where a module plugs in - not a hard "every module must be independently removable" contract. Modules may depend on shared core helpers (e.g. `window.withTxLock`, `window.canRelTs`/`canHexBytes`/`canParseIntAuto`, `window.txReady`, `window.fuzzTxFrame`); prefer reusing those over re-implementing per module.

Standalone reference pages live in `explainers/`: `isotp-explainer.html` (+ `isotp-2016.html`, ISO 15765-2:2016 large-payload extensions), `obd2-explainer.html`, `kwp2000-explainer.html`, `uds-explainer.html`, `nmea2000-explainer.html`, `iso11783-explainer.html`, `ev-charging-explainer.html`, `xcp-explainer.html`, `canopen-explainer.html`, `dtc.html` (DTC decoder), `can-signals-explainer.html` (ground-up CAN walkthrough: bus schematic → editable bitstream → two-way frame parse table → physical-layer oscilloscope → arbitration waveform; linked from the Frame Inspector's bitstream). Each is self-contained (only external dependency: Google Fonts).

## Conventions & gotchas

- **Shared global scope:** `can-link.js`, `diag-parse.js`, and `sloppycan.js` are classic (non-module) scripts sharing one global lexical scope — a `let`/`const`/`function` declared in one is the same binding everywhere. **Never redeclare a name across them** (a duplicate `let` is a SyntaxError that spans scripts). Bolt-on modules are `defer`red and talk to the core via `window.*`.
- **Untrusted bus data → escape before the DOM:** CAN ids, payload bytes, and decoded ASCII/DTC strings are device-controllable. Route them through `escHtml()` (escapes `& < > " '`) or `textContent` before any `innerHTML`/attribute interpolation. `log()` already escapes its whole message — don't double-escape into it.
- **`carlito_contract.js` is generated, not hand-edited:** it sets `window.CARLITO_CONTRACT` and is a committed synced copy of the `carlito` repo's canonical `contract/carlito_contract.json`. Regenerate from the carlito repo (`node tools/gen_js_contract.mjs`), not here. It must load before `carlito.js` (script tags already ordered in `index.html` + `carlito-bridge.html`). The runtime version-mismatch warning is the drift guard (no CI here).
- **A contract change is a paired change across two repos.** The game and sloppyCAN agree by version number, so a bump lands on the `dev` branch of **both** `carlito` and `sloppycan` together, and both get promoted to stable together. Promoting one alone puts a live stable pair on mismatched versions — the runtime warning fires and signals are misread.
- **Verifying changes:** there is no test suite. Syntax-check with `node --check <file>.js`; verify behaviour by opening `index.html` and using **Demo** mode (no hardware needed). Navigate `sloppycan.js` by its `// ── Section ──` headers (map in `core-arch.md`). CI runs the `node --check` sweep plus a sanity load of `carlito_contract.js`; everything else is verified by driving.

## Deploy — two channels

Both channels are served from the `gh-pages` branch, which CI rewrites as a single orphan
commit and force-pushes (nothing in that history is worth keeping):

| | URL | Updated by |
|---|---|---|
| stable | <https://leaukojo.github.io/sloppycan/> | *Promote dev → stable* (manual) |
| dev | <https://leaukojo.github.io/sloppycan/dev/> | every push to `dev` |

Stable sits at the **gh-pages root**, not in a `stable/` subdirectory — unlike carlito, which
needs sibling dirs under a redirect page because its PWA service-worker scopes would nest and
intercept each other. sloppyCAN ships no service worker, so there is no scope to nest and
stable keeps the root URL already published in the README.

Promotion **copies the published `/dev/` bytes**, never re-copies from the branch, so what you
approved on dev is what goes stable. Ritual: Actions → *Promote dev → stable* → Run workflow.
Paired with carlito's promote whenever the contract version moved (see above).

**The Carlito window auto-pairs channels:** sloppyCAN served from a path containing `/dev/`
defaults to the dev game, everything else to stable — so `/sloppycan/dev/` drives
`/carlito/dev/` without anyone selecting anything. The header selector and `?carlitoBuild=`
override that; a `?carlitoUrl=` local override replaces both and hides the selector.

## Detailed references

- **[.claude/core-arch.md](.claude/core-arch.md)** - script section list, key data structures, gs_usb wire-format, byte colour semantics.
- **[.claude/modules.md](.claude/modules.md)** - per-module docs for graph, fuzz, OBD-II, KWP2000, NMEA 2000, ISOBUS, DTC, CHAdeMO, XCP, CANopen (integration points).
