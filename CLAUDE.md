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

For HTTPS, run `https_server.py` (proxies `localhost:8000` → `https://0.0.0.0:4443`). Requires `../cert.pem` + `../key.pem` and `pip install requests`.

Demo mode (no hardware): click the **Demo** button.

## Architecture

Three core files:

- **`index.html`** — layout skeleton and inline styles; links CSS and JS
- **`sloppycan.css`** — dark theme, CSS variables, component styles (~650 lines)
- **`sloppycan.js`** — all application logic (~2950 lines), structured with `// ── Section ──` comments

Optional bolt-on modules (each self-contained, deferred script, integration hooks only in core files):

| File | Tab / feature |
|------|---------------|
| `j1939.js` | J1939 / N2K / ISOBUS tab |
| `graph.js` | Graph tab |
| `fuzz.js` | Fuzzing tab |
| `chademo.js` | CHAdeMO tab |
| `xcp.js` | XCP-on-CAN tab |
| `canopen.js` | CANopen tab |

OBD-II, KWP2000, UDS, DTC decoder, NMEA 2000, and ISOBUS are sub-modes implemented inside the core files or `j1939.js` — no separate module.

Standalone reference pages: `dtc.html`, `obd2-explainer.html`, `kwp2000-explainer.html`, `uds-explainer.html`, `nmea2000-explainer.html`, `iso11783-explainer.html`, `ev-charging-explainer.html`, `xcp-explainer.html`, `canopen-explainer.html`.

## Detailed references

- **[.claude/core-arch.md](.claude/core-arch.md)** — script section list, key data structures, gs_usb wire-format, byte colour semantics.
- **[.claude/modules.md](.claude/modules.md)** — per-module docs for graph, fuzz, OBD-II, KWP2000, NMEA 2000, ISOBUS, DTC, CHAdeMO, XCP, CANopen (integration points + revert instructions).
