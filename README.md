# sloppyCAN

A browser-based CAN bus monitor for **SLCAN** and **gs_usb** (candleLight / CANable / RAMN)
USB-to-CAN adapters. No backend, no install, no build step — just open `index.html`.

> ⚠️ This project was built with the help of LLMs. Review and test before relying on it.
> Active features (TX, fuzzing, UDS/OBD writes, XCP/CANopen clients) put frames on the bus —
> use them only on a bus you control.

## Requirements

- **Chrome or Edge** on desktop (Web Serial API for SLCAN; WebUSB for gs_usb).
  Android Chrome works for SLCAN via a WebUSB CDC fallback.
- A supported USB-to-CAN adapter — pick the type with the **Adapter** dropdown
  (`SLCAN` or `gs_usb`). gs_usb is WebUSB-only and classic CAN only (no CAN-FD).
- No hardware? Click **Demo** for a fully simulated bus.

## Running

Open `index.html` directly (`file://`), or serve it:

```
python -m http.server 8000      # then open http://localhost:8000/index.html
```

Web Serial needs `file://` or HTTPS. For HTTPS over LAN, see `https_server.py`.

## Features

- **ID List** — live per-ID table with byte-level change highlighting, notes, sorting, filtering.
- **Traffic Dump** — ring-buffered frame log with filtering and CSV export.
- **TX Scheduler** — periodic/one-shot transmit; also mirrors frames sent by other modules
  (Quick Watch, Fuzzer) as read-only rows.
- **Frame Inspector** — per-bit/byte breakdown, CRC-15, bit-stuffing.
- **Graph** — plot any byte or 16-bit signal over time on a canvas.
- **Fuzzing** — transmit crafted frames with varied ID / DLC / payload (bench buses only).
- **ISO-TP tab** with **UDS (ISO 14229)**, **OBD-II (J1979)**, and **KWP2000 (ISO 14230)**
  sub-modes — request palettes, decoders, OBD Quick Watch + PID probe.
- **J1939 tab** with **NMEA 2000** and **ISO 11783 (ISOBUS)** protocol modes — PGN decode,
  TP/ETP/Fast-Packet reassembly, address claim, DM1/DM2 faults.
- **CHAdeMO** — DC-fast-charge session dashboard + frame log.
- **XCP-on-CAN** — passive decode + active master (CONNECT, memory read/write, DAQ).
- **CANopen (CiA 301)** — passive decode + active client (SDO, NMT, SYNC), node map.

Most tabs are self-contained modules and work fully in **Demo** mode.

## Reference pages

Standalone explainers (open from `file://`, no connection needed): `dtc.html`,
`obd2-explainer.html`, `kwp2000-explainer.html`, `uds-explainer.html`,
`nmea2000-explainer.html`, `iso11783-explainer.html`, `ev-charging-explainer.html`,
`xcp-explainer.html`, `canopen-explainer.html`, `can-signals-explainer.html`.

## For contributors

Architecture, wire-format references, data structures, and per-module integration notes live in
[`.claude/core-arch.md`](.claude/core-arch.md) and [`.claude/modules.md`](.claude/modules.md);
project guidance for AI coding agents is in [`CLAUDE.md`](CLAUDE.md).
