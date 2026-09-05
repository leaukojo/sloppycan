# Module Documentation

All modules follow the same bolt-on pattern: a deferred script tag, integration hooks in
`sloppycan.js` and `index.html`, persistence via `_pending` + `scheduleSave`. Modules may reuse
shared core helpers exposed on `window.*` (`withTxLock`, `canRelTs`/`canHexBytes`/`canParseIntAuto`,
`txReady`, `fuzzTxFrame`) rather than re-implementing them. The per-module **Integration points**
lists below double as a map of exactly where each module plugs into the core.

> The explainer/reference pages named below live in the `explainers/` folder; in-app links
> reference them as `explainers/<page>.html`.

---

## Graph tab (`graph.js`)

Plots signal values over time on a hand-rolled `<canvas>` - no charting library, opens from `file://`.

- **Signal** = `{ frameKey, byteIndex, width:1|2, endian:'le'|'be', signed, name }`. `graphExtract` returns `null` for RTR/empty data, `byteIndex ≥ dlc`, or a word crossing the dlc boundary.
- **Own history.** Each signal owns a ring buffer of `{t, v}` (`Float64Array`, `GRAPH_CAP = 4096`) fed from the `graphIngestFrame` hook. No `dumpLog` backfill.
- **Rendering.** Separate RAF loop + `graphDirty` gate; live redraw capped at ~30 fps (33 ms) with a 750 ms id-picker refresh tick. Per-trace normalized Y (`vmin`/`vmax`, sticky - only ever grow); `↕` button (`graphRescaleSignal`) resets to current buffer.
- **Persistence.** Signal list persists as `graphSignals`; deferred load via `window._graphPending`.

**Integration points:** `ingestFrame` → `if (window.graphIngestFrame) graphIngestFrame(frame)`; `switchViewTab` graph branch + `graphOnShow`; `#frameBody` contextmenu → `window.graphContextMenu`; three persistence functions; `window.graphScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-graph`, `#graphWrap`/`#graphCtxMenu`, `<script src="graph.js" defer>`.

---

## Fuzzing tab (`fuzz.js`)

Transmits crafted frames. All wire I/O goes through `window.fuzzTxFrame` - no transport code in `fuzz.js`.

- **`fuzzCfg`** - persisted config: `idMode`/`isExt`/range/single/obs; `dlcMode`/`dlcFixed`; `payMode`/`randomBytes`/`byteMasks`/`bitGrid`/`bitPat`; `gap`/`burst`. Runtime cursors reset on Start.
- **Sending seam:** `window.fuzzTxFrame(id,isExt,dlc,bytes)` (in `sloppycan.js`) handles `connMode==='gsusb'` branch + `dumpLog`/`frames` bookkeeping (via the shared `recordTxFrame` helper, also used by `txSendOne`/`isotpTxCan`).
- **TX gate:** `window.txReady()` (core) = open bus AND not listen-only. Modules (fuzz/xcp/canopen) call it instead of reaching into the `#listenOnly` DOM id directly; each keeps a local fallback for when the core fn is absent.
- **Safety:** Start requires `confirm()`; `fuzzStop()` called from `disconnectSerial`; `fuzzApply` always stops first.
- **Indicator:** `#fuzzActiveBadge` + Stop in TX Scheduler header (always visible).

**Integration points:** `window.fuzzTxFrame`/`fuzzBusReady`/`fuzzObservedIds` (near `frameKey`); `switchViewTab` fuzz branch + `fuzzOnShow`; `disconnectSerial` → `window.fuzzStop()`; three persistence functions (`fuzz` key via `window.fuzzCollect`/`fuzzApply`/`window._fuzzPending`); `window.fuzzScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-fuzz`, `#fuzzWrap`, `#fuzzActiveBadge`, `<script src="fuzz.js" defer>`. CSS: `.fuzz-*` rules in `sloppycan.css`.

---

## OBD-II / J1979 (ISO-TP tab sub-mode; UI in `sloppycan.js`, decoders in `diag-parse.js`)

Sub-mode of the ISO-TP/UDS tab. Toggle `#isotpModeUds`/`#isotpModeObd` via `isotpSetProtoMode`. Each proto has its own remembered Tx/Rx (`isotpModeIds`, seeded with defaults and kept fresh by `isotpIdInput`); switching modes loads the entering mode's pair, so an emptied/invalid field is discarded and a mode's last valid IDs are restored on return.

- **Request palette** (`OBD_PALETTE`, `obdInit`, `obdSend`) - palette sends go through `isotpSend()` so they're logged. `Clear DTCs (04)` is `confirm()`-gated.
- **Supported-PIDs probe** (`obdProbeStart`/`obdProbeDone`) - walks `01 00/20/40/60`, lights `#obdProbeGrid`.
- **Quick Watch** (`obdWatch*`, `#obdWatchGrid`) - round-robin poller via `obdRequest({log:false})`, not logged.
- **Single in-flight rule:** gated on `isotpPendingEl || isotpRxState || isotpTxQueue.length || isotpFuncMode || isotpRxMap.size`. Responses via `obdCaptureCb` tapped in `isotpMarkDone`/`isotpMarkTimeout`/`isotpMarkError`.
- **Functional addressing (0x7DF):** auto-enables `isotpFuncMode`, routes to `isotpIngestFunctional`, accepts any responder (7E8–7EF / 0x18DAF1xx), keyed per ECU in `isotpRxMap`, rendered as `.isotp-ecu-tag` pills. Multi-frame FC sent to physical ID via `isotpSendFCTo` + `txIdOverride` on `isotpTxCan`.
- **Persistence:** `isotp.proto` + `obdWatch` keys; `window.obdScheduleSave` at startup.
- **Explainer:** `obd2-explainer.html`.

**Revert:** remove toggle markup + `#obdWrap` + `#isotpInputLabel`, the OBD JS section + hooks, `.obd-*` CSS, `obd2-explainer.html`, `demoObdResponse`/`DEMO_OBD_PIDS`.

---

## KWP2000 / ISO 14230 (ISO-TP tab sub-mode; tables/decoder in `diag-parse.js`, UI in `sloppycan.js`)

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

