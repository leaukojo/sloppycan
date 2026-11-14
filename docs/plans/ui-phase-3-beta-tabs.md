# Phase 3: beta tabs

**Run with:** Opus, effort **high**, plan mode **yes**. Two parts still need design work
before code:

- DroneCAN's new roster interaction: row click selects a node, failure gets an explicit toggle,
  and services act on the selection.
- Moving the J1939 lamps into `truck.js` without breaking the inbound rules in CLAUDE.md (one
  signal, one source; the module that owns the signal keeps it).

Agree both in plan mode first. The rest (copy cuts, CHAdeMO, CANopen) is mechanical.

Needs phase 1. One commit per tab, and the Carlito-control moves get their own commits. Rule for
every tab: a top `.bar` (protocol switches and config on the left, `.learn` at the right end),
`.sec` section titles, one-line `.empty` states, no sentences.

(The dimmed beta tab labels, `--text3` at `opacity:.82`, are fixed in phase 1's contrast pass.)

## DroneCAN (`index.html` `#dronecanWrap`, `dronecan.js`, `dronecan-core.js`)

The worst offender. Before the first table there are four stacked 37px bars (148px), each ending in
a sentence, and the panes below add more:

| Today | Change |
|---|---|
| Bar 2: Flight mode / LEDs / Off / Beep / Hook + "These drive the aircraft; while they are being sent the game's own Y and Z keys are overridden." | **Replace with a "Drone controls" button in bar 1 that opens the Drone Control window (decided; mechanism corrected, see below).** The window (`drone.js`) already shows the same `dcCtl` switches ("two windows onto one set of switches"). Verified 2026-11-13: mode, LED + LED off, beep, hook and gimbal are all in its markup. |
| Bar 3: Gimbal pitch/yaw sliders + Centre + "The mount slews at a finite rate, so gimbal_*_actual chases these rather than matching them." | Same: covered by the Drone Control window. |
| Bar 1: "Publishing rides the Carlito window; decode is always on." | Cut. If "decode is always on" is worth keeping, add it to the Transmit checkbox's tooltip, which says "Off = listen only" but not that. |
| Bar 4: "Services (from node 127, a maintenance tool):" + Node select + six buttons | Row click **selects** a roster node. The service buttons move into the Services `.sec` header and act on the selected node. "New node asks for an ID" moves into the Allocation `.sec` header. |
| "Node roster (uavcan.protocol.NodeStatus, msg 341 - click a row to fail it)" | Title "Nodes". Failure injection becomes an explicit **Fail** toggle in the State column, since a row click now selects. The DSDL name goes in the title tooltip. |
| "Services (GetNodeInfo 1 · RestartNode 5 · param.GetSet 11)" + the mono paragraph "A service is a question addressed to one node…" | Title "Services". Cut the paragraph; it belongs in `explainers/dronecan-explainer.html` if it isn't there already. |
| "Dynamic node ID allocation (uavcan.protocol.dynamic_node_id.Allocation, msg 1, anonymous)" | Title "Node ID allocation". |
| "ESC status (uavcan.equipment.esc.Status, msg 1034)", "Arming (uavcan.equipment.safety.ArmingStatus, msg 1100)", "Everything else on the bus" | "ESC status", "Arming", "Other nodes". DSDL names go in tooltips. |
| Empty states that are mini-lectures ("…the request is an EMPTY transfer, and the answer is the widest one on this bus.", "…The eight roster ids above are DECLARED - somebody decided the GNSS node is 20…") | One line each: "No node info yet." · "No parameters yet." · "No allocation requests yet." · "No ESC status yet." · "No arming state yet." · "No flight mode yet." |
| Presence line: "No DroneCAN heard on this bus (no NodeStatus in 5 s, …): decoding only - service requests and allocations are not answered." | A **Decode only** `.pill` in the top bar, with the reason as its tooltip. |
| Transfer-log counters "CRC 0 · toggle 0 · transfer-id 0 · oversize 0 · joined mid-transfer 0" | Show only the counters that are > 0. |

**Correction (found in review, 2026-11-13): why a button and not plain deletion.** The bench
bars do more than drive Carlito. In a DroneCAN Demo with no game, the demo publish loop in
`dronecan.js` builds its frames with `dcBuildFrames()` (`dronecan-core.js`), which ends with
`dcFlushCommands()`, so the bars put LightsCommand,
BeepCommand, hardpoint and gimbal transfers on the bus, and `dcCtl.mode` changes the simulated
GNSS. But the Drone Control window is only reachable while a drone is on the Carlito link
(`vehicle-panel.js` `syncButtons`: shown when its family is on the link *or the window is
open*). Deleting the bars would therefore remove the only way to send those commands in the
DroneCAN demo. The fix keeps the decision's intent, controls live in the vehicle panel:

1. `drone.js` exports a way to open **Drone Control alone**. The dashboard half has no telemetry
   without the game. Opening it keeps the header button visible through the "or the window is
   open" rule.
2. The DroneCAN bar gets a **Drone controls** button that calls it.
3. Before deleting the bars, verify in the DroneCAN Demo (no Carlito) that LED, beep, hook and
   gimbal changes from the window appear in the Transfer Log. Also check that opening the window
   without a game doesn't leave a RAMN-axis claim behind: the header comment says the shared
   axes are claimed through `carlitoUplinkOverrides` "while this panel is flying".

Code to remove with the two bars: `dronecanCtlChange`, `dcGimbalReadout`,
`dronecanGimbalCentre`, `dronecanLedOff`, the control half of `dronecanOnShow`, and their
`window.*` exports. First check nothing else calls them; `drone.js` uses
`dronecanCtl`/`dronecanSetCtl`. Update the comments that describe the tab bar as the second
window: the `drone.js` header and the static-markup comments in `index.html`. Update
`.claude/modules.md` if it mentions the bench bar.

**Keep the static-markup rule:** `#dc-panes` re-renders its slots at ~15 fps. The section
skeleton is built once, in `dcPaneSlots()` (verified), and only the `data-slot` children
change. So the service buttons and the period input go in that skeleton's section headers,
never inside a `data-slot`. The roster's delegated click handler (`[data-dc-fail]`) lives in
`dcPaneSlots()` too. That is where the select-versus-Fail split happens.

The Drone dashboard also shows per-node failure state (`failMask` in `drone.js`). The roster's
Fail toggle stays anyway: failure injection belongs next to the NodeStatus health it changes.

## J1939 / N2K / ISO 11783 (`#j1939Wrap`, `j1939.js`, `truck.js`)

| Today | Change |
|---|---|
| "DM1 lamps → Carlito: Red stop / Amber warn / Protect" + "DM1's MIL is the contract's own `checkEngine`, so it is not repeated here." + "Trailer → Carlito: EBS fault / ABS (J2497)" | **Move to the Truck panel's Commands section (decided).** All five signals are `vehicles: ["truck"]` in the contract. `j1939.js` keeps ownership (`j1939Lamps` and its `carlitoUplinkSources`) and exports a getter and setter. `truck.js` renders the controls as a view, the same pattern its Commands section already uses for isobus/cleanopen/j1939-flavor. Only two places read `j1939Lamps` today (verified): its `carlitoUplinkSources` entries and `j1939LampChange()` (which reads the DOM). The setter replaces the latter. The MIL sentence becomes a code comment. |
| "Request a PGN (59904): PGN [65261] from [255] [Send request] Answerable here [-▾]", centred on its own row | Compact controls at the right end of the sub-tab bar: one PGN control that merges the input with the "answerable here" presets (`j1939ReqPreset` fills only the PGN; the address stays as typed, and 255 asks every ECU), the address, a **Request** button, and the status inline. Drop the caption; "59904" goes in the button tooltip. |
| "No J1939 frames received yet. J1939 uses 29-bit extended CAN IDs." | "No J1939 frames yet." (same pattern for the N2K and ISO modes) |
| A learn link only in the N2K and ISO modes | One `.learn` for all three modes. J1939 mode points to `explainers/j1939-explainer.html`. |
| PGN table: signal names at 10px sans next to 11.5px mono values; 10px column headers | `--fs-s` caption + `--fs-m` mono value. Headers per phase 1. |

## CHAdeMO (`#chademoWrap`, `chademo.js`)

- Delete the `.chademo-note` row, which holds only "Learn how EV charging works ↗". Put the state
  pill, Pause demo and `.learn` in one `.bar`.
- The seven stat cards leave a gap on the right. Use `.stat` in an
  `auto-fit, minmax(160px,1fr)` grid so they fill the row.
- Flag-group titles "Vehicle faults (0x102 byte 4)" → "Vehicle faults". The byte location goes in
  the title tooltip.
- Empty: "No CHAdeMO frames yet." (cut the 0x100–0x109 / 500 kbit/s / Demo sentence).

## CANopen (`#canopenWrap`, `canopen.js`)

- Bar: Node visible. SDO timeout, SDO req and SDO rsp go into a ⚙ popover (`.dropdown-menu`);
  they're rarely changed overrides. `.learn` moves up from the log bar.
- Node table: node numbers are right-aligned under a left-aligned header, so left-align them.
  Unknown state renders as an empty "–" circle; make it blank. Message pills `--fs-s`.
- The SDO, NMT and SYNC forms sit below the node map and fall off-screen once a few nodes show
  up. At ≥ 1200px put them in a right column (~360px) next to the map.
- Empty: "No CANopen frames yet." (cut the COB-ID sentence). The decoded column becomes
  `--fs-m`, and the hex is mono (phase 1).

## Done when

- On none of these four tabs does the sentence sweep (phase 1 appendix) return anything.
- In the DroneCAN Demo with no game, the Drone controls button opens Drone Control, and its
  LED, beep, hook and gimbal changes show up in the Transfer Log.
- With a drone on the link, Drone Control still drives mode, LEDs, beep, hook and gimbal. With
  a truck, the five lamps can be set from the Truck panel and reach the game.
  `window.carlitoDebugInjectTelemetry` can stand in for the game.
- The smoke test passes, including each tab's `*SelfTest`, and no golden frame changes (this is
  UI only). The user verifies in Demo.
