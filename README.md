# sloppyCAN

A browser-based CAN bus monitor for **SLCAN** and **gs_usb** (candleLight / CANable / RAMN) USB-to-CAN adapters.
Works in Chrome and Edge only (Web Serial API for SLCAN; WebUSB for gs_usb). No backend, no install required.
Pick the adapter type with the **Adapter** dropdown in the header.

> ⚠️ **Warning:** This project was made with Claude Sonnet 4.6. Review and test before relying on it.

## SLCAN Protocol

Frames are CR-terminated ASCII strings:
- `tIIILDD...`    Standard data frame (11-bit ID, 3 hex digits)
- `TIIIIIIIILDD`  Extended data frame (29-bit ID, 8 hex digits)
- `rIIIL`         Standard RTR frame
- `RIIIIIIIIL`    Extended RTR frame

Adapter commands:
- `V` → version `Vxxyy`, `N` → serial number
- `O` open normal, `L` open listen-only, `C` close
- Errors return BEL (0x07)

## gs_usb Protocol

Binary WebUSB protocol used by candleLight / CANable / RAMN adapters. Selected via the **Adapter**
dropdown. Frames are exchanged over bulk endpoints; bitrate/mode are set with vendor control
transfers (`HOST_FORMAT`, `BT_CONST`, `BITTIMING`, `MODE`). Classic CAN only (no CAN-FD).

The classic host frame is **variable length**: a 12-byte header (`echo_id`, `can_id`, `dlc`,
`channel`, `flags`, `reserved`) followed by exactly `dlc` data bytes — i.e. `12 + dlc` bytes on the
wire, one frame per transfer (plus an optional 4-byte timestamp only if enabled). RX frames carry
`echo_id = 0xFFFFFFFF`; the device's echo of a transmitted frame carries the host's echo id and is
ignored. Bit timing is computed from the Speed dropdown targeting an ~87.5% sample point, clamped to
the device's `BT_CONST` limits. See `openGsUsb` / `gsUsbPump` / `gsCalcBitTiming` / `gsUsbPackFrame`
in `sloppycan.js`; the reference RAMN firmware is vendored under `RAMNV1/`.

## Architecture

