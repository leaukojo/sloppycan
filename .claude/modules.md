# Module Documentation

All modules follow the same bolt-on pattern: self-contained JS file, deferred script tag,
integration hooks only in `sloppycan.js` and `index.html`, persistence via `_pending` + `scheduleSave`.

---

## Graph tab (`graph.js`)

Plots signal values over time on a hand-rolled `<canvas>` — no charting library, opens from `file://`.

- **Signal** = `{ frameKey, byteIndex, width:1|2, endian:'le'|'be', signed, name }`. `graphExtract` returns `null` for RTR/empty data, `byteIndex ≥ dlc`, or a word crossing the dlc boundary.
- **Own history.** Each signal owns a ring buffer of `{t, v}` (`Float64Array`, `GRAPH_CAP = 4096`) fed from the `graphIngestFrame` hook. No `dumpLog` backfill.
- **Rendering.** Separate RAF loop + `graphDirty` gate; force-ticks every 250 ms. Per-trace normalized Y (`vmin`/`vmax`, sticky — only ever grow); `↕` button (`graphRescaleSignal`) resets to current buffer.
- **Persistence.** Signal list persists as `graphSignals`; deferred load via `window._graphPending`.

**Integration points:** `ingestFrame` → `if (window.graphIngestFrame) graphIngestFrame(frame)`; `switchViewTab` graph branch + `graphOnShow`; `#frameBody` contextmenu → `window.graphContextMenu`; three persistence functions; `window.graphScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-graph`, `#graphWrap`/`#graphCtxMenu`, `<script src="graph.js" defer>`.

---

## Fuzzing tab (`fuzz.js`)

Transmits crafted frames. All wire I/O goes through `window.fuzzTxFrame` — no transport code in `fuzz.js`.

- **`fuzzCfg`** — persisted config: `idMode`/`isExt`/range/single/obs; `dlcMode`/`dlcFixed`; `payMode`/`randomBytes`/`byteMasks`/`bitGrid`/`bitPat`; `gap`/`burst`. Runtime cursors reset on Start.
- **Sending seam:** `window.fuzzTxFrame(id,isExt,dlc,bytes)` (in `sloppycan.js`) handles `connMode==='gsusb'` branch + `dumpLog`/`frames` bookkeeping.
- **Safety:** Start requires `confirm()`; `fuzzStop()` called from `disconnectSerial`; `fuzzApply` always stops first.
- **Indicator:** `#fuzzActiveBadge` + Stop in TX Scheduler header (always visible).

**Integration points:** `window.fuzzTxFrame`/`fuzzBusReady`/`fuzzObservedIds` (near `frameKey`); `switchViewTab` fuzz branch + `fuzzOnShow`; `disconnectSerial` → `window.fuzzStop()`; three persistence functions (`fuzz` key via `window.fuzzCollect`/`fuzzApply`/`window._fuzzPending`); `window.fuzzScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-fuzz`, `#fuzzWrap`, `#fuzzActiveBadge`, `<script src="fuzz.js" defer>`. CSS: `.fuzz-*` rules in `sloppycan.css`.

---

## OBD-II / J1979 (ISO-TP tab sub-mode, `sloppycan.js` only)

Sub-mode of the ISO-TP/UDS tab. Toggle `#isotpModeUds`/`#isotpModeObd` via `isotpSetProtoMode`. Entering OBD auto-sets Tx/Rx to `7DF`/`7E8` only if they still hold UDS defaults.

- **Request palette** (`OBD_PALETTE`, `obdInit`, `obdSend`) — palette sends go through `isotpSend()` so they're logged. `Clear DTCs (04)` is `confirm()`-gated.
- **Supported-PIDs probe** (`obdProbeStart`/`obdProbeDone`) — walks `01 00/20/40/60`, lights `#obdProbeGrid`.
- **Quick Watch** (`obdWatch*`, `#obdWatchGrid`) — round-robin poller via `obdRequest({log:false})`, not logged.
- **Single in-flight rule:** gated on `isotpPendingEl || isotpRxState || isotpTxQueue.length || isotpFuncMode || isotpRxMap.size`. Responses via `obdCaptureCb` tapped in `isotpMarkDone`/`isotpMarkTimeout`/`isotpMarkError`.
- **Functional addressing (0x7DF):** auto-enables `isotpFuncMode`, routes to `isotpIngestFunctional`, accepts any responder (7E8–7EF / 0x18DAF1xx), keyed per ECU in `isotpRxMap`, rendered as `.isotp-ecu-tag` pills. Multi-frame FC sent to physical ID via `isotpSendFCTo` + `txIdOverride` on `isotpTxCan`.
- **Persistence:** `isotp.proto` + `obdWatch` keys; `window.obdScheduleSave` at startup.
- **Explainer:** `obd2-explainer.html`.