Protocol-mode of the J1939 tab. An `.obd-proto-toggle` button group (`#j1939ProtoJ1939` / `#j1939ProtoNmea2000` / `#j1939ProtoIso11783`, on the **left** of the sub-tab bar, like ISO-TP) flips `j1939ProtoMode` via `j1939ProtoClick(mode)` → `j1939SetProto` (which drives the buttons' `.active` state). In Demo mode the toggle routes through `window.demoMaybeSwitch` (switches demo base traffic, prompted); otherwise it swaps the dictionary + persists. Tab button reads **"J1939 / N2K"**.

- **Active dictionary:** `j1939ActiveDb()` returns `NMEA2K_DB` in NMEA mode. `j1939SetProto` clears live state on switch; hides **Faults (DM1/DM2)** sub-tab in NMEA mode.
- **`NMEA2K_DB`** (~30 PGNs): bit-offset model `{name, bo, bl, signed, scale, offset, unit, dp, map, str, date, time}` - N2K fields straddle byte boundaries.
- **`n2kDecodeField`:** ≤32-bit via bit extraction; >32-bit byte-aligned float accumulation. Returns same `{name,display,valid}` shape as `j1939DecodeSPN`.
- **Fast Packet** (`n2kFastPacket` Map, key `${pgn}:${sa}:${seq}`): first frame `data[0]&0x1F==0`; continuations carry 7 bytes. Reassembled via `j1939DispatchPGN(..., fromTP=true)` - shown as **FP** badge. Stale slots dropped ~1 s.
- **Persistence:** `j1939Proto` key; `window.j1939GetProto`/`window.j1939Apply`/`window._j1939ProtoPending`; `window.j1939ScheduleSave = scheduleSave` at startup.
- **Demo:** `window.j1939DemoFrames()` returns the frame set for the active mode - `j1939BaseDemoFrames()` (plain J1939: EEC1/ET1/CCVS1/VEP1/Fuel + periodic address claim), N2K frames (NMEA), or `isoDemoFrames()` (ISOBUS). Ingested by `demoInjectN2k()` on a 100 ms timer, started by the demo base-traffic engine (`demoStartBaseTimers`) when a j1939-family base traffic is active. See core-arch.md "Demo base-traffic engine".
- **Explainer:** `nmea2000-explainer.html` (`#nmea2000LearnLink`, shown only in NMEA mode).

**Revert:** remove the `.obd-proto-toggle` button group + `#nmea2000LearnLink`, `NMEA2K_DB`/`n2kDecodeField`/`n2kFastPacket*`/`j1939SetProto`/`j1939ProtoClick`/`j1939DemoFrames`/`j1939BaseDemoFrames`, `j1939ActiveDb` indirection, NMEA branch in `j1939IngestFrame`, `j1939Proto` persistence key + `j1939ScheduleSave`, `demoInjectN2k` (driven by the demo base-traffic engine), `nmea2000-explainer.html`.

---

## ISO 11783 / ISOBUS (J1939 tab mode, `j1939.js`)

Third option in the J1939 protocol-mode dropdown. `j1939ProtoMode` gains `'iso11783'`; `j1939ActiveDb()` returns `ISOBUS_DB`. Standard J1939 TP stays active - only large transfers use ETP. Faults sub-tab stays visible.

- **`ISOBUS_DB`** spreads `J1939_DB` + ag PGNs (WBSD/GBSD 65096/65097, **PTO 65091/65092, Hitch 65093/65094** — those two pairs were recorded the other way round until `isobus.js` checked them against isobus.net, VDS 65256). Task Controller (57344) + VT (0xE600/0xE700) use a per-entry `decode(data)` callback (`isoTcDecode`/`isoVtDecode`).
- **ETP transport** (`isoEtpSessions`, `isoEtpIngestCM`/`isoEtpIngestDT`): ETP.CM on 0xC800, ETP.DT on 0xC700. **DPO trap:** `byteOffset = (dpoOffset + seq − 1) × 7`. Buffer capped at 256 KB. ETP badge in render.
- **Ingest routing:** `iso11783` branch returns early only for ETP frames (0xC8/0xC7), falls through to shared TP + dispatch.
- **Demo (ISOBUS mode):** `isoDemoFrames()` (branch in `j1939DemoFrames`) emits TECU + ag address claims + a 1792-byte ETP transfer (exercises DPO path). Injected by `demoInjectN2k` when ISOBUS is the active demo base traffic.
- **Explainer:** `iso11783-explainer.html` (`#iso11783LearnLink`, shown only in ISOBUS mode).

**Revert:** remove `ISO 11783` `<option>` + `#iso11783LearnLink`, `ISOBUS_*` tables + `isoTcDecode`/`isoVtDecode`, `entry.decode` line in `j1939DecodePGN`, ETP block (`isoEtp*`), `iso11783` branches in `j1939IngestFrame`/`j1939SetProto`/`j1939ActiveDb`/`j1939RenderAddr`, `isoDemoFrames`/`isoEtpDemoFrames`, `iso11783-explainer.html`.

---

## The J1939 request path (`j1939.js`)

Most of J1939 is broadcast. A handful of parameter groups have a J1939-71 transmission repetition rate of literally **"On request"** — the frame does not exist until something asks. PGN **59904** (`0xEA00`, RQST) is the ask: three bytes, the 24-bit PGN, little-endian, to one address or the global `0xFF`. Both halves live here, and the section is what retired the `speed_limit` and `engine_hours` coverage opt-outs, and what `axle_load` was declared `onRequest` against from the start.

- **Client:** the bar above the sub-panes (`#j1939ReqPgn` / `#j1939ReqDa` / `#j1939ReqPreset` / `#j1939ReqStatus`) → `j1939SendRequest()`. Transmits from **`0xF9`**, J1939-81's Off-Board Diagnostic-Service Tool #1, through `window.canForward` — so the request really goes out and the answer really comes back through `ingestFrame`, rather than being short-circuited internally.
- **Server:** `j1939ServeRequest(parsed, data)`, called from `j1939IngestFrame` **before the per-mode branches** — the Mode dropdown picks how frames are displayed and must not decide what is on the bus. Three outcomes, all deliberate:
  - the vehicle publishes the signal → the parameter group, broadcast **from that server's own address** (the engine for CCSS/HOURS, Axle − Drive #1 for VW);
  - a vehicle is on the link but has no such parameter → a **NACK** (PGN 59392 ACKM, control byte 1) addressed back to the requester;
  - nothing on the link → **silence**, because there is no ECU to answer.
- **Registry:** `window.j1939RequestServers`, entries `{ pgn, abbr, sa, prio, signals, build(t) }`. Three are registered: **65261 CCSS** (SPN 74 → `speed_limit`) and **65253 HOURS** (SPN 247 → `engine_hours`) from Engine #1, and **65258 VW** (SPN 582 → `axle_load`, with SPN 928 Axle Location naming the axle) from **Axle − Drive #1 (0x09)** — a weight is a reading from the suspension, not an engine function, which is why the "it is *X* that carries this one" note reads the server's `sa` rather than a constant. `build` is handed `window.carlitoTelemetry()` — the game's live values, **null when stale** (600 ms), so a request is never answered out of a frozen snapshot.
- **`j1939EncodeSPN` is the exact inverse of `j1939DecodeSPN`**, reading the same `{b,n,f,o,bit,bits}` descriptors out of `J1939_DB` via `j1939SpnDef(pgn, spn)`. No second table: a scale that is wrong here is wrong in the monitor too. Frames start as eight `0xFF` bytes (`j1939Blank`), so an untouched byte says "not available" rather than claiming a zero.
- **New `J1939_DB` entries:** `0xEA00` (RQST) and `0xE800` (ACKM), both with a custom `decode` — a 24-bit PGN in the payload cannot be rendered by the byte-scaled SPN model.
- **Coverage:** `carlito.js` declares the signals as request-served (`CAN_MAP_ON_REQUEST` / a packer's `onRequest`) and cross-checks them against this registry **only when it is loaded**, so `carlito-bridge.html` (no `j1939.js`) reports the declaration rather than a gap.

**Sources:** J1939-21 for the request/acknowledgment layouts and the priority-6 default; J1939-71 for all three parameter groups (each "On request", priority 6, PDU2; SPN 74 = 1 byte at 1 km/h/bit; SPN 247 = 4 bytes at 0.05 h/bit; SPN 582 = 2 bytes at 0.5 kg/bit).

**Revert:** remove the request bar from `#j1939Wrap`, the `THE REQUEST PATH` section in `j1939.js`, the `J1939_REQ_PGN` line in `j1939IngestFrame`, the `0xEA00`/`0xE800` `J1939_DB` entries; in `carlito.js` drop `CAN_MAP_ON_REQUEST`/`REQUEST_SERVED`/`window.carlitoTelemetry` and the `onRequest` argument to `report()`; in `isobus.js` and `j1939-flavor.js` drop the `onRequest` blocks. The three signals then need `unpackable` entries instead.

---

## DTC decoder (`dtc.html` standalone page)

Standalone reference page (no app runtime, `file://`-compatible) for looking up DTCs in OBD-II 2-byte, UDS 3-byte+status, or J1939 4-byte SPN+FMI encodings. Inlines faithful copies of the app's decoders. Theme from shared `'sloppycan-explainer-theme'` localStorage key.

- **`DTC_DB`** - ~500-entry SAE J2012 descriptions (P0xxx + curated U/C/B). Manufacturer-specific codes flagged, never fabricated.
- **Auto-detect:** `decodeToken` sniffs format; bare 4-byte renders both UDS+status and J1939 cards. Batch input splits on comma/newline.
- **URL prefill:** `?q=P0301` or `?bytes=01+90+12+2F&fmt=uds` for in-app deep-links.

**Integration points (in-app deep-links only):**
- `sloppycan.js`: `vHtml` escape-hatch in `udsSection`; `dtcLink`/`dtcHexQ` helpers; `.vHtml` rows at OBD Mode 03/07/0A + UDS 0x19 + single-DTC site.
- `j1939.js`: `j1939RenderDM` wraps the SPN cell in an `<a>` reconstructing the 4 record bytes.

**Revert:** delete `dtc.html`; restore `udsSection` `val` line, remove `dtcLink`/`dtcHexQ` + three `.vHtml` rows; unwrap SPN cell in `j1939.js`.

---

## Shared "stacked log tab" factory (`window.makeStackedLogTab`, in `sloppycan.js`)

CHAdeMO, XCP, and CANopen are all a **top panel stacked over a scrolling frame-log table**. The
identical machinery — the rAF render loop (dirty/visibility gating + ~15 fps throttle + 1 s
relative-timestamp tick), the log ring (append + `logMax` cap + optional same-id `coalesce`), the
table builder (empty-state + near-bottom scroll-follow), and the `ready()`/`showTxHint()`/
`readout()` helpers — lives **once** in `window.makeStackedLogTab(cfg)`. Each module calls it once and
keeps only its decode + session/nodes panel (`cfg.renderTop`) + row builder (`cfg.rowHtml`) + (xcp/co)
TX command logic. Module code marks the log dirty via `tab.markDirty()`, appends via `tab.pushLog(e)`,
empties via `tab.clearLog()`, and force-renders on tab-show via `tab.render()`. cfg shape:
`{ wrapId, logElId, tableClass, theadHtml, emptyHtml, rowHtml(e), renderTop(), onTick?, coalesce?(prev,e),
   renderMs=67, logMax=600, readoutElId?, txHintElId? }`. The per-module **pending/timer** transaction
machinery (`xcpPending`, `coPending`) is intentionally **not** shared — see each entry below.

---

## CHAdeMO (`chademo.js`)

Decodes CHAdeMO DC-fast-charging CAN (11-bit IDs, 500 kbit/s). J1772 and ISO 15118 are not on CAN - a note banner says so and links `ev-charging-explainer.html`.

- **`CHADEMO_MSGS`** - decode table keyed by 11-bit ID. Covers 0x100/0x101/0x102 (vehicle→charger) and 0x108/0x109 (charger→vehicle); v2.0 discharge IDs are `{raw:true}`. `chademoIngestFrame` early-exits on `frame.isExt`.
- **Layout:** Session (dashboard tiles + flag chips) and Frame Log are **stacked in one view** (Session on top with `max-height:55%`, Frame Log below), driven by the shared `makeStackedLogTab` factory (`chademoRenderSession` is its `renderTop`; passive, so no `coalesce`/`readout`/`txHint`) - no sub-tabs. `chademoSessionState()` derives coarse state from `lastIds` recency + enable/stop bits.
- **Demo (base traffic):** CHAdeMO is a demo **base traffic** - `window.chademoDemoLoopStart()` / `chademoDemoLoopStop()` run a capability-exchange + charging ramp that **loops** (5 s idle wait between cycles via `chademoDemoRestartAt`), injected via `window.ingestFrame`. Started/stopped by the core demo base-traffic engine (`demoStartBaseTimers`) when CHAdeMO is the active base traffic; opening the tab in Demo prompts via `window.demoMaybeSwitch('chademo', …)`. A **Pause demo** button (`window.chademoDemoPauseToggle`, gated on `chademoDemoTimer` so it only shows while the loop runs) sits next to the session state pill. No standalone Demo button.
- **No persistence** (live-only tab).

**Integration points:** `ingestFrame` → `if (window.chademoIngestFrame) chademoIngestFrame(frame)`; `clearFrames` → `if (window.chademoClear) chademoClear()`; `switchViewTab` chademo branch (show/hide + `demoMaybeSwitch`); `window.ingestFrame = ingestFrame` at startup; `chademoDemoLoopStart/Stop` called by the demo engine. `index.html`: `#vtab-chademo`, `#chademoWrap` (`#chademo-session` + `#chademo-log`), `<script src="chademo.js" defer>`. Explainer: `ev-charging-explainer.html`.

**Revert:** delete `chademo.js` + `ev-charging-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear hooks, `window.ingestFrame` line, `#chademoWrap`, `<script>` tag.

---

## XCP-on-CAN (`xcp.js`)

Passively decodes XCP-on-CAN (ASAM MCD-1 XCP) and acts as an active XCP master. Two configurable CAN IDs: CRO (master→slave, default `0x552`) and DTO (slave→master, default `0x553`).

- **Decode tables:** `XCP_CMD`, `XCP_ERR`/`XCP_EV`, `XCP_RESOURCE` - per ASAM XCP spec (`GET_DAQ_PROCESSOR_INFO=0xDA`, `START_STOP_SYNCH=0xDD`, `ERR_CMD_UNKNOWN=0x20`).
- **DTO classification:** `0xFF` RES, `0xFE` ERR, `0xFD` EV, `0xFC` SERV, `0x00–0xFB` DAQ.
- **Command↔response pairing:** RES/ERR decoded in context of last CRO. `xcpDecodeRes` parses CONNECT (byte order from `COMM_MODE_BASIC` bit0), GET_STATUS, GET_ID, UPLOAD/SHORT_UPLOAD, GET_DAQ_PROCESSOR_INFO.
- **Active master:** single in-flight `xcpPending` (its timeout is an inline `setTimeout` in `xcpSend`, not a separate arm helper - unlike CANopen's `coArmTimer`). `xcpSend` gates on `xcpReady()` (open bus + not listen-only) and sends via `window.fuzzTxFrame`. `xcpReadIdViaUpload` chains sequential UPLOADs. **Note:** unlike CANopen, XCP active writes (`SET_MTA`/`DOWNLOAD`) are **not** `confirm()`-gated - they rely on `xcpReady()`/listen-only only. (Intentional asymmetry; revisit if XCP write is exposed more prominently.)
- **DAQ flood guard:** DAQ DTOs coalesced via the factory's `cfg.coalesce` (same id within `XCP_DAQ_COALESCE_MS`) into one `×N` row.
- **Render/log:** session panel + frame-log table go through the shared `makeStackedLogTab` factory (`xcpRenderSession` = `renderTop`, `xcpUpdateButtons` = `onTick`). `xcpReady`/`xcpShowTxHint`/`xcpReadout` delegate to the returned handles.
- **Persistence:** `xcp` key: `cro`/`dto`/`isExt`/`byteOrder`.

**Integration points:** `ingestFrame` → `xcpIngestFrame`; `clearFrames` → `xcpClear`; `disconnectSerial` → `xcpStop`; `switchViewTab` + `xcpOnShow`; three persistence functions (`xcp` key via `xcpCollect`/`xcpApply`/`_xcpPending`); `window.xcpScheduleSave = scheduleSave` + `window.xcpDemoActive = () => demoMode` at startup. `index.html`: `#vtab-xcp`, `#xcpWrap`, `<script src="xcp.js" defer>`. Explainer: `xcp-explainer.html`.

**Revert:** delete `xcp.js` + `xcp-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear/disconnect hooks, `xcp` persistence key + startup lines, `#xcpWrap`, `<script>` tag.

---

## CANopen (`canopen.js`)

Passively decodes CANopen (CiA 301) and acts as an active client. COB-ID = `(functionCode << 7) | nodeId`. **11-bit only** - exits early on `frame.isExt`.

- **Classification:** `coClassify(id)` → `{node, fc, type, kind}`. Covers NMT 0x000, SYNC/EMCY 0x080, TIME 0x100, TPDO/RPDO 0x180–0x500, SDO tx/rx 0x580/0x600, heartbeat 0x700, LSS 0x7E4/0x7E5. Any 11-bit frame is classified - non-CANopen traffic showing up is correct passive behaviour.
- **SDO:** `coDecodeSdo(d, dir)` - expedited read/write, segmented (reassembled to text+hex), abort (4-byte LE code).
- **Node map:** `coNodes: Map<nodeId,{state,lastSeen,types:Set}>` from heartbeat/NMT/any traffic.
- **Layout:** Nodes & Control (`#co-nodes`: node map + SDO/NMT/SYNC forms, `max-height:55%`) and Message Log (`#co-log`) are **stacked in one view** via the shared `makeStackedLogTab` factory (`coRenderNodes` = `renderTop`, `coUpdateButtons` = `onTick`, PDO `cfg.coalesce` within `CO_PDO_COALESCE_MS`; `coReady`/`coShowTxHint`/`coReadout` delegate to the handles) - no sub-tabs.
- **Demo (base traffic):** the demo node (`coStartDemo`/`coStopDemo`, continuous heartbeats + TPDO + EMCY on a 1 s timer) is a demo **base traffic** - started/stopped by sloppycan.js's demo base-traffic engine (`window.canopenDemoStart/Stop`) when CANopen is the active base traffic, **not** on tab show. Opening the tab in Demo prompts via `window.demoMaybeSwitch('canopen', 'CANopen')`. The SDO/NMT **answering** (`coDemoServer`/`coDemoApplyNmt`) stays gated on `window.canopenDemoActive` (demo on), independent of which base traffic is active.
- **Active client:** single in-flight `coPending` + `coArmTimer`. `coSdoRead`/`coSdoWrite` (write adds own confirm), `coNmt`, `coSync`. All TX via `coTx` → `window.fuzzTxFrame`.
- **Persistence:** `canopen` key: `node`/`sdoTimeout`/`sdoReqId`/`sdoRspId`.

**Integration points:** `ingestFrame` → `canopenIngestFrame`; `clearFrames` → `canopenClear`; `disconnectSerial` → `canopenStop`; `switchViewTab` + `canopenOnShow`; three persistence functions (`canopen` key via `canopenCollect`/`canopenApply`/`_canopenPending`); `window.canopenScheduleSave = scheduleSave` + `window.canopenDemoActive = () => demoMode` at startup. `index.html`: `#vtab-canopen`, `#canopenWrap`, `<script src="canopen.js" defer>`. Explainer: `canopen-explainer.html`.

**Revert:** delete `canopen.js` + `canopen-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear/disconnect hooks, `canopen` persistence key + startup lines, `#canopenWrap`, `<script>` tag. **Future work:** user-supplied PDO mapping; SDO block transfer.

---

## DroneCAN (`dronecan.js`)

A real **DroneCAN (UAVCAN v0) transfer encoder** plus a passive decoder that reassembles multi-frame transfers. **29-bit extended only** - exits early on `!frame.isExt`. Also the **flavor packer** for the carlito contract's `dronecan`-flavored signals (see "Flavor packers" under `carlito.js`).

- **Three id layouts, one parser.** `dcParseAnyId()` decides which a 29-bit id is (bit 7 = service-not-message, source node 0 = anonymous) and returns the reassembly key with it:
  - **Message (broadcast):** bits 24-28 priority, bits 8-23 message type id, bit 7 = 0, bits 0-6 source node id. `dcMsgId()`/`dcParseMsgId()`. Key `(type, source)`.
  - **Service:** bits 24-28 priority, bits 16-23 service type id, bit 15 request-not-response, bits 8-14 **destination** node id, bit 7 = 1, bits 0-6 source node id. `dcSvcId()`/`dcParseSvcId()`. Key `(type, source, destination, direction)` — two nodes answering two tools are four independent transfers sharing one service type id.
  - **Anonymous:** bits 24-28 priority, bits 10-23 **discriminator**, bits 8-9 the **low two bits** of the message type id, bit 7 = 0, bits 0-6 source node id = 0. `dcAnonId()`/`dcParseAnonId()`. **Single-frame only** — no source node id means no key to reassemble on; `dcAnonTransfer` throws on an oversized payload rather than truncating.
- **Tail byte** (last byte of every frame): bit 7 start-of-transfer, bit 6 end-of-transfer, bit 5 toggle, bits 0-4 transfer id. Payload ≤ 7 bytes ⇒ one frame (SOT+EOT, toggle 0, **no CRC**). Longer ⇒ a 2-byte transfer CRC is prepended and the result chunked into 7-byte pieces with the toggle alternating **from 0** (that is the v0 rule; UAVCAN v1 starts at 1). Transfer ids are 5-bit counters per `(dataTypeId, srcNode)`.
- **Transfer CRC:** CRC-16-CCITT-FALSE (poly `0x1021`, init `0xFFFF`), **seeded with the 8 little-endian bytes of the data type signature** before the payload. `dcSigBytes()` converts the table's hex signature.
- **⚠ DSDL bit order - the thing that will bite you:** byte order is little-endian but bit order is **MSB-first** (stream bit 0 = MSB of byte 0). A field is laid out as `ceil(bits/8)` little-endian bytes, its final partial byte **left-shifted so the used bits are the MSBs**, then copied MSB-first (this is what libcanard's `canardEncodeScalar` does). So a byte-aligned `u32` comes out plain little-endian, but a `uint2` at bit 32 lands in the **top** two bits of byte 4. `dronecanSelfTest()` pins this with a NodeStatus vector.
- **Message table** (`DC_MSGS`, keyed by data type id - **data, so later phases extend the table, not the call sites**):

  | id | type | signature | payload |
  |---|---|---|---|
  | 341 | `uavcan.protocol.NodeStatus` | `0x0F0868D0C1A7C6F1` | `uptime_sec` u32, `health` u2, `mode` u3, `sub_mode` u3, `vendor_specific_status_code` u16 → 7 bytes, **single frame** |
  | 1034 | `uavcan.equipment.esc.Status` | `0xA9AF28AEA2FBB254` | `error_count` u32, `voltage`/`current`/`temperature` f16 (**temperature is Kelvin**), `rpm` i18, `power_rating_pct` u7, `esc_index` u5 → 110 bits = 14 bytes, **3 frames (7/7/2)** |

  `dcEncode`/`dcDecode`/`dcSummary` are generic over the table; `f16` fields encode a non-finite input as **NaN (`0x7E00`)**, which is DSDL's own "field not known".
- **Carlito mapping** (`dcBuildFrames`, called via `dcPackCarlito(t, slow)` on the **slow ~10 Hz tick only** - 13 frames/tick): one `esc.Status` per `esc_index` from node `escBaseNode + i` (default 11, so ESC1..ESC4 = 11..14, matching the node roster in the carlito repo's `improve_drone.md` Phase 4), plus one `NodeStatus` from `fcNode` (default 1) whose `mode` is OPERATIONAL/MAINTENANCE from `armed` and whose `health` is WARNING while any `esc_fault` bit is set. Returns `[]` unless `Array.isArray(t.esc_rpm)`, so **non-drone vehicles emit nothing**. `error_count` counts **rising edges** of that ESC's fault bit (DSDL says count, so it counts); `temperature` adds 273.15 (contract is degC); `power_rating_pct` is a **labelled proxy** - percent of the contract's own `esc_current` range top, read out of `window.CARLITO_CONTRACT` so it cannot drift.
- **RX:** `dcFeedFrame(state, id, data)` takes its state as an argument so the self-test reassembles into a scratch map without touching the live bus. Tracks `err.{crc,toggle,tid,orphan}`. An unknown data type has no signature, so its CRC reports `null` ("n/a"), never `false`. Our own forwarded frames come back through `ingestFrame`, so **the decoder continuously validates the encoder**.
- **Layout:** ESC roster + node table (`#dc-panes`, `renderTop`) stacked over a transfer log (`#dc-log`) via `makeStackedLogTab`. One log row per **reassembled transfer**, with the frame count and CRC verdict as columns.
- **Demo (base traffic):** `dcDemoStart`/`dcDemoStop` synthesise a hovering quad and push it through the **same** encoder into `window.ingestFrame` - demo exercises the real encode → reassemble → decode path with no hardware and no game. Opening the tab in Demo prompts via `window.demoMaybeSwitch('dronecan', 'DroneCAN')`.
- **Self-test:** `window.dronecanSelfTest()` → `{pass, failures}`. Covers the bit order (NodeStatus vector `01 00 00 00 80 34 12`), float16, esc.Status framing/tail bytes/dlcs, a full CRC round-trip, and CRC detection of a corrupted byte. **Run it after touching anything in the wire-primitives section.**
- **Services** (`DC_SVCS`, keyed by service type id; ids off the DSDL file names, signatures re-derived with pydronecan's algorithm and validated by reproducing all sixteen already in `DC_MSGS`):

  | id | type | signature | shape |
  |---|---|---|---|
  | 1 | `uavcan.protocol.GetNodeInfo` | `0xEE468A8121C46A9E` | request **empty** (0 bits); response 328 bits + a tail `name` — NodeStatus + SoftwareVersion + HardwareVersion inlined, 9 frames |
  | 5 | `uavcan.protocol.RestartNode` | `0x569E05394A3017F0` | request `magic_number` u40 (`0xACCE551B1E`, **checked**); response `ok` bool |
  | 11 | `uavcan.protocol.param.GetSet` | `0xA7B622F939D1A4D5` | **no field table** — `param.Value` is a DSDL `@union`, so its width follows its 3-bit tag. Hand-written codecs (`dcGetSetEncodeReq` / `dcGetSetDecodeResp` / …) |

  Two field kinds arrived with them: `{ bytes: N }` (a fixed byte array, inlined) and `{ tail: true }` (a DSDL v0 **tail array** — last field, ≥8-bit elements, no length prefix, so it is literally the bytes that are left). A tail requires `m.bits % 8 === 0`; the self-test asserts it.
- **Server** (`dcServeRequest`): answers out of `DC_ROSTER` + the node's own decoded `NodeStatus`. **A node that is not publishing answers nothing** (`dcNodeLive`, same freshness the roster view reads) — that silence is the reading, exactly as for a failed node. Responses echo the request's **transfer id and priority**. `RestartNode` acknowledges, then clears the node's `dcNodeUpAt` and sets `dcRebootAt[i]`, which `dcOnlineMask` folds into the presence mask for `DC_REBOOT_MS` — so the row goes silent and comes back at `uptime_sec` 0. Parameters (`dcNodeParamDefs`) are real properties, not a pretend store; `uavcan.node.status_period_ms` is the writable one and really is that node's NodeStatus period (`dcNsLastAt` is **per node** for exactly this reason — set it past 3000 and the row goes stale while its neighbours stay green). A write to a read-only parameter is answered with the **unchanged** value, which is the DSDL's own mechanism.
- **Client** (`dcSendRequest`): a maintenance tool at node **127** (DroneCAN reserves 126/127 for tools). One request in flight per key; a timeout **expires without retrying** — an unanswered request is information. `dronecanReadParams` walks by index until a nameless answer, because index access exists only to enumerate and there is no count to ask for.
- **Dynamic node ID allocation:** allocator + a bench allocatee that **talk over the bus**, not through a function call. `dcAnonIngest` accumulates 6 unique-id bytes per anonymous transfer (`MAX_LENGTH_OF_UNIQUE_ID_IN_REQUEST`) and echoes what it has with `node_id` 0; at 16 bytes it grants via `dcAllocFindFree`, which is the DSDL's own pseudocode — **up from the preference, then down**, preference clamped to 125 so 126/127 are never handed out. The same unique id gets the same id back. `dcAllocatee` follows rules C/D/E off the allocator's replies with a randomised `Tfollowup` in `[0, 400)` ms.
- **⚠ Wide fields are byte-wise, not `Math.pow`:** `((v % 2**bits) + 2**bits) % 2**bits` is **not exact past 53 bits** — `20 + 2**64` rounds to `2**64`, so `put(20, 64)` wrote a zero and every `param.GetSet` int64 read back as 0. Both `dcBitWriter.put` and `dcBitReader.get` now lay out the magnitude little-endian and negate across the bytes (invert, add one). Pinned in the self-test at 32 and 64 bits, positive and negative.
- **Persistence:** `dronecan` key: `txEnabled`/`fcNode`/`led`. Per-node parameters and the allocation table are **bus state**, not settings — `dronecanClear` drops them, `dronecanCollect` does not save them.

**Integration points:** `ingestFrame` → `dronecanIngestFrame`; `clearFrames` → `dronecanClear`; `disconnectSerial` → `dronecanStop`; `switchViewTab` + `dronecanOnShow` + `demoMaybeSwitch`; demo base-traffic engine (`dronecanDemoStart/Stop`, `demoInitialBaseTraffic`); three persistence functions (`dronecan` key via `dronecanCollect`/`dronecanApply`/`_dronecanPending`); `window.dronecanScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-dronecan`, `#dronecanWrap` (config bar, bench-control bar, gimbal bar, **service bar**), `<script src="dronecan.js" defer>` **after `carlito_contract.js` and before `carlito.js`** (the flavor packer must be registered before carlito.js evaluates its coverage check). `carlito-bridge.html`: the same script tag. **That page has no tab markup and does not load `sloppycan.js`**, so `makeStackedLogTab` / `canRelTs` / `escHtml` are all missing - hence `dcNullTab` and the `||` fallbacks on each alias. Without them the module throws partway through and leaves `dcTab` in its TDZ, taking the encoder down with the tab. Explainer: `dronecan-explainer.html`, linked from the tab's config bar.

**Revert:** delete `dronecan.js` + `dronecan-explainer.html`; remove the tab button, its explainer link, `switchViewTab` lines, ingest/clear/disconnect hooks, demo base-traffic branches, `dronecan` persistence key + startup line, `#dronecanWrap`, and both `<script>` tags. `carlito.js`'s flavor-packer registry then simply finds an empty list.

---

## ISOBUS flavor packer (`isobus.js`)

The carlito contract's `isobus`-flavored **out** signals as real ISO 11783-7 / SAE J1939 frames.
**Packer only — no tab, no CSS, no demo generator.** ISOBUS is J1939 at the wire level, so
`j1939.js`'s decoder already renders every frame this module emits (Mode ▸ ISO 11783) and a
second view would be a worse one. Whole file is an IIFE: nothing but the registration and
`window.isobusSelfTest` reaches global scope, so it cannot collide with the shared lexical scope
`can-link.js`/`diag-parse.js`/`sloppycan.js` share.

- **Frames.** `EEC2` 61443 @50 ms from Engine #1 (SPN 92 ← `engine_load`) · `RPTO` 65091,
  `RHS` 65093, `WBSD` 65096, `GBSD` 65097 @100 ms from the **Tractor ECU, SA 240** ·
  `EAC1` 61446 (SPN 569 ← `diff_lock_state`) and `FWD` 64991 (SPN 2612 ← `fwd_drive_state`)
  @500 ms on a wall-clock gate · `Address Claim` 60928 **on change**.
- **The Address Claim is the implement.** `implement_connected` + `implement_type` are one frame:
  the NAME's Vehicle System field (bits 49–55) IS the ISO device class, and the contract's enum
  values already are ISO device classes. Attaching is the claim; **detaching emits nothing**,
  because J1939 has no "unclaim" — an address simply ages out. Warns once if a value shows up
  that the contract's enum does not have.
- **Every byte starts at 0xFF.** In J1939 all-ones is *not available*, so a field with no source
  states that rather than claiming a zero — the same statement carlito.js's uplink makes by
  omitting an unwired signal. `ibPut` is the exact inverse of `j1939DecodeSPN`'s `{b,n,f,o}`.
- **Gated per signal, never per vehicle.** `engine_load` / `pto_state` / `engine_hours` are the
  **truck's** as well as the tractor's, so a `dcBuildFrames`-style vehicle gate would drop them.
  A car produces no frames at all; a truck produces EEC2 + RPTO.
- **`unpackable`:** `wheel_slip` (no SPN exists — it is WBSD minus GBSD, both packed; the
  contract's cited "SPN 1858" is unassigned) and `engine_hours` (PGN 65253 is request-only, the
  same situation as `speed_limit`/SPN 74 in `CAN_MAP_UNPACKABLE`).
- **Self-test:** `window.isobusSelfTest()` → array of failures. Pinned frame vectors per message,
  the 29-bit id build checked against `j1939ParseId`, the NAME checked against `j1939DecodeName`,
  and every frame round-tripped through `j1939DecodePGN` — **needs the tab in ISO 11783 mode**,
  and says so rather than skipping when it is not. **Run it after touching any scale or bit
  position.**
- **Not here:** `scv_flow` and `guidance_curvature` are dir=`in`. Their real carriers exist
  (Auxiliary Valve Command 65072–65087, Guidance System Command 44288) and wait for a side that
  owns the control, the way `dronecan.js` owns its gimbal sliders.

**Integration points:** `index.html` + `carlito-bridge.html`, `<script src="isobus.js" defer>`
after `carlito_contract.js` and **before `carlito.js`**. No hooks in `sloppycan.js` at all.
`carlito-bridge.html` loads neither `sloppycan.js` nor `j1939.js`, so every cross-module read is
`typeof`-guarded and the self-test degrades to its pinned vectors there.

**`j1939.js` corrections that landed with it** (all four made this module's frames decode under
the wrong name or the wrong ECU): `0xFE43`/`0xFE45` had the rear PTO and rear hitch **swapped**;
`EEC1` carried SPN 91/92 where J1939-71 has 512/513 (91/92 are EEC2's, newly added as `0xF003`);
`J1939_SA` had the axles at `0x21`–`0x23` instead of `0x08`–`0x0A` and most other entries shifted
too; `j1939DecodeName` read industry group at bits 57–59 and self-configurable at bit 60 instead
of 60–62 and 63 (the two synthesised claims in `j1939DemoFrames` moved with it). Also added:
`0xF006` EAC1, `0xFDDF` FWD, the WBSD/GBSD direction bits at 8.1 rather than 8.7, the
auxiliary-valve runs at their real bases (`0xFE10` estimated / `0xFE20` measured / `0xFE30`
command), and the **front** PTO/hitch SPNs, every one of which had been filled in by pattern
from the rear ones and every one of which was wrong (1882 is the front PTO shaft speed, not the
front lower-link force). `isoDemoFrames()` moved with the tables — its PTO and hitch payloads
were on each other's PGN, and its WBSD byte 8 was built for the old direction-bit position — as
did the explainer's PGN table.

**Revert:** delete `isobus.js` and both `<script>` tags. `carlito.js` then reports the isobus
flavor as unpacked again, which is its stated design and not a defect. The `j1939.js` decode
corrections are independently right and should stay.

## J1939 flavor packer (`j1939-flavor.js`)

The carlito contract's `j1939`-flavored **out** signals as real SAE J1939 parameter groups.
**Packer only — no tab, no CSS, no demo generator**, same shape as `isobus.js`: `j1939.js`
already decodes every frame it emits. Whole file is an IIFE; only the registration and
`window.j1939FlavorSelfTest` reach global scope.

**Why it is not inside `j1939.js`:** `carlito-bridge.html` loads this file and **not** `j1939.js`,
so folding the packer into the tab module would silently drop the truck's frames on that page.
The two files do different jobs — one decodes the bus and owns the request path, this one packs
four game signals.

- **Frames.** `ERC1` 61440 @100 ms from **Retarder − Driveline, SA 0x10** (SPN 520 ←
  `retarder_state`) · `AIR1` 65198 @**1 s** from **Brakes − System Controller, SA 0x0B** (SPN 1087
  / 1088 ← `air_primary` / `air_secondary`) on a wall-clock gate that only advances when there was
  something to send.
- **The layout is entirely looked up.** Every signal here has a real SPN, so no proprietary id is
  invented for any of them. All PGNs, SPNs, resolutions, offsets, rates and priorities were read
  off **SAE J1939-71 itself** — the source rule, and it is cheap to honour here.
- **SPN 520 is negative and `retarder_state` is a magnitude.** J1939-71 gives SPN 520 an operating
  range of −125…0 % because a retarder is a brake; the contract publishes 0…100 so the dashboard's
  generated bar fills the right way, and says so in its own desc. **The packer negates it** — that
  is the one place the sign lives. A listener reading −40 % and a driver reading a 40 % bar are
  seeing one fact.
- **SPN 900 Retarder Torque Mode is only written when it is 0.** Mode `0000b` "No request" is
  stated in J1939-71's *text*; the other fifteen live in **TABLE SPN899_A, which is a figure** and
  did not come out of the document. A retarder that is doing something therefore leaves the field
  at `1111b` "not available" rather than claiming a mode name this module never read.
- **`onRequest`:** `axle_load`. PGN **65258 VW**'s transmission repetition rate is literally "On
  request", so there is no periodic frame — `j1939.js`'s request path answers it from **Axle −
  Drive #1 (0x09)**, not the engine, because a weight is a reading from the suspension. **SPN 928
  Axle Location is SET** (`0x10`, second axle) rather than left at `0xFF`: VW's own note says a
  request is answered "with as many messages as necessary", so which axle a weight belongs to is
  carried by that byte and nowhere else. (This is the opposite of what `isobus.js` does with
  EAC1's SPN 927 — there is one axle controller in that message and no position to give.)
- **Every byte starts at 0xFF**, per the J1939 "not available" rule. `jfPut`/`jfBits` are local
  copies of `j1939EncodeSPN`'s arithmetic for the `carlito-bridge.html` load-order reason above.
- **Gated per signal, never per vehicle** — all four are the truck's today, but a vehicle gate
  would be a second place the contract's `vehicles` list is written down.
- **Self-test:** `window.j1939FlavorSelfTest()` → array of failures. Pinned frame vectors, the
  29-bit id build checked against `j1939ParseId`, the negation, the "absent leaves 0xFF but a real
  zero is written" pair, over-range clamping, the VW builder, and every frame round-tripped
  through `j1939DecodePGN`. **Run it after touching any scale or bit position.**

**`j1939.js` changes that landed with it:** `J1939_DB` += **`0xF000` ERC1**, **`0xFEAE` AIR1**,
**`0xFEEA` VW**, each with its neighbouring SPNs (a decode table is not scoped to what this packer
emits). A **VW entry on `J1939_REQ_SERVERS`**, the first one that does *not* answer from the
engine address — which is why `j1939ServeRequest`'s "it is *X* that carries this one" note now
reads the **server's own `sa`** instead of the hardcoded `J1939_SA_ENGINE` (with three servers and
two addresses, the constant had become a lie). `index.html` gains a 65258 entry in the request
bar's preset dropdown.

**Integration points:** `index.html` + `carlito-bridge.html`, `<script src="j1939-flavor.js"
defer>` after `carlito_contract.js` and **before `carlito.js`**. No hooks in `sloppycan.js`.
`carlito-bridge.html` loads neither `sloppycan.js` nor `j1939.js`, so the cross-module reads are
`typeof`-guarded and the self-test degrades to its pinned vectors there (and says so).

**Revert:** delete `j1939-flavor.js` and both `<script>` tags; drop the VW `J1939_REQ_SERVERS`
entry and the 65258 preset option. `carlito.js` then reports the j1939 flavor as unpacked again,
which is its stated design and not a defect. The three `J1939_DB` entries are independently right
and should stay; `j1939ServeRequest`'s per-server address note is a fix and should stay too.

---

---

## RAMN dashboard + Control Panel (`ramn.js`)

Two floating, draggable, resizable windows (not tabs). 11-bit only - `ramnIngestFrame` exits early on `frame.isExt`. A shared helper `makeFloating({win,header,grip,outer,body,baseW})` wires drag (header, viewport-clamped) + resize (grip → uniform `applyScale` of the body) for both windows.

**Dashboard** - **instrument-cluster window** that decodes a RAMN board's live CAN stream into vehicle signals. Opened by the **RAMN dashboard** toolbar button (`#ramnBtn`, next to Demo). Gear shows as a labelled "GEAR" box (caption + bordered badge; amber for R) so it reads clearly as gear status.

- **Decode** (16-bit analog values are **big-endian, first 2 bytes**, `be16`): `0x024` brake `(be16&0xFFF)/0xFFF*100`%; `0x039` accel (same); `0x062` steer `(raw-0x7FF)/0x7FF*100` → −100 (L) … +100 (R) **per user spec, `0x000`=L100% - opposite the firmware default**; `0x077` byte0 gear (`0xFF`→R, 1–6), byte1 joystick (1 released…6 press); `0x098` byte0 horn; `0x150` byte0 lights (1 Off/2 Clearance/3 Low/4 High); `0x1B8` byte0 key (1 Off/2 Acc/3 Ign); `0x1A7` turn **control** (byte0 left, byte1 right); `0x1BB` LED **status** bitfield (0x01 batt, 0x02 check-engine, 0x40 left-turn, 0x80 right-turn); `0x1D3` byte0 handbrake. Turn arrows light from the `0x1BB` LED status bitfield (0x40 left / 0x80 right), **not** `0x1A7`, and **blink** (CSS `ramnBlink`).
- **Render:** rAF-throttled via a `dirty` flag - never touches DOM per frame (CAN ≥100 Hz). Steering wheel SVG rotates ±150°; pedal/steer bars; gear badge + joystick label; tell-tale grid with semantic colours from theme vars (`--green` turn, `--blue` lights, `--red` brake/batt, `--amber` horn/check).
- **Window mechanics:** `applyScale` is recomputed on open (offsetHeight is 0 while `display:none`), `BASE_W=300`, 220–640px. `Esc` closes the topmost open window (control panel first, then dashboard).
- **No persistence** (live-only). No tab, no explainer page.

**Control Panel (demo mode only)** - a second window (`#ramnCtrlWindow`, amber header dot). There is **no separate toolbar button**: the single `#ramnBtn` is a **paired toggle** (`ramnToggle()`) that opens *both* the dashboard and (when demo is active) the Control Panel, and closes both. Demo state is recorded by `startDemo` → `window.ramnDemoStarted()` (sets `demoEnabled` in `ramn.js`); on a live hardware bus only the dashboard opens. Each window's own close button + Esc still close it individually (`setDashOpen`/`setCtrlOpen`). Lets the user *drive* the simulated car; the dashboard reflects it via the normal `demoTick → ingestFrame → ramnIngestFrame` path (closed loop - no direct coupling). `window.ramnIsOpen()` is exported for carlito.js to auto-open the dashboard.
- **How it drives demo traffic:** `demoTick` (sloppycan.js) calls `window.ramnCtrlPayload(id)` to get the 2 payload bytes for each of the 10 demo RAMN IDs (`DEMO_CONFIG`), replacing the old fixed `[0x00,0x00]`. Encoding (BE 12-bit where analog): 0x024 brake `pct*0xFFF`; 0x039 accel; 0x062 steer `0x7FF + steer/100*0x7FF` (L100→0x000, C→0x7FF, R100→0xFFF, per user spec); 0x077 `[gear(0xFF=R), joyByte]`; 0x098 horn; 0x150 lights(1-4); 0x1A7 `[left,right]`; 0x1BB LED **status** byte0 `(turnL?0x40:0)|(turnR?0x80:0)` - mirrors the lit turn LEDs so the dashboard's 0x1BB-driven tell-tales match; 0x1B8 key(1-3); 0x1D3 handbrake. Defaults give a resting car (centred wheel, lights/key off, gear 1) so even un-touched demo looks sane.
- **Controls:** sticky brake/accel/steer sliders (steer has a **Centre** snap); a **shift joystick** pad that is the central control (like real RAMN); Off/Clr/Low/High lights; Off/Acc/Ign key; handbrake toggle. The joystick is momentary (sets 0x077 byte1, reverts to 1=released on mouse-up) with side effects on press: **↑/↓ shift gear** up/down through `['R',1..6]` (clamped; `gearShift`), **←/→ toggle** left/right turn signal (the ←/→ buttons latch green while their signal is on), **● (centre) = horn** while held. A "Gear N" readout sits in the joystick section header. **Keyboard** (panel open, not in a form field): `W`/`S`=accel/brake, `A`/`D`=steer - full while held, auto-return to rest on key-up; `syncCtrlUI()` keeps the widgets in sync.

**Integration points:** `ingestFrame` → `if (window.ramnIngestFrame) ramnIngestFrame(frame)`; `clearFrames` → `if (window.ramnClear) ramnClear()`; `disconnectSerial` → `if (window.ramnStop) window.ramnStop()`; `demoTick` → `payload = window.ramnCtrlPayload ? ramnCtrlPayload(id) : [0,0]`; `startDemo` → `if (window.ramnDemoStarted) ramnDemoStarted()`. `index.html`: `#ramnBtn` (`onclick="ramnToggle()"`, the paired toggle) + `<script src="ramn.js" defer>` (the old `#ramnCtrlBtn` was removed). All window DOM + CSS are injected by `ramn.js` (no markup/CSS in core files).

**Revert:** delete `ramn.js`; remove `#ramnBtn` + `#ramnCtrlBtn`, the `<script>` tag, and the five one-line hooks in `ingestFrame`/`clearFrames`/`disconnectSerial`/`demoTick`/`startDemo`.

**Keyboard `Space`** = momentary handbrake (engaged while held).

---

## Drone dashboard + Drone Control (`drone.js`)

Two floating windows in `ramn.js`'s exact shape (its `makeFloating` does the drag/resize, with a `closeSel` option so this module's close button need not borrow `.ramn-close`), for the one machine the RAMN controls cannot fly. Opened by the **Drone** toolbar button (`#droneBtn`, between RAMN dashboard and Carlito), a **paired toggle** like `#ramnBtn`.

**Why it exists.** While the bridge is fresh the game's `InputRouter` reads the payload and ignores its local latches, and `ActionRegistry` hides every `bridge_owned` row - so ARM, MODE, HOOK, FAIL and the climb pads vanish from the game the moment sloppyCAN takes the link. Worse, `arm` and `climb` had **no uplink source anywhere** and sat in `checkOutFields`'s "unsourced, omitted" list, so the game read them as disarmed/zero forever: the drone could not take off.

- **Ownership.** This file keeps **no signal state**. Every drone "in" signal is `dronecan.js`'s `dcCtl`, reached through `window.dronecanCtl()` / `dronecanSetCtl(patch)`, so the DroneCAN tab and this panel are two windows onto one set of switches. `dronecanPrearmNames(mask)` and `dronecanRoster()` are exported for the same reason - a second copy of the pre-arm bit names or the node ids would drift.
- **The shared axes are a CLAIM, not a home.** `accel`/`brake`/`steer`/`key` are sourced from RAMN state in `carlito.js`'s `IN_SOURCES` for every vehicle. The panel takes them through `window.carlitoUplinkOverrides` while it is flying (control window open **and** a drone on the link) and returns `undefined` otherwise, which hands them straight back to the RAMN controls. Mapping: `accel`/`brake` are the game's throttle axis, which `DroneVehicle` reads as forward/back **tilt**, and `steer` is its yaw rate. **There is no roll stick** - `drone.gd`'s `Vector2(tilt, 0)`.
- **The two sides are linked both ways, and the mechanisms are not symmetric.** *Game → panel* is free: the telemetry already says which machine is on the link, so the windows follow it silently. *Panel → game* costs a **reload**, because the vehicle is a **boot parameter** - the game's `?level=&vehicle=` deep link, parsed by its `BootParams`, taking a VARIANT id (`drone`, `sedan`) rather than a family. `carlito.js` exposes `window.carlitoSelectVehicle(variant)` for it, and `switchViewTab('dronecan')` calls `window.droneRequestVehicle()`, which **asks first** (`demoMaybeSwitch`'s precedent - a tab click that restarts someone's drive unannounced is a worse surprise than a dialog) and stays quiet when there is nothing to change. The request is **spent on the load it causes**: a later Reload or channel switch goes back to the game's own saved session rather than pinning it. **There is deliberately no "change vehicle" contract signal** - the contract carries a vehicle's CAN signals, not commands to the shell around it - which is also why this needed no game-side change and works against the already-deployed build.
- **Vehicle detection.** The game publishes `signals_for_vehicle()`, so a **drone-only `dir:'out'` signal being present IS the vehicle** - there is no `vehicle_type` on the wire and there does not need to be. The name set comes off the contract's own `vehicles` field (the first thing in this repo to read it), so a new drone signal needs no edit here. `carlito.js` pushes each payload to `window.carlitoOnTelemetry`, and `null` when the link goes away. Only an **automatic** open is undone by the automatic close: a window closed by hand is not re-opened on the next frame.
- **It replaces the RAMN pair rather than joining it.** Opening the drone windows closes the RAMN dashboard + Control through `window.ramnSetPairOpen(false)`, and closing them puts back whatever was up when it took over. A car's pedals, gearbox and cluster describe nothing about a quadcopter, and while the panel is flying it has taken accel/brake/steer off those controls anyway - so leaving them up is two control surfaces for one aircraft, one of which does nothing. A RAMN pair the user had already closed stays closed.
- **Control window:** ARM latch + a live note, climb / pitch / yaw sliders, flight-mode segments (positions off the contract enum), the flight pack, hook + beep toggles, LED colour, the gimbal pair.
- **The `key` signal is a car's ignition barrel and the panel does not pretend otherwise.** Its enum is Lock / On / Ignition for every vehicle, but a quad has no barrel - it has a battery you plug in, and `drone.gd` asks exactly one question (`key == Ignition and pack.has_charge()`), treating Lock and On identically. So the panel offers the two positions the **airframe** has (a Flight pack toggle sending Ignition or Lock) rather than the three the **signal** carries. **Pitch and yaw spring back; the climb stick does not** - a transmitter's throttle holds where you leave it, and pre-arm bit 4 STICK refuses to arm until it is centred, which the note says out loud. Keys while the panel is open and not in a form field: `W`/`S` pitch, `A`/`D` yaw, `R`/`F` climb, `T` arm, `Z` next mode - **the game's own bindings**, so one pair of fingers works whichever side has the aircraft. A key held wins over the slider; a missed key-up (alt-tab) releases on window `blur`.
- **Arming is shown as two things, because it is two things.** The button is the SWITCH (`arm`) and the dashboard chip is the AIRCRAFT (`arming_state`). The craft arms on the switch's **rising edge** with every check passing, refuses a disarm airborne, and auto-disarms a few seconds after landing - after which the switch has to be **cycled**, which is the one case the note spells out. `prearm_fail` is decoded **only while BLOCKED**: it publishes 0 in flight by design, so reading it any other time says "no check failed" about checks nobody is running.
- **Dashboard:** four state chips (arming / mode_actual / failsafe / fix_type, labels off the contract enums), four bars whose scale and `warn` come off the signal's own `range`/`warn`/`warn_side`, a twelve-cell readout grid, the four ESCs, and the eight-node bus strip (click a cell = `node_fail`). The instanced signals (`esc_*` count 4, `node_health` count 8) are read **by index** - `+t.esc_rpm || 0` `Number()`s an array into `NaN` and falls through to a plausible 0. `altitude`/`agl`/`baro_alt` are meant to **disagree**; never reconcile them.
- **Render:** rAF-throttled off the telemetry push and skipped entirely while the window is closed. The control widgets are written on **events only** - a render tick reassigning a range input's `.value` would fight the pointer dragging it - except the arm note, which has to follow the live arming state.
- **No contract change.** Every signal involved was already in v33; this is a sloppyCAN-only change and **not** a paired promote.

**Integration points:** `index.html`: `#droneBtn` (`onclick="droneToggle()"`) + `<script src="drone.js" defer>` **after `ramn.js` + `dronecan.js`, before `carlito.js`** (which snapshots the override registry at eval) + an onboarding chip. `sloppycan.js`: `'droneBtn'` in `_buttonsWrap`'s id list, and `switchViewTab` → `if (name === 'dronecan' && window.droneRequestVehicle) window.droneRequestVehicle();`. `carlito.js`: `window.carlitoOnTelemetry`, `window.carlitoUplinkOverrides` and `window.carlitoSelectVehicle`. `ramn.js`: `makeFloating`'s `closeSel` option, and `window.ramnSetPairOpen` - an outright set rather than `ramnToggle`, because "put them back" must not be a guess about what was open. `dronecan.js`: `arm`/`climb` on `dcCtl` and the uplink registry, plus the accessor exports. All window DOM + CSS injected by `drone.js`. Not loaded on `carlito-bridge.html`, which has no dashboards.

**Revert:** delete `drone.js`; remove `#droneBtn`, the `<script>` tag, the onboarding chip, `'droneBtn'` from `_buttonsWrap`, and `arm`/`climb` from `dcCtl` + `window.carlitoUplinkSources` (which puts the aircraft back to unflyable). `carlito.js`'s override registry and telemetry hook are harmless without a subscriber.

---

## Carlito game link (`carlito.js`)

A floating, draggable, **real-resize** window (own CSS, not the RAMN `makeFloating` transform-scale - the iframe needs real pixels so Godot's `canvasResizePolicy:2` fills it) that embeds the **Carlito** Godot HTML5 game in an `<iframe>` and pushes the RAMN-interpreted controls into it, so a real RAMN board *or* Demo+Control actually drives the car. Opened by the **Carlito** toolbar button (`#carlitoBtn`, next to the RAMN buttons; always visible).

- **OUT (sloppyCAN → game):** `window.ramnGetState()` (added in `ramn.js`: `() => ({ ...ramnState })`) → rAF push loop → `postMessage({type:'carlitoInput', values:{…}})` with **all** RAMN controls: `accel,brake,steer,handbrake,key,lights,gear,turnL,turnR,horn` (booleans→0/1, gear `'R'`→−1). Push gated on: window open + Link on + iframe loaded. (Game applies handbrake/ignition-key/headlights; relays the rest.)
- **IN (game → sloppyCAN):** a `message` listener accepts `{type:'carlitoOutput', values:{…full telemetry…}}` **only from our iframe** (`e.source === iframe.contentWindow`) ~every 50 ms, renders it, and **injects CAN frames `0x520`–`0x528`** (sloppyCAN-local "Carlito telemetry" IDs, not real RAMN) via the exposed `window.ingestFrame`, big-endian. **Rate split:** fast IDs `0x520`–`0x523` every message (~50 ms), slow IDs `0x524`–`0x528` every 2nd (~100 ms). Map: `0x520` speed+km/h · `0x521` rpm/gear/throttle · `0x522` IMU (yaw/longAcc/latAcc) · `0x523` steering/slip/onGround · `0x524` posX/posZ/heading · `0x525` GPS lat/lon (int32 deg×1e7) · `0x526` odometer · `0x527` status bitfield+impact · `0x528` fuel/coolant/battery. (Trace table only re-renders while connected or in Demo - true whenever actually driving.)
- **Game side (`carlito` repo):** the `Bridge` autoload reads `__carlitoInput` (`JavaScriptBridge`, freshness-gated), feeds it into `InputRouter` as one normalized `VehicleInput`, and publishes telemetry by walking the contract (`src/bridge/bridge.gd` + `src/bridge/web/head_include.html`). See `carlito/CLAUDE.md`.
- **Window UI:** header carries a **stable | dev** channel selector (plain text, `localStorage.carlitoBuild`); control bar (**Reload**, keyboard-help ⌨, **Link ●/○**, debug toggles - the game URL is one of the two hardcoded `GAME_URLS` constants `https://leaukojo.github.io/carlito/stable/` or `…/carlito/dev/`, no free-text input field), then a two-column **OUT | IN** panel - left green `sloppyCAN →` lists all controls with a green dot on the **applied** ones (accel/brake/steer/handbrake/key/lights) vs label-only (gear/turn/horn); right amber `← Carlito` shows speed km/h + bar, rpm, gear, heading, pos (stale `-` after 600 ms). iframe lazy; `allow="autoplay; fullscreen; gamepad"`. Resize "shield" overlay stops the iframe swallowing mouse events.
- **Deploy:** the game deploys from its own repo — CI publishes `dev` on every push, and *Promote dev → stable* copies that artifact to `stable`. Nothing to deploy here. **If the deployed game is stale, the window loads & plays but controls/feedback do nothing** (browsers also cache the `.pck` hard - hard-reload).

- **Flavor packers:** a contract signal that carries a `flavor` is **not** packed by `CAN_MAP` - the contract itself says a flavor borrows a protocol's signal names/semantics "without implementing its CAN frames - frame layout stays on the sloppyCAN side", and that layout belongs to the protocol's own module. Such a module pushes `{ flavor, signals, pack(t, slow) }` onto `window.carlitoFlavorPackers` and **must be loaded before `carlito.js`**; `injectTelemetry` calls each `pack()` after the `CAN_MAP` loop (a throwing packer warns once, then is skipped), and `checkCanCoverage()` asserts CAN_MAP covers exactly the **unflavored** out signals while each registered packer covers its own flavor's. A flavor with no packer loaded is silent. `dronecan.js` is the first one.

**Integration points:** `index.html`: `#carlitoBtn` (`onclick="carlitoToggle()"`) + `<script src="carlito.js" defer>`. `ramn.js`: `window.ramnGetState` + `ramnCtrl.key` defaults to 3 (Ignition) so demo driving passes the engine gate. Reuses `window.ingestFrame` (in sloppycan.js) for the `0x520`–`0x528` frames. All window DOM + CSS injected by `carlito.js`.

**Revert:** delete `carlito.js`; remove `#carlitoBtn`, the `<script>` tag, and the `window.ramnGetState` line in `ramn.js`. (Game-side revert: see `carlito/CLAUDE.md`.)

---

## CAN Signals explainer (`can-signals-explainer.html`)

Standalone physical-layer page (no app integration, no `sloppycan.js` import). Takes a stuffed CAN bitstream via `?bits=<0/1 string>` (default: the example 119-bit standard frame) and draws an oscilloscope view on a `<canvas>`: CAN_H, CAN_L, differential, RX, Sender TX, Receiver TX. Self-contains a `parseFrame()` that reverses bit-stuffing to colour-code fields and locate the ACK slot (falls back to "12th-from-last bit" + uncoloured traces on malformed input). Also has an interactive arbitration demo. Teaches dominant/recessive, wired-AND, ACK, and arbitration.

**Integration point:** one `<a href="can-signals-explainer.html?bits=${stuffed.map(s => s.bit).join('')}">` in `inspectFrame`'s "Bitstream with Bit Stuffing" title (`sloppycan.js`).

**Revert:** delete `can-signals-explainer.html`; remove that one `<a>` in `inspectFrame`.