Split across six files, no build step:
- `index.html` — static layout skeleton, links the CSS and JS
- `sloppycan.css` — dark theme, CSS variables, component styles (~1000 lines)
- `sloppycan.js` — all application logic (~2950 lines)
- `j1939.js` — self-contained, optional J1939 **+ NMEA 2000 + ISO 11783 (ISOBUS)** decoder (remove the `<script src="j1939.js">` tag and `#j1939Wrap` div to revert)
- `graph.js` — self-contained, optional [Graph tab](#graph-tab) (remove the `<script src="graph.js">` tag and `#graphWrap` div to revert)
- `fuzz.js` — self-contained, optional [Fuzzing tab](#fuzzing-tab) (remove the `<script src="fuzz.js">` tag and `#fuzzWrap` div to revert)
- `chademo.js` — self-contained, optional [CHAdeMO tab](#chademo-ev-charging) (remove the `<script src="chademo.js">` tag and `#chademoWrap` div to revert)
- `xcp.js` — self-contained, optional **XCP-on-CAN tab** — passive decode + active master (CONNECT, read/write memory, DAQ) (remove the `<script src="xcp.js">` tag and `#xcpWrap` div to revert)
- `canopen.js` — self-contained, optional **CANopen tab** — passive decode + active client (SDO read/write, NMT, SYNC) (remove the `<script src="canopen.js">` tag and `#canopenWrap` div to revert)

### Script sections in `sloppycan.js` (marked with `// ── Section ──` comments)

1. State variables and `RingBuffer` class — O(1) push, used for dumpLog
2. TX Scheduler: `renderTxRows`, `txDataTokens`/`txDataBytes`, `txSetExt`, `txSetDlc`, `txSetPeriod`, `txSetEnabled`, `txBuildSlcan`, `txSendOne`, `txSendOnce`, `stopAllTx`, `toggleTxSuspend`, `txAutoDisable`, `txValidateData`
3. Utility: `frameKey`, `resetConnectionState`, `getFilter`, `applyFilter`, `log`, `termLog`, `escHtml`
4. Serial layer: `sendCommand`, `connectSerial`, `disconnectSerial`, `readLoop`, `processBuffer`, `parseSLCAN`; Android WebUSB CDC path: `openWebUSBCDC`, `usbSerialPump`; gs_usb (WebUSB) path: `openGsUsb`, `gsUsbPump`, `gsCalcBitTiming`, `gsSetBitTiming`, `gsSetMode`, `gsUsbPackFrame`
5. Frame ingestion: `ingestFrame`
6. Rendering: `updateStats`, `rerenderTable`, `renderDump`, RAF loop
7. Sorting: `setSort` · View tabs: `switchViewTab` · Notch: `notchClick`, `notchFinish` · Bus/Pause: `updateBusPauseBtn`, `busPauseClick`, `busOpen`
8. Frame Inspector: `inspectFrame`, `clearInspector`, CRC-15, bit stuffing
9. Demo mode: `startDemo`, `demoTick`, CRC-32/ISO-HDLC
10. ISO-TP / UDS / OBD-II / KWP2000: `isotpSend`, `isotpIngestFrame`, `decodePayload`, `udsDecode`, `obdDecode`, `kwpDecode`
11. CSV export: `exportDumpCSV` · Theme toggle · Startup

## Key Data Structures

```js
// frameKey = "E:<id>" (EXT) or "S:<id>" (STD)

frames: Map<frameKey, {
  id, isExt, isRtr, dlc,
  data: number[],
  byteChangedAt: number[],   // timestamp of last change per byte index
  count, firstSeen, lastSeen,
  timestamps: number[],      // ring-buffered, used for fps calculation
  hasRx: bool, hasTx: bool
}>

dumpLog: RingBuffer(100000) of { ts, isTx, id, isExt, isRtr, dlc, data }

notchedBytes: Map<frameKey, Set<byteIndex>>          // changed during notch → amber
stableBytes:  Map<frameKey, Map<byteIndex, value>>   // unchanged during notch → grey
                                                     // grey only while value matches snapshot
notchSnapshot: Map<frameKey, { ts: number[], data: number[] }>  // taken at notch start

frameNotes: Map<frameKey, string>   // user notes, survives clear
```

## Byte Colour Semantics (ID List, RX frames only)

| Colour | Condition |
|--------|-----------|
| Green  | `byteChangedAt[i]` within `hotMs` of now |
| Amber  | byte index in `notchedBytes[key]` |
| Grey   | byte in `stableBytes[key]` AND current value matches snapshot |
| White  | none of the above |

| Blue   | TX-only frame (`hasRx=false`) — subtle, `.byte.tx-byte` |

TX frames that also have RX history use normal RX colouring.

## Filter System

`getFilter()` returns:
```js
{ frameType, dataType, ids, idsExclude, dataRaw,
  onlyHighlighted, onlyUnseen, onlyRx }
```

`ids` is `Array<{range:bool, val?, lo?, hi?}>` — supports `"024"` and `"000-02F"`.

`applyFilter(f, flt)` works for both frame objects and dump entries.

- **Only unseen**: ≥1 unnotched byte (white or green), RX frames only
- **Only highlighted**: subset — ≥1 green byte, RX frames only
- **Only RX**: hides TX-only frames (`hasTx && !hasRx`)

## Terminal Mode

When Serial Terminal tab is active, `terminalMode = true`.  
`readLoop()` accumulates bytes in `termBuffer` (not `frameBuffer`).  
Switching away flushes both buffers, sets `terminalMode = false`.  
In demo mode, `sendCommand()` is a no-op except when `terminalMode = true`.

## Demo Mode

9 simulated IDs, no serial port needed. Permanent for the session (reload to exit).  
Frame format: `[0x00, 0x00]` payload + 2B counter BE + 4B CRC-32/ISO-HDLC LE.  
IDs `0x024/0x039/0x062` at 10 ms; others at 100 ms.

## Graph Tab

Plots signal values over time on a canvas (self-contained `graph.js`). A **signal** is a single byte
or a 16-bit word (two consecutive bytes, little/big-endian, optionally signed). Add one from the
in-tab picker (ID → byte/width), from a per-byte button in the **Frame Inspector**, or by
right-clicking an **ID List** row.

- Multiple traces overlay on one time axis, each **auto-scaled to its own range** (the legend shows
  current value + min/max). The vertical scale is *sticky* — it only grows; the legend **↕** button
  rescales a trace to its current data.
- Controls: visible window (10/30/60 s), **Pause** (freeze), drag to **pan** and wheel to **zoom**
  into the buffered history, and **Live** to snap back to following the live edge.
- Hover for a crosshair + per-trace readout; the nearest trace gets **Y-axis value labels**.
- When picking an ID, its **note** (from the Inspector) is shown next to the selector to help you
  choose what to add. A trace inherits its ID's row colour (set in the Inspector). Click a legend
  name to **rename** the trace.
- History is live-only (own per-signal ring buffer, fed from `ingestFrame`; no backfill). The signal
  list is saved **per workspace**.

## Fuzzing Tab

Transmits crafted CAN frames with varied ID / DLC / payload (self-contained `fuzz.js`).
**Use only on a bench/test bus you control**: fuzzing a live vehicle can trigger unintended ECU behaviour.

- **Target ID**: range (start..end, scanned sequentially or randomly), pick from IDs already in the
  **ID List**, or a single fixed ID; standard or extended.
- **DLC**: fixed (0–8), random, or incrementing.
- **Payload**: random bytes (choose which indices vary), per-byte mask (each byte fixed/random/
  increment, like cangen `-D`), or an 8×8 **bit grid** (each bit *never*-set / *always*-set /
  *fuzzed*) with sequential / sweep / random bit patterns.
- **Timing**: inter-frame gap (ms) + frames-per-tick burst.
- Start/Stop on the tab (one-time confirm) plus a global **Fuzzing** badge + Stop in the TX
  Scheduler header, visible while watching the ID List or Traffic Dump. Stops automatically on
  disconnect; config is saved **per workspace** and never auto-runs on load.

## OBD-II / J1979

A sub-mode of the **ISO-TP / UDS** tab (toggle **UDS ↔ OBD-II** at the top of the tab). OBD-II rides
the same ISO-TP transport and reuses the existing decoder, surfacing it as a first-class feature:

- **One-click requests**: Engine RPM, vehicle speed, coolant, throttle, MAF, fuel level, monitors/MIL,
  stored / pending / permanent DTCs, VIN, CalID — plus a Mode + PID picker for anything else.
  `Clear DTCs` is confirmation-gated (it resets the MIL and readiness monitors).
- **Probe supported PIDs**: walks the `01 00/20/40/60` bitmasks and lights a grid of what the ECU supports.
- **Quick Watch**: tick PIDs (RPM, speed, coolant…), pick a poll interval, Start — live value tiles
  update in place via a single-in-flight round-robin poller (watch polls stay out of the conversation log).
- Defaults to broadcast `7DF` / response `7E8` (editable; 29-bit `18DB33F1` works too). All TX is disabled
  in **Listen-only** or when the bus is closed, and stops automatically on disconnect.
- **Functional addressing** is handled properly: a manual broadcast to `7DF` (or `18DB33F1`) collects
  replies from *every* ECU (7E8–7EF / 0x18DAF1xx), each shown as a tagged `[7E8]` sub-row, and multi-frame
  responses send Flow Control to the responder's physical ID. (Quick Watch/Probe stay engine-only.)
- Works fully in **Demo mode** (the demo ECU answers with animated values + fake DTCs).
  See [`obd2-explainer.html`](obd2-explainer.html) for how it all works.

## KWP2000 / ISO 14230

A third sub-mode of the **ISO-TP / UDS** tab (toggle **UDS ↔ OBD-II ↔ KWP2000**). KWP2000 is
UDS's predecessor — KWP2000-on-CAN (ISO 15765-3) rides the **same ISO-TP transport**; only the
application layer differs, so this just swaps the decode tables (no transport changes):

- **KWP service-ID & NRC decoding** — separate tables from UDS, because several SIDs collide but
  mean different things (`21` ReadDataByLocalIdentifier, `1A` ReadECUIdentification,
  `81`/`82` Start/StopCommunication). Payload decoders for diagnostic mode, RLI + data, and the
  mostly-ASCII ECU identification response.
- **Request palette**: StartComms, StartSession, TesterPresent, ReadECUIdent, ReadByLocalId,
  ECUReset, StopComms — each transmits and is logged like a manual send. Free-form hex still works.
- Tx/Rx IDs are left as-is when you switch (no auto-adopt). TX is gated on bus-open + not Listen-only.
- Works fully in **Demo mode** (the demo ECU answers known services positively, unknown ones with
  `7F sid 11`). See [`kwp2000-explainer.html`](kwp2000-explainer.html) for how it all works.

## NMEA 2000

A **protocol mode of the J1939 / N2K tab** — pick **NMEA 2000** from the dropdown in the tab
header. NMEA 2000 is J1939 at the wire level (29-bit IDs, same PGN structure, same ISO address
claim), so it reuses the J1939 ID parser and just swaps in a marine PGN dictionary + transport:

- **~30 marine PGNs** with full field decode — vessel heading, attitude, rate of turn, position
  (lat/lon), COG/SOG, GNSS, water depth/speed, wind, environmental (temperature/humidity/pressure),
  and engine/electrical (engine rpm + dynamic params, fluid level, battery status, DC status).
- **Fast Packet** reassembly — NMEA 2000's inline multi-frame transport; reassembled messages get
  an **FP** badge.
- **Address Claim** shows marine **device-class** / function names; the **Faults** sub-tab hides
  (N2K has no DM1/DM2).
- Bus runs at **250 kbit/s** — set the header Speed dropdown to 250k for a real backbone.
- Works in **Demo mode** (streams heading, RPM, position, wind + a Fast-Packet engine message).
  See [`nmea2000-explainer.html`](nmea2000-explainer.html) for how it all works.

## ISO 11783 (ISOBUS)

A third **protocol mode of the J1939 / N2K tab** — pick **ISO 11783** from the dropdown.
ISOBUS is the agricultural extension of J1939: identical 29-bit data link, plus an ag PGN set,
agriculture-industry address claims, and one new transport for large messages.

- **Agricultural PGNs** decoded — wheel/ground speed & distance, rear/front PTO (speed +
  setpoint), rear/front hitch position, vehicle direction/speed, plus the full J1939 set
  (tractors speak standard engine/CCVS PGNs too).
- **Task Controller** process data — command, element, DDI (with common-DDI labels), value.
  **Virtual Terminal** messages are labelled by function byte (object-pool rendering is future
  work).
- **Extended Transport Protocol (ETP)** reassembly for messages > 1785 bytes — honours the
  **Data Packet Offset (DPO)**; reassembled messages get an **ETP** badge.
- **Address Claim** shows ISOBUS **device-class** names (Tractor, Sprayer, Harvester, …).
- Standard J1939 TP and the **Faults (DM1/DM2)** sub-tab stay active. Bus runs at **250 kbit/s**.
- Works in **Demo mode** (tractor speed/PTO/hitch, a Task-Controller value, ag address claims +
  a 1792-byte ETP object-pool transfer). See [`iso11783-explainer.html`](iso11783-explainer.html).

## DTC decoder

[`dtc.html`](dtc.html) is a **standalone reference page** (no connection, no build, opens from
`file://`) for looking up Diagnostic Trouble Codes. Paste a code (`P0301`) or raw bytes from any
of the three on-wire encodings — **OBD-II / SAE J2012** (2-byte), **UDS / ISO 14229** (3-byte +
status), or **J1939** SPN+FMI (4-byte DM record) — and get a structural breakdown plus a generic
SAE description.

- **Auto-detect** sniffs the format; a bare 4-byte value is ambiguous (UDS+status vs J1939) so
  **both interpretations** are shown side by side. Batch input (comma/newline separated) too.
- **~500-entry generic description database** (the public SAE J2012 P0xxx set + curated U/C/B);
  manufacturer-specific codes decode structurally and are flagged (no fabricated descriptions).
- **Deep-linked from the app** — codes in the OBD-II DTC list, the UDS ReadDTC log rows, and the
  J1939 **Faults (DM1/DM2)** table are clickable (`↗`) and open `dtc.html` pre-filled.

## CHAdeMO (EV charging)

A dedicated **CHAdeMO** tab decodes the DC-fast-charging CAN traffic. Of the EV-charging
protocols, only CHAdeMO is actually on a CAN bus — **J1772** is analog Control-Pilot PWM and
**ISO 15118** is PLC/IPv6, neither visible to a CAN adapter (a note banner says so).

- **Live session dashboard** — SoC, present vs target voltage, present vs requested current,
  remaining time, vehicle/charger protocol numbers, connector-lock, and a coarse state
  (idle → capability exchange → charging → stop) derived from the message flow + status bits.
- **Flag chips** — the 0x102 fault/status and 0x109 charger-status bitfields rendered as labeled
  chips that light when set.
- **Frame Log** — the decoded CHAdeMO message set (0x100/0x101/0x102/0x108/0x109; v2.0
  discharge 0x118/0x200–0x209 are name + raw). Unknown bytes shown raw, the protocol-number byte
  always surfaced (handles revision drift).
- **Demo session** button replays a full handshake + charging ramp — no charger needed.
- **Explainer** — [`ev-charging-explainer.html`](ev-charging-explainer.html) covers all three
  protocols and why only CHAdeMO is on CAN.

## XCP-on-CAN (measurement & calibration)

A dedicated **XCP** tab decodes XCP-on-CAN (ASAM MCD-1 XCP) traffic **and can drive the bus as
an active XCP master**. XCP is how calibration tools read/write ECU memory and stream signal
data (DAQ). It uses two configurable CAN IDs: **CRO** (commands, master→slave) and **DTO**
(responses + DAQ data, slave→master); defaults `0x7E0`/`0x7E8`.

- **Passive decode** — every CRO command and DTO packet, with responses decoded *in the context
  of the command they answer* (a bare `FF` reads as the CONNECT result, or as raw memory bytes
  after UPLOAD). DTO classes: RES / ERR / EV / SERV / DAQ. Byte order is learned from CONNECT
  (with a manual override). Command + error codes follow the ASAM XCP standard.
- **Active master** — Connect / Get Status / Get Comm Mode Info / Get ID, a **Read memory** form
  (`SHORT_UPLOAD` → hex dump) and a guarded **Write memory** form (`SET_MTA` + `DOWNLOAD`, behind
  a second confirm — it modifies ECU memory). All TX is gated on a live bus + listen-only off + a
  one-time session confirm. Single transaction in flight, with a timeout.
- **DAQ** — Get DAQ Info + Start/Stop, and passive classification of incoming DAQ data packets by
  PID (coalesced so a fast stream can't flood the UI). Full DAQ-list authoring is future work.
- **Demo slave** — with Demo mode on, a simulated XCP slave answers every command (including a
  live DAQ stream) so the whole master flow works with no hardware.
- **Explainer** — [`xcp-explainer.html`](xcp-explainer.html) covers CRO/DTO, the CONNECT
  handshake + byte order, reads/writes, and DAQ.

## CANopen (CiA 301)

A dedicated **CANopen** tab decodes CANopen traffic **and can drive the bus as an active
client**. CANopen splits the 11-bit CAN ID into a **COB-ID** = function code + node-ID, carrying
NMT, SYNC, EMCY, TPDO/RPDO, SDO and heartbeat for up to 127 nodes — all 11-bit.

- **Passive decode** — every 11-bit frame is classified by its COB-ID (no payload inspection
  needed): NMT commands, heartbeat/NMT-state, EMCY (error code + class + register bits), SYNC,
  TIME, SDO (expedited read/write with value, segmented reassembly, abort-code table), and PDO
  (raw bytes + which TPDO/RPDO of which node — the object-dictionary mapping isn't on the wire).
- **Node map** — one row per discovered node with a coloured **state chip** (Operational /
  Pre-Operational / Stopped / Boot-up) from heartbeat/NMT, last-seen, and which message types it
  emits.
- **Active client** — an **SDO client** (read = upload, write = download, expedited; segmented
  reads reassembled), **NMT** buttons (Start / Stop / Pre-Op / Reset Node / Reset Comm, per node
  or broadcast), and **SYNC**. All TX is gated on a live bus + listen-only off + a one-time
  session confirm (writes add their own confirm); one SDO transaction in flight, with a timeout.
- **Demo node** — with Demo mode on, two simulated nodes emit heartbeats + a TPDO and answer SDO
  reads (device type, segmented device name), and NMT commands flip a node's state live.
- **Explainer** — [`canopen-explainer.html`](canopen-explainer.html) covers the COB-ID split,
  the predefined connection set, NMT/heartbeat, EMCY, and the SDO read/write handshake.

## Suggested Features

- Signal decoding (DBC-lite: name, offset, bit length, scale, unit)
- Session recording and replay (JSON/CSV export + timed playback)
- Per-ID statistics tab (min/max/mean, histogram)
- Scripting/triggers (JS expression → alert or auto-TX)
- Bit timing selector (send `S` command before `O`, common speeds dropdown)
- Export ID list or dump as CSV/JSON (with notes)
- Multi-adapter support (two ports simultaneously)