**Revert:** remove toggle markup + `#obdWrap` + `#isotpInputLabel`, the OBD JS section + hooks, `.obd-*` CSS, `obd2-explainer.html`, `demoObdResponse`/`DEMO_OBD_PIDS`.

---

## KWP2000 / ISO 14230 (ISO-TP tab sub-mode, `sloppycan.js` only)

Third option in the ISO-TP protocol toggle (`UDS | OBD-II | KWP2000`). No transport changes.

- **Separate tables:** `KWP_SVC`/`KWP_NRC`/`KWP_DIAG_MODE`. `kwpDecode(bytes)` mirrors `udsDecode` shape.
- **Dispatcher:** `decodePayload(bytes)` → `obdProtoMode === 'kwp' ? kwpDecode : udsDecode`. Used at all three ISO-TP log decode sites.
- **Palette:** `KWP_PALETTE` + `kwpInit()` build `#kwpPalette` (StartComms, StartSession, TesterPresent, ReadECUIdent, ReadByLocalId, ECUReset, StopComms). `kwpSend(bytes)` mirrors `obdSend`.
- **Shared param buttons:** `buildSvcPalette(containerId, palette, sendFn)` builds both `#kwpPalette` and `#udsPalette`. Split buttons (`{label, sid, params}`) open a `.svc-panel` for per-param selects/hex inputs.
- **UDS palette:** `UDS_PALETTE` / `udsInit` / `udsSend` in `#udsWrap`, shown only in UDS mode. Explainer: `uds-explainer.html`.
- **Persistence:** reuses `isotp.proto` key (shared with OBD).
- **Explainer:** `kwp2000-explainer.html`.

**Revert:** remove `KWP_SVC`/`KWP_NRC`/`KWP_DIAG_MODE`/`kwpAscii`/`kwpDecode`/`KWP_PALETTE`/`kwpInit`/`kwpSend`, restore direct `udsDecode` calls at the three log sites, remove `#isotpModeKwp` + `#kwpWrap`, `'kwp'` branches in `isotpSetProtoMode`/`applySettings`/`demoIsoTpRespond`, `kwp2000-explainer.html`.

---

## NMEA 2000 (J1939 tab mode, `j1939.js`)

Protocol-mode of the J1939 tab. `<select id="j1939ProtoSel">` flips `j1939ProtoMode` (`'j1939'`|`'nmea2000'`) via `j1939SetProto`. Tab button reads **"J1939 / N2K"**.

- **Active dictionary:** `j1939ActiveDb()` returns `NMEA2K_DB` in NMEA mode. `j1939SetProto` clears live state on switch; hides **Faults (DM1/DM2)** sub-tab in NMEA mode.
- **`NMEA2K_DB`** (~30 PGNs): bit-offset model `{name, bo, bl, signed, scale, offset, unit, dp, map, str, date, time}` — N2K fields straddle byte boundaries.
- **`n2kDecodeField`:** ≤32-bit via bit extraction; >32-bit byte-aligned float accumulation. Returns same `{name,display,valid}` shape as `j1939DecodeSPN`.
- **Fast Packet** (`n2kFastPacket` Map, key `${pgn}:${sa}:${seq}`): first frame `data[0]&0x1F==0`; continuations carry 7 bytes. Reassembled via `j1939DispatchPGN(..., fromTP=true)` — shown as **FP** badge. Stale slots dropped ~1 s.
- **Persistence:** `j1939Proto` key; `window.j1939GetProto`/`window.j1939Apply`/`window._j1939ProtoPending`; `window.j1939ScheduleSave = scheduleSave` at startup.
- **Demo (NMEA mode only):** `window.j1939DemoFrames()` returns N2K frames. `demoInjectN2k()` ingests on 100 ms timer (all three demo-start spots).
- **Explainer:** `nmea2000-explainer.html` (`#nmea2000LearnLink`, shown only in NMEA mode).

**Revert:** remove `#j1939ProtoSel` + `#nmea2000LearnLink`, `NMEA2K_DB`/`n2kDecodeField`/`n2kFastPacket*`/`j1939SetProto`/`j1939DemoFrames`, `j1939ActiveDb` indirection, NMEA branch in `j1939IngestFrame`, `j1939Proto` persistence key + `j1939ScheduleSave`, `demoInjectN2k` + its three timer lines, `nmea2000-explainer.html`.

---

## ISO 11783 / ISOBUS (J1939 tab mode, `j1939.js`)

Third option in the J1939 protocol-mode dropdown. `j1939ProtoMode` gains `'iso11783'`; `j1939ActiveDb()` returns `ISOBUS_DB`. Standard J1939 TP stays active — only large transfers use ETP. Faults sub-tab stays visible.

- **`ISOBUS_DB`** spreads `J1939_DB` + ag PGNs (WBSD/GBSD 65096/65097, PTO 65093/65094, Hitch 65091/65092, VDS 65256). Task Controller (57344) + VT (0xE600/0xE700) use a per-entry `decode(data)` callback (`isoTcDecode`/`isoVtDecode`).
- **ETP transport** (`isoEtpSessions`, `isoEtpIngestCM`/`isoEtpIngestDT`): ETP.CM on 0xC800, ETP.DT on 0xC700. **DPO trap:** `byteOffset = (dpoOffset + seq − 1) × 7`. Buffer capped at 256 KB. ETP badge in render.
- **Ingest routing:** `iso11783` branch returns early only for ETP frames (0xC8/0xC7), falls through to shared TP + dispatch.
- **Demo (ISOBUS mode only):** `isoDemoFrames()` (branch in `j1939DemoFrames`) emits TECU + ag address claims + a 1792-byte ETP transfer (exercises DPO path). Injected by `demoInjectN2k`.
- **Explainer:** `iso11783-explainer.html` (`#iso11783LearnLink`, shown only in ISOBUS mode).

**Revert:** remove `ISO 11783` `<option>` + `#iso11783LearnLink`, `ISOBUS_*` tables + `isoTcDecode`/`isoVtDecode`, `entry.decode` line in `j1939DecodePGN`, ETP block (`isoEtp*`), `iso11783` branches in `j1939IngestFrame`/`j1939SetProto`/`j1939ActiveDb`/`j1939RenderAddr`, `isoDemoFrames`/`isoEtpDemoFrames`, `iso11783-explainer.html`.

---

## DTC decoder (`dtc.html` standalone page)

Standalone reference page (no app runtime, `file://`-compatible) for looking up DTCs in OBD-II 2-byte, UDS 3-byte+status, or J1939 4-byte SPN+FMI encodings. Inlines faithful copies of the app's decoders. Theme from shared `'isotp-explainer-theme'` localStorage key.

- **`DTC_DB`** — ~500-entry SAE J2012 descriptions (P0xxx + curated U/C/B). Manufacturer-specific codes flagged, never fabricated.
- **Auto-detect:** `decodeToken` sniffs format; bare 4-byte renders both UDS+status and J1939 cards. Batch input splits on comma/newline.
- **URL prefill:** `?q=P0301` or `?bytes=01+90+12+2F&fmt=uds` for in-app deep-links.

**Integration points (in-app deep-links only):**
- `sloppycan.js`: `vHtml` escape-hatch in `udsSection`; `dtcLink`/`dtcHexQ` helpers; `.vHtml` rows at OBD Mode 03/07/0A + UDS 0x19 + single-DTC site.
- `j1939.js`: `j1939RenderDM` wraps the SPN cell in an `<a>` reconstructing the 4 record bytes.

**Revert:** delete `dtc.html`; restore `udsSection` `val` line, remove `dtcLink`/`dtcHexQ` + three `.vHtml` rows; unwrap SPN cell in `j1939.js`.

---

## CHAdeMO (`chademo.js`)

Decodes CHAdeMO DC-fast-charging CAN (11-bit IDs, 500 kbit/s). J1772 and ISO 15118 are not on CAN — a note banner says so and links `ev-charging-explainer.html`.

- **`CHADEMO_MSGS`** — decode table keyed by 11-bit ID. Covers 0x100/0x101/0x102 (vehicle→charger) and 0x108/0x109 (charger→vehicle); v2.0 discharge IDs are `{raw:true}`. `chademoIngestFrame` early-exits on `frame.isExt`.
- **Sub-tabs:** Session (dashboard tiles + flag chips) and Frame Log. `chademoSessionState()` derives coarse state from `lastIds` recency + enable/stop bits.
- **Demo:** `#chademoDemoBtn` → `chademoDemo()` — `setInterval` charging ramp injected via `window.ingestFrame`. Independent of the global Demo button.
- **No persistence** (live-only tab).

**Integration points:** `ingestFrame` → `if (window.chademoIngestFrame) chademoIngestFrame(frame)`; `clearFrames` → `if (window.chademoClear) chademoClear()`; `switchViewTab` + wrap show/hide; `window.ingestFrame = ingestFrame` at startup. `index.html`: `#vtab-chademo`, `#chademoWrap`, `<script src="chademo.js" defer>`. Explainer: `ev-charging-explainer.html`.

**Revert:** delete `chademo.js` + `ev-charging-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear hooks, `window.ingestFrame` line, `#chademoWrap`, `<script>` tag.

---

## XCP-on-CAN (`xcp.js`)

Passively decodes XCP-on-CAN (ASAM MCD-1 XCP) and acts as an active XCP master. Two configurable CAN IDs: CRO (master→slave, default `0x7E0`) and DTO (slave→master, default `0x7E8`).

- **Decode tables:** `XCP_CMD`, `XCP_ERR`/`XCP_EV`, `XCP_RESOURCE` — per real ASAM XCP spec (`GET_DAQ_PROCESSOR_INFO=0xDA`, `START_STOP_SYNCH=0xDD`, `ERR_CMD_UNKNOWN=0x13`).
- **DTO classification:** `0xFF` RES, `0xFE` ERR, `0xFD` EV, `0xFC` SERV, `0x00–0xFB` DAQ.
- **Command↔response pairing:** RES/ERR decoded in context of last CRO. `xcpDecodeRes` parses CONNECT (byte order from `COMM_MODE_BASIC` bit0), GET_STATUS, GET_ID, UPLOAD/SHORT_UPLOAD, GET_DAQ_PROCESSOR_INFO.
- **Active master:** single in-flight `xcpPending` + `xcpArmTimer`. `xcpSend` gates on `xcpReady()` + one-time session `confirm()`, sends via `window.fuzzTxFrame`. `xcpReadIdViaUpload` chains sequential UPLOADs. Write memory behind second confirm.
- **DAQ flood guard:** DTOs coalesced in `xcpPushLog` within `XCP_DAQ_COALESCE_MS`.
- **Persistence:** `xcp` key: `cro`/`dto`/`isExt`/`byteOrder`.

**Integration points:** `ingestFrame` → `xcpIngestFrame`; `clearFrames` → `xcpClear`; `disconnectSerial` → `xcpStop`; `switchViewTab` + `xcpOnShow`; three persistence functions (`xcp` key via `xcpCollect`/`xcpApply`/`_xcpPending`); `window.xcpScheduleSave = scheduleSave` + `window.xcpDemoActive = () => demoMode` at startup. `index.html`: `#vtab-xcp`, `#xcpWrap`, `<script src="xcp.js" defer>`. Explainer: `xcp-explainer.html`.

**Revert:** delete `xcp.js` + `xcp-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear/disconnect hooks, `xcp` persistence key + startup lines, `#xcpWrap`, `<script>` tag.

---

## CANopen (`canopen.js`)

Passively decodes CANopen (CiA 301) and acts as an active client. COB-ID = `(functionCode << 7) | nodeId`. **11-bit only** — exits early on `frame.isExt`.

- **Classification:** `coClassify(id)` → `{node, fc, type, kind}`. Covers NMT 0x000, SYNC/EMCY 0x080, TIME 0x100, TPDO/RPDO 0x180–0x500, SDO tx/rx 0x580/0x600, heartbeat 0x700, LSS 0x7E4/0x7E5. Any 11-bit frame is classified — non-CANopen traffic showing up is correct passive behaviour.
- **SDO:** `coDecodeSdo(d, dir)` — expedited read/write, segmented (reassembled to text+hex), abort (4-byte LE code).
- **Node map:** `coNodes: Map<nodeId,{state,lastSeen,types:Set}>` from heartbeat/NMT/any traffic.
- **Active client:** single in-flight `coPending` + `coArmTimer`. `coSdoRead`/`coSdoWrite` (write adds own confirm), `coNmt`, `coSync`. All TX via `coTx` → `window.fuzzTxFrame`.
- **Persistence:** `canopen` key: `node`/`sdoTimeout`/`sdoReqId`/`sdoRspId`.

**Integration points:** `ingestFrame` → `canopenIngestFrame`; `clearFrames` → `canopenClear`; `disconnectSerial` → `canopenStop`; `switchViewTab` + `canopenOnShow`; three persistence functions (`canopen` key via `canopenCollect`/`canopenApply`/`_canopenPending`); `window.canopenScheduleSave = scheduleSave` + `window.canopenDemoActive = () => demoMode` at startup. `index.html`: `#vtab-canopen`, `#canopenWrap`, `<script src="canopen.js" defer>`. Explainer: `canopen-explainer.html`.

**Revert:** delete `canopen.js` + `canopen-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear/disconnect hooks, `canopen` persistence key + startup lines, `#canopenWrap`, `<script>` tag. **Future work:** user-supplied PDO mapping; SDO block transfer.
