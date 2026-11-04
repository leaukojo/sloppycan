// ── DroneCAN (UAVCAN v0): the tab half ────────────────────────────────────────
// dronecan-core.js, loaded immediately before this file (and alone on carlito-bridge.html), is the
// codec, the node roster, the flavor packer, the dcCtl uplink sources and the bus-command decoder;
// its header describes the protocol. This file is what index.html adds on top: the receive path
// (dronecanIngestFrame) and the roster it builds, the services and dynamic node id allocation, the
// tab, the demo quad, persistence and the self-test. One global scope: never redeclare a name the
// core declares.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   sloppycan.js  ingestFrame(), after the canopen hook:
//     if (window.dronecanIngestFrame) dronecanIngestFrame(frame);
//   sloppycan.js  clearFrames(), at end:  if (window.dronecanClear) dronecanClear();
//   sloppycan.js  disconnectSerial():     if (window.dronecanStop) window.dronecanStop();
//   sloppycan.js  startup:  window.dronecanScheduleSave = scheduleSave;
//   sloppycan.js  switchViewTab(): dronecan tab toggle + wrap show/hide + dronecanOnShow()
//   sloppycan.js  demo base-traffic engine: dronecanDemoStart/Stop + demoInitialBaseTraffic
//   sloppycan.js  persistence: defaultWorkspaceData/collectSettings/applySettings 'dronecan' key
//   index.html    view-tabs button + #dronecanWrap content (the config bar, the bench-control bar,
//                 the gimbal bar, the SERVICE bar, #dc-panes, #dc-log) + <script src="dronecan-core.js"
//                 defer> then <script src="dronecan.js" defer> (after carlito-registry.js, where the
//                 packer and uplink-source registries live)
//   carlito-bridge.html  dronecan-core.js only: that page has no tab markup and no sloppycan.js.
//
// Telemetry TX rides carlito.js's canForward gateway (which is what puts it on the wire
// and in the dump as an FW entry). No transport code here.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.dc-config {
  background:var(--bg2); border-bottom:1px solid var(--border);
  padding:7px 16px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;
  flex-shrink:0; font-family:var(--sans); font-size:11px; color:var(--text2);
}
.dc-config label { display:flex; align-items:center; gap:5px; }
.dc-config input[type=text] { width:52px; padding:0 6px; }
.dc-config .dc-note { color:var(--text3); margin-left:auto; }
/* The bench-control bar reuses .dc-config; only the colour swatch and the Off button are new. */
.dc-config select { padding:1px 4px; }
.dc-config input[type=color] { width:34px; height:19px; padding:0; border:1px solid var(--border); background:var(--bg); cursor:pointer; }
.dc-config button {
  background:var(--bg); border:1px solid var(--border); color:var(--text2);
  border-radius:4px; padding:1px 8px; cursor:pointer; font-family:var(--sans); font-size:11px;
}
.dc-config button:hover { background:var(--bg3); color:var(--text); }
.dc-logbar {
  background:var(--bg2); border-top:1px solid var(--border); border-bottom:1px solid var(--border);
  padding:6px 16px; display:flex; align-items:center; gap:14px; flex-shrink:0;
  font-family:var(--sans); font-size:12px; font-weight:600; color:var(--text);
}
.dc-logbar .dc-errs { margin-left:auto; font-weight:400; font-size:11px; color:var(--text3); }
.dc-logbar .dc-errs b { color:var(--amber); font-weight:600; }
.dc-panes { padding:10px 16px 12px; display:flex; flex-direction:column; gap:12px; }
.dc-grp-title {
  font-family:var(--sans); font-size:11px; font-weight:700; letter-spacing:.06em;
  text-transform:uppercase; color:var(--text3); margin-bottom:5px;
}
.dc-tbl { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:11px; }
.dc-tbl th {
  background:var(--bg2); color:var(--text3); font-family:var(--sans); font-size:10px;
  font-weight:700; letter-spacing:.05em; text-transform:uppercase;
  text-align:left; padding:4px 8px; position:sticky; top:0; z-index:1;
}
.dc-tbl td { padding:3px 8px; border-top:1px solid var(--border); color:var(--text2); white-space:nowrap; }
.dc-tbl td.dc-id   { color:var(--blue); }
.dc-tbl td.dc-node { color:var(--text); font-weight:600; }
.dc-tbl td.dc-msg  { color:var(--green); }
.dc-tbl td.dc-raw  { color:var(--text3); }
.dc-tbl td.dc-dec  { color:var(--text); white-space:normal; }
.dc-tbl td.dc-ts   { color:var(--text3); }
.dc-tbl tr.dc-bad td { color:var(--amber); }
.dc-tbl a.dc-seecan { color:var(--blue); text-decoration:none; }
.dc-chip {
  display:inline-block; padding:1px 6px; border:1px solid var(--border); border-radius:2px;
  font-family:var(--sans); font-size:10px; font-weight:600; color:var(--text2);
}
.dc-chip.ok   { color:var(--green); border-color:var(--green-dim); }
.dc-chip.warn { color:var(--amber); border-color:var(--amber); }
.dc-chip.off  { color:var(--text3); }
.dc-empty { color:var(--text3); font-family:var(--sans); font-size:12px; padding:14px 16px; line-height:1.6; }
.dc-readout { font-family:var(--mono); font-size:11px; color:var(--text3); padding-top:4px; }
`;
  document.head.appendChild(s);
})();

// ── Shared formatters (defined in sloppycan.js; aliased, not re-implemented) ───
const dcRelTs    = window.canRelTs;
const dcHexBytes = window.canHexBytes;
const dcEscHtml  = window.escHtml;

const DC_LOG_MAX = 500;

// ── Receive state ─────────────────────────────────────────────────────────────
const dcRx = dcNewRxState();
const dcNodes = new Map();        // node id -> { lastSeen, msgs:Set, last: {name, vals} }

// What the tab may DISPLAY: dcPresent()'s evidence, or the tab on show.
function dcShown() {
  if (dcPresent()) return true;
  const wrap = document.getElementById('dronecanWrap');
  return !!(wrap && wrap.style.display !== 'none');
}
// Whether a reply may go on the wire: a DroneCAN bus, and the tab's Transmit switch on.
function dcMayAnswer() { return dcCfg.txEnabled && dcPresent(); }

function dronecanIngestFrame(frame) {
  if (!frame || !frame.isExt || frame.isRtr) return;
  // Not a DroneCAN bus and nobody looking: nothing to reassemble for. A NodeStatus still goes
  // through, so the node that made the bus present is on the roster from its first heartbeat.
  if (!dcSniffNodeStatus(frame) && !dcShown()) return;
  const done = dcFeedFrame(dcRx, frame.id, frame.data);
  if (!done) { if (dcRx.err.orphan || dcRx.err.toggle || dcRx.err.tid || dcRx.err.crc || dcRx.err.oversize) dcTab.markDirty(); return; }
  const now = Date.now();

  // A SERVICE TRANSFER IS NOT A NODE ANNOUNCING ITSELF, so it deliberately does not touch
  // dcNodes: a node that answers a question has not thereby published a heartbeat, and letting a
  // GetNodeInfo response refresh the roster's "last seen" would hide exactly the case the roster
  // exists to show. It goes to the service layer and to the log, and nowhere else.
  if (done.kind === 'svc') { dcSvcIngest(done, frame.id, now); return; }
  // Only an Allocation is ever sent anonymously here, and its two surviving type-id bits plus a
  // single-frame length (the node_id byte and 1-6 unique-id bytes) are all an anonymous id can be
  // checked against. That still passes about a quarter of SA-0x00 J1939 traffic, hence dcPresent.
  if (done.kind === 'anon') {
    if (done.msgTypeIdLow !== (DC_ALLOC.id & 3) || done.error ||
        done.payload.length < 2 || done.payload.length > 1 + DC_UID_CHUNK || !dcShown()) return;
    dcAnonIngest(done, frame.id, now);
    return;
  }

  const m = DC_MSGS[done.dataTypeId];
  const vals = m ? dcDecode(m, done.payload) : null;
  if (m && m.id === 341 && done.frames === 1 && !done.error && done.payload.length === 7) dcNsHeardAt = now;

  let n = dcNodes.get(done.srcNode);
  // A new source joins the roster only on a bus shown to be DroneCAN, or with the tab on show (dcShown).
  if (!n && dcShown()) { n = { lastSeen: 0, msgs: new Set(), last: null }; dcNodes.set(done.srcNode, n); }
  if (n) {
    n.lastSeen = now;
    n.msgs.add(m ? m.short : dcH(done.dataTypeId, 4));
    if (vals) n.last = { name: m.short, vals };
    // The heartbeat is tracked apart from `last`, which any later message overwrites: the roster
    // view reads presence off NodeStatus alone, so it needs that message's own timestamp.
    // uptime_sec rides along because a RESTART is only visible as that number going backwards.
    if (vals && m && m.id === 341) { n.nsAt = now; n.health = vals.health; n.uptime = vals.uptime_sec; }
  }
  // A NON-anonymous Allocation is the allocator talking, and the bench allocatee is listening for
  // it exactly the way a real one does - off the bus, with no idea the allocator is in the same
  // file. This is the line that makes the exchange a protocol rather than a re-enactment.
  if (vals && m && m.id === 1 && dcPresent()) dcAllocateeHeard(vals);

  dcTab.pushLog({
    ts: now,
    id: frame.id >>> 0,
    node: done.srcNode,
    dtid: done.dataTypeId,
    name: m ? m.short : ('type ' + done.dataTypeId),
    known: !!m,
    frames: done.frames,
    bad: done.crcOk === false || !!done.error,
    crcOk: done.crcOk,
    data: done.payload,
    summary: vals ? dcSummary(m, vals) : '',
    escIndex: vals && m && m.id === 1034 ? vals.esc_index : null,
  });
}

// ── SERVICES ──────────────────────────────────────────────────────────────────
// Everything above this line is one-way: a node decides something is worth publishing and
// publishes it, and a listener either heard it or did not. A SERVICE is the other shape - a
// question addressed to one node, and that node's answer addressed back. It is a bus concept
// and NOT a game-state concept, which is why none of it touched the contract: what these
// services talk about is the roster this module already declares and the status those nodes
// already publish, so the answers are on the wire already, one field at a time, forever.
//
// Both halves live here. The SERVER stands in for the eight roster nodes; the CLIENT is the bar
// in the tab, a maintenance tool at node 127. They talk over the bus rather than through a
// function call - a request really is transmitted and really does come back through
// ingestFrame - so the transfer log shows the whole exchange the way a real one looks.

// The tool's own node id. DroneCAN reserves the top two ids for exactly this: the Allocation
// DSDL says an allocator must skip "126 and 127, that are reserved for network maintenance
// tools", so claiming one is not squatting, it is what they are for.
const DC_TOOL_NODE = 127;
// A response is expected within this long. Nothing retries: on a bench bus a lost response is
// information, and a retry would paper over the node that stopped answering.
const DC_SVC_TIMEOUT_MS = 1500;

// Node identity, for GetNodeInfo. NOT INVENTED, in the sense that matters: every field is either
// a real property of this module's model of that node or a DSDL "unknown" constant.
//   - the name is the roster's, in DSDL's own reversed-domain style (it asks for lowercase
//     ASCII, dots, dashes and underscores, and rejects nothing else here);
//   - the unique id is DERIVED FROM THE NODE ID by a fixed rule rather than randomised, because
//     a unique id that changed every reload is not a unique id - it is the one field a real
//     node burns in at manufacture and never changes again;
//   - hardware and software version are this module's own version numbers, which are the only
//     versions there are to report;
//   - vcs_commit and image_crc are left at zero WITH THEIR FLAG BITS CLEAR, which is DSDL's way
//     of saying "not known" for a field that has no NaN. Setting a flag and a zero would claim
//     a build identity that does not exist.
const DC_SW_MAJOR = 1, DC_SW_MINOR = 0;
const DC_HW_MAJOR = 1, DC_HW_MINOR = 0;
function dcNodeName(i) { return 'org.sloppycan.carlito.' + DC_ROSTER[i].name.toLowerCase(); }
function dcUniqueId(i) {
  // A stable 16-byte id: a fixed prefix that says which fleet this is, then the node id, then a
  // simple mix so two nodes do not differ in one byte. Deterministic on purpose - see above.
  const id = DC_ROSTER[i].id & 0x7F;
  const u = [0x53, 0x43, 0x41, 0x4E];           // 'SCAN'
  for (let k = 0; k < 12; k++) u.push((id * 31 + k * 17 + 0x5A) & 0xFF);
  return u;
}

// The parameters each node exposes. EVERY ONE IS A REAL PROPERTY OF THIS MODULE - there is no
// pretend parameter store behind them, because a GetSet that wrote into a private object nobody
// reads would be a form with no building attached. Two are read-only reflections of things the
// roster declares, and the DSDL already says what to do about a write it will not honour: the
// response "should contain the actual parameter value after the set request was executed... to
// let the client know if the value could not be updated", so a rejected write answers with the
// unchanged value and the client sees it did not take.
function dcNodeParamDefs(i) {
  const defs = [
    { name: 'uavcan.node.id', get: () => DC_ROSTER[i].id, min: 1, max: 127, def: DC_ROSTER[i].id },
    { name: 'uavcan.node.status_period_ms',
      get: () => dcNodeParams[i].statusPeriodMs,
      set: (v) => { dcNodeParams[i].statusPeriodMs = Math.max(100, Math.min(10000, Math.round(v))); },
      min: 100, max: 10000, def: DC_NS_PERIOD_MS },
  ];
  // An ESC additionally reports which of the four it is - the index it stamps into every
  // esc.Status. Read-only for the same reason the node id is: DC_ROSTER is the ONE place an id
  // is declared, and a parameter that could move it would be a second place.
  if (i < DC_ESC_COUNT) defs.push({ name: 'esc.index', get: () => i, min: 0, max: 15, def: i });
  return defs;
}

// A node is answerable when it is PUBLISHING - read off its own decoded NodeStatus, the same
// fact and the same freshness the roster view reads. A node taken off the bus by node_fail, or
// one in its reboot window, or a whole aircraft that is not on the link, answers NOTHING. That
// silence is the reading: a request that goes unanswered is how you learn a node is gone, and
// putting a response in its place would be inventing the node back.
function dcNodeLive(i) {
  const n = dcNodes.get(DC_ROSTER[i].id);
  if (!n || !n.nsAt) return false;
  if (Date.now() - n.nsAt > DC_NODE_STALE_MS) return false;
  return !(dcRebootAt[i] && Date.now() - dcRebootAt[i] < DC_REBOOT_MS);
}
const dcRosterIndexOf = (nodeId) => DC_ROSTER.findIndex(r => r.id === nodeId);

// Everything the service layer puts on the wire goes through the SAME gateway carlito.js's
// telemetry rides - ingested once for the decoders and transmitted when a bus is open. It is
// deferred by a tick rather than emitted inside ingestFrame: a node answers a moment after it is
// asked, not inside the same call stack, and the deferral keeps the re-entrancy depth at one.
function dcEmit(frames) {
  if (!frames || !frames.length) return;
  setTimeout(() => {
    for (const f of frames) {
      const fr = { id: f.id, isExt: true, isRtr: false, dlc: f.data.length, data: f.data };
      if (window.canForward) window.canForward(fr);
      else if (window.ingestFrame) window.ingestFrame(fr);
    }
  }, 0);
}

// ── The server ────────────────────────────────────────────────────────────────
function dcServeRequest(done) {
  if (!dcMayAnswer()) return;                    // not a DroneCAN bus, or Transmit off - see dcPresent
  const i = dcRosterIndexOf(done.destNode);
  if (i < 0 || !dcNodeLive(i)) return;          // not one of ours, or not on the bus - silence
  const svc = DC_SVCS[done.svcTypeId];
  if (!svc) return;                              // a service this node does not implement
  const reply = (payload) =>
    // The request's OWN transfer id and priority, echoed - see dcSvcTransfer.
    dcEmit(dcSvcTransfer(svc, false, done.destNode, done.srcNode, payload, done.tid, done.priority));

  if (svc.id === 1) {                            // GetNodeInfo
    const n = dcNodes.get(DC_ROSTER[i].id);
    reply(dcEncode(svc.resp, {
      // Straight out of the roster and the node's own last heartbeat. The uptime is the one this
      // module is publishing for that node, so a restart shows here first.
      uptime_sec: dcNodeUpAt[i] ? Math.floor((Date.now() - dcNodeUpAt[i]) / 1000) : 0,
      health: (n && n.health != null) ? n.health : 0,
      mode: 0,
      sub_mode: 0,
      vendor_specific_status_code: 0,
      sw_major: DC_SW_MAJOR, sw_minor: DC_SW_MINOR,
      sw_optional_field_flags: 0,               // neither vcs_commit nor image_crc is known
      sw_vcs_commit: 0, sw_image_crc_lo: 0, sw_image_crc_hi: 0,
      hw_major: DC_HW_MAJOR, hw_minor: DC_HW_MINOR,
      unique_id: dcUniqueId(i),
      coa_len: 0,                                // no certificate of authenticity
      name: dcNodeName(i),
    }));
    return;
  }

  if (svc.id === 5) {                            // RestartNode
    const q = dcDecode(svc.req, done.payload);
    const ok = q.magic_number === DC_RESTART_MAGIC;
    reply(dcEncode(svc.resp, { ok: ok ? 1 : 0 }));
    if (!ok) return;
    // Answer first, THEN go away - which is the order a real node does it in, and the reason the
    // ok=true is not a lie about a node that is about to stop talking.
    dcRebootAt[i] = Date.now();
    dcNodeUpAt[i] = 0;                           // its clock restarts when it comes back
    dcNsLastAt[i] = 0;
    dcTab.markDirty();
    return;
  }

  if (svc.id === 11) {                           // param.GetSet
    const q = dcGetSetDecodeReq(done.payload);
    const defs = dcNodeParamDefs(i);
    // Name beats index whenever it is non-empty - the DSDL says so outright.
    const def = q.name ? defs.find(d => d.name === q.name) : defs[q.index];
    if (!def) {
      // "Empty name (and/or empty value) in response indicates that there is no such parameter."
      // That IS the end-of-list marker an index walk stops on; there is no count to ask for.
      reply(dcGetSetEncodeResp({ value: dcValEmpty(), defaultValue: dcValEmpty(),
                                 maxValue: { kind: DC_NUM_EMPTY }, minValue: { kind: DC_NUM_EMPTY }, name: '' }));
      return;
    }
    // A set request carries a non-empty value. A read-only parameter simply does not apply it,
    // and the response reports the value that IS there - see dcNodeParamDefs.
    if (q.value && q.value.kind !== DC_VAL_EMPTY && def.set) def.set(Number(q.value.v));
    reply(dcGetSetEncodeResp({
      value: dcValInt(def.get()),
      defaultValue: dcValInt(def.def),
      maxValue: dcNumInt(def.max),
      minValue: dcNumInt(def.min),
      name: def.name,
    }));
    dcTab.markDirty();
    return;
  }
}
// uint40 MAGIC_NUMBER = 0xACCE551B1E, straight off the DSDL. Written as a decimal because a
// 40-bit hex literal is fine in JavaScript but the comparison below is against a number the bit
// reader produced, and 0xACCE551B1E is exactly representable either way.
const DC_RESTART_MAGIC = 0xACCE551B1E;

// ── Service results, for the tab ──────────────────────────────────────────────
const dcSvcPending = new Map();   // 'svc:dest:tid' -> { ts, kind, dest }
const dcNodeInfo = new Map();     // node id -> the decoded GetNodeInfo response
const dcNodeParamsSeen = new Map(); // node id -> [{ name, value, min, max, def }]
let dcSvcNote = '';               // one line of "what just happened", for the pane

function dcSvcIngest(done, id, now) {
  const svc = DC_SVCS[done.svcTypeId];
  const key = `${done.svcTypeId}:${done.srcNode}:${done.tid}`;
  let summary = '', name = svc ? svc.short : ('service ' + done.svcTypeId);
  name += done.isRequest ? ' req' : ' resp';

  if (svc && done.crcOk !== false) {
    try {
      if (svc.id === 11) {
        summary = done.isRequest ? dcGetSetReqSummary(dcGetSetDecodeReq(done.payload))
                                 : dcGetSetRespSummary(dcGetSetDecodeResp(done.payload));
      } else {
        const half = done.isRequest ? svc.req : svc.resp;
        summary = half.fields.length ? dcSummary(half, dcDecode(half, done.payload)) : '(empty)';
      }
    } catch (e) { summary = 'decode failed'; }
  }

  // A request addressed to a roster node is answered by the server; one addressed to the tool is
  // an answer to something the tool asked.
  if (done.isRequest) {
    dcServeRequest(done);
  } else if (dcSvcPending.has(key)) {
    const p = dcSvcPending.get(key);
    dcSvcPending.delete(key);
    dcSvcResolve(svc, done, p);
  }

  dcTab.pushLog({
    ts: now, id: id >>> 0,
    node: done.srcNode,
    dtid: done.svcTypeId,
    name: name + ' →' + done.destNode,
    known: !!svc,
    frames: done.frames,
    bad: done.crcOk === false || !!done.error,
    crcOk: done.crcOk,
    data: done.payload,
    summary,
    escIndex: null,
  });
  dcTab.markDirty();
}

function dcSvcResolve(svc, done, pending) {
  if (!svc) return;
  if (svc.id === 1) {
    const v = dcDecode(svc.resp, done.payload);
    v.nameText = dcAscii(v.name);
    v.uidHex = dcHexJoin(v.unique_id);
    dcNodeInfo.set(done.srcNode, v);
    dcSvcNote = `GetNodeInfo from node ${done.srcNode}: ${v.nameText}`;
  } else if (svc.id === 5) {
    const v = dcDecode(svc.resp, done.payload);
    dcSvcNote = v.ok ? `node ${done.srcNode} accepted the restart - watch its row go silent, then come back at uptime 0`
                     : `node ${done.srcNode} REJECTED the restart (wrong magic number)`;
  } else if (svc.id === 11) {
    const a = dcGetSetDecodeResp(done.payload);
    const list = dcNodeParamsSeen.get(done.srcNode) || [];
    if (!a.name && a.value.kind === DC_VAL_EMPTY) {
      dcSvcNote = `node ${done.srcNode}: ${list.length} parameter${list.length === 1 ? '' : 's'} enumerated`;
    } else {
      const at = list.findIndex(x => x.name === a.name);
      const row = { name: a.name, value: a.value, def: a.defaultValue, min: a.minValue, max: a.maxValue };
      if (at >= 0) list[at] = row; else list.push(row);
      dcNodeParamsSeen.set(done.srcNode, list);
      dcSvcNote = `node ${done.srcNode}: ${a.name} = ${dcValueText(a.value)}`;
      // Walk on. The DSDL is clear that index access is ONLY for enumerating, so the client asks
      // for index+1 and stops at the nameless answer rather than asking for a count that does
      // not exist. One request in flight at a time, which is also why this chains off the reply.
      if (pending && pending.walk != null && dcPresent()) dcParamRequest(done.srcNode, pending.walk + 1, null, '', pending.walk + 1);
    }
  }
  dcTab.markDirty();
}

// ── The client ────────────────────────────────────────────────────────────────
function dcSendRequest(svcId, destNode, payload, extra) {
  const svc = DC_SVCS[svcId];
  if (!svc) return;
  const tid = dcNextTid('svc' + svcId + ':' + DC_TOOL_NODE + ':' + destNode);
  dcSvcPending.set(`${svcId}:${destNode}:${tid}`, Object.assign({ ts: Date.now(), dest: destNode }, extra || {}));
  dcEmit(dcSvcTransfer(svc, true, DC_TOOL_NODE, destNode, payload, tid));
  // Expire rather than retry - an unanswered request is the reading, not a transport problem.
  setTimeout(() => {
    const k = `${svcId}:${destNode}:${tid}`;
    if (!dcSvcPending.has(k)) return;
    dcSvcPending.delete(k);
    dcSvcNote = `no answer from node ${destNode} - it is not on the bus`;
    dcTab.markDirty();
  }, DC_SVC_TIMEOUT_MS);
}
function dcParamRequest(destNode, index, value, name, walk) {
  dcSendRequest(11, destNode, dcGetSetEncodeReq(index, value || dcValEmpty(), name || ''), { walk });
}

function dcSelectedNode() {
  const el = document.getElementById('dcSvcNode');
  const v = el ? parseInt(el.value, 10) : NaN;
  return Number.isFinite(v) ? v : DC_ROSTER[0].id;
}
function dronecanGetNodeInfo() {
  const node = dcSelectedNode();
  dcSvcNote = `asking node ${node} who it is...`;
  dcSendRequest(1, node, []);            // an empty request: the question IS the id
  dcTab.markDirty(); dcTab.render();
}
function dronecanReadParams() {
  const node = dcSelectedNode();
  dcNodeParamsSeen.delete(node);
  dcSvcNote = `enumerating node ${node}'s parameters by index...`;
  dcParamRequest(node, 0, null, '', 0);
  dcTab.markDirty(); dcTab.render();
}
function dronecanRestartNode() {
  const node = dcSelectedNode();
  dcSvcNote = `asking node ${node} to restart...`;
  dcSendRequest(5, node, dcEncode(DC_SVCS[5].req, { magic_number: DC_RESTART_MAGIC }));
  dcTab.markDirty(); dcTab.render();
}
// The same request with the magic number one short, so the rejection can be seen rather than
// taken on trust. A guard nobody has watched refuse anything is a guard nobody has tested.
function dronecanRestartBadMagic() {
  const node = dcSelectedNode();
  dcSvcNote = `asking node ${node} to restart with a WRONG magic number...`;
  dcSendRequest(5, node, dcEncode(DC_SVCS[5].req, { magic_number: DC_RESTART_MAGIC - 1 }));
  dcTab.markDirty(); dcTab.render();
}
// Write the one writable parameter, from the box beside the buttons. Sending a value is what
// makes it a SET; sending an empty one is a get, which is what every button above does.
function dronecanSetPeriod() {
  const node = dcSelectedNode();
  const el = document.getElementById('dcSvcPeriod');
  const v = el ? parseInt(el.value, 10) : NaN;
  if (!Number.isFinite(v)) return;
  dcSvcNote = `setting node ${node}'s NodeStatus period to ${v} ms...`;
  dcParamRequest(node, 0, dcValInt(v), 'uavcan.node.status_period_ms');
  dcTab.markDirty(); dcTab.render();
}

// ── DYNAMIC NODE ID ALLOCATION ────────────────────────────────────────────────
// The one protocol here that has to work before anything else does. Every id in DC_ROSTER is
// declared - somebody sat down and decided the GNSS node is 20 - and that is fine for eight
// nodes on one airframe and untenable the moment a fleet shares parts. So DroneCAN defines a way
// for a node with NO id to ask for one, over a bus whose addressing is built out of node ids.
//
// The trick is the anonymous frame (dcAnonId above): source node id 0, and 14 bits of random
// DISCRIMINATOR where the message type id would have been, purely so two nodes asking at the
// same instant do not transmit byte-identical frames and annihilate each other under CAN
// arbitration. What is left is six bytes of payload per request - hence the DSDL's own
// MAX_LENGTH_OF_UNIQUE_ID_IN_REQUEST = 6, and hence the whole three-stage dance: a 16-byte
// unique id does not fit in one anonymous frame, so it is sent six bytes at a time, and the
// allocator echoes back what it has so the allocatee knows how much got through.
//
// BOTH ENDS ARE HERE AND THEY TALK OVER THE BUS. The allocator answers any allocatee; the bench
// allocatee (the button) is a real node emitting real anonymous frames that come back through
// ingestFrame. Neither can see the other's variables, which is the only way the exchange in the
// transfer log is the actual protocol rather than a re-enactment of it.
const DC_ALLOC = DC_MSGS[1];
const DC_UID_LEN = 16;
const DC_UID_CHUNK = 6;              // MAX_LENGTH_OF_UNIQUE_ID_IN_REQUEST
const DC_FOLLOWUP_TIMEOUT_MS = 500;  // FOLLOWUP_TIMEOUT_MS - the allocator forgets a stalled request
const DC_MAX_FOLLOWUP_DELAY_MS = 400;// MAX_FOLLOWUP_DELAY_MS, the allocatee's randomised wait
// 126 and 127 are reserved for maintenance tools, so the search stops at 125 - the DSDL spells
// out the whole algorithm, including that an allocatee with no preference gets the HIGHEST free
// id rather than the lowest, which keeps dynamic ids out of the way of declared ones.
const DC_ALLOC_MAX_ID = 125;

const dcAllocTable = new Map();      // unique id (hex) -> granted node id
let dcAllocSession = null;           // { uid: [bytes], ts } - one at a time, per the DSDL
const dcAllocLog = [];               // what the allocator did, for the pane
const DC_ALLOC_LOG_MAX = 12;

function dcAllocOccupied() {
  const set = new Set(DC_ROSTER.map(r => r.id));
  set.add(dcCfg.fcNode & 0x7F);
  set.add(DC_TOOL_NODE);
  for (const v of dcAllocTable.values()) set.add(v);
  return set;
}
// The DSDL's own pseudocode, transcribed: search UP from the preferred id (or 125 when there is
// no preference), then DOWN from it, and report failure rather than handing out a duplicate.
function dcAllocFindFree(preferred) {
  const busy = dcAllocOccupied();
  // The preference is CLAMPED to 125 first. node_id is a uint7, so an allocatee is free to ask
  // for 126 or 127 - and the downward search would have handed one over, because the reserved
  // pair is reserved by convention rather than by being in the occupied set. Clamping is what
  // makes "except 126 and 127" true of both directions rather than only the upward one.
  const pref = Math.min(Math.max(preferred | 0, 0), DC_ALLOC_MAX_ID);
  let c = pref > 0 ? pref : DC_ALLOC_MAX_ID;
  while (c <= DC_ALLOC_MAX_ID) { if (!busy.has(c)) return c; c++; }
  c = pref > 0 ? pref : DC_ALLOC_MAX_ID;
  while (c > 0) { if (!busy.has(c)) return c; c--; }
  return -1;
}
function dcAllocSay(text) {
  dcAllocLog.push({ ts: Date.now(), text });
  while (dcAllocLog.length > DC_ALLOC_LOG_MAX) dcAllocLog.shift();
  dcTab.markDirty();
}
// The allocator's own reply: a NON-anonymous Allocation from the allocator node, carrying the
// unique-id bytes it has accumulated. node_id is 0 while the id is still incomplete and the
// granted id once it is - which is the entire signalling protocol, in one field.
function dcAllocReply(nodeId, uid) {
  dcEmit(dcTransfer(DC_ALLOC, dcCfg.fcNode & 0x7F, dcEncode(DC_ALLOC, {
    node_id: nodeId & 0x7F,
    first_part_of_unique_id: 0,       // meaningless from a non-anonymous source; the DSDL says zero it
    unique_id: uid,
  })));
}

function dcAnonIngest(done, id, now) {
  let summary = '', v = null;
  try { v = dcDecode(DC_ALLOC, done.payload); summary = dcSummary(DC_ALLOC, v); } catch (e) { summary = 'decode failed'; }

  dcTab.pushLog({
    ts: now, id: id >>> 0, node: 0, dtid: DC_ALLOC.id,
    name: 'Allocation (anonymous)', known: true,
    frames: done.frames, bad: !!done.error, crcOk: done.crcOk,
    data: done.payload, summary, escIndex: null,
  });

  if (!v) return;
  // Logged above for the tab; ANSWERED only on a bus shown to be DroneCAN with Transmit on.
  if (!dcMayAnswer()) {
    const note = dcCfg.txEnabled ? 'an anonymous Allocation was heard, but no DroneCAN node is publishing - not answering (see the tab note)'
                                 : 'an anonymous Allocation was heard - not answering, Transmit is off';
    if (!dcAllocLog.length || dcAllocLog[dcAllocLog.length - 1].text !== note) dcAllocSay(note);
    return;
  }
  const chunk = v.unique_id || [];
  if (v.first_part_of_unique_id) {
    dcAllocSession = { uid: chunk.slice(0, DC_UID_CHUNK), ts: now };
    dcAllocSay(`stage 1: a node with no id offered ${chunk.length} bytes of unique id (preferred id ${v.node_id || 'any'})`);
  } else {
    // A follow-up with no session, or one that arrived after the allocator gave up, is dropped -
    // the allocatee's own Request Timer will start it over, which is what that timer is for.
    if (!dcAllocSession || now - dcAllocSession.ts > DC_FOLLOWUP_TIMEOUT_MS) {
      dcAllocSay('a follow-up arrived with no live request - ignored (the allocatee will start over)');
      dcAllocSession = null;
      return;
    }
    dcAllocSession.uid = dcAllocSession.uid.concat(chunk).slice(0, DC_UID_LEN);
    dcAllocSession.ts = now;
    dcAllocSay(`follow-up: ${dcAllocSession.uid.length} of ${DC_UID_LEN} unique-id bytes received`);
  }
  const uid = dcAllocSession.uid;
  if (uid.length < DC_UID_LEN) { dcAllocReply(0, uid); return; }   // echo what we have, grant nothing yet

  const hexUid = dcHexJoin(uid);
  let granted = dcAllocTable.get(hexUid);
  if (granted == null) {
    granted = dcAllocFindFree(v.node_id | 0);
    if (granted < 0) { dcAllocSay('the allocation table is full - no free node id'); dcAllocSession = null; return; }
    dcAllocTable.set(hexUid, granted);
  }
  // The same unique id asked twice gets the SAME id back, which is the property that makes this
  // survivable: a node that reboots mid-flight rejoins as itself rather than as a new device.
  dcAllocReply(granted, uid);
  dcAllocSay(`granted node id ${granted} to ${hexUid}`);
  dcAllocSession = null;
}

// ── The bench allocatee ───────────────────────────────────────────────────────
// A pretend device with a unique id and no node id, driven by the rules in the DSDL: send the
// first six bytes, wait, send the next six when the allocator echoes back what it heard, and
// stop when a grant with the full id comes past. It reads the allocator's replies OFF THE BUS,
// so it is subject to everything a real one is.
let dcAllocatee = null;   // { uid: [16], sent, timer }
function dcAllocateeSend() {
  if (!dcAllocatee) return;
  const off = dcAllocatee.sent;
  const chunk = dcAllocatee.uid.slice(off, off + DC_UID_CHUNK);
  dcEmit(dcAnonTransfer(DC_ALLOC, dcEncode(DC_ALLOC, {
    node_id: 0,                                // ANY_NODE_ID: no preference, so it will be handed 125
    first_part_of_unique_id: off === 0 ? 1 : 0,
    unique_id: chunk,
  })));
}
function dronecanRequestAllocation() {
  // A fresh unique id each time, because each click is a different device being plugged in. This
  // is the ONE place in this module a random number is right: a unique id that is not unique is
  // not a unique id, and the allocator keys its table on it.
  const uid = [];
  for (let k = 0; k < DC_UID_LEN; k++) uid.push(Math.floor(Math.random() * 256));
  dcAllocatee = { uid, sent: 0 };
  dcAllocSay(`a new device (${dcHexJoin(uid)}) is asking for a node id`);
  dcAllocateeSend();
  dcTab.markDirty(); dcTab.render();
}
// Rule D / rule E, off the allocator's non-anonymous replies.
function dcAllocateeHeard(v) {
  if (!dcAllocatee) return;
  const heard = v.unique_id || [];
  const mine = dcAllocatee.uid;
  // Only ours: the reply must be a PREFIX of our unique id, or it is another node's exchange.
  for (let k = 0; k < heard.length; k++) if (heard[k] !== mine[k]) return;
  if (heard.length >= DC_UID_LEN && v.node_id) {
    dcAllocSay(`the device accepted node id ${v.node_id} and stopped asking`);
    dcAllocatee = null;
    return;
  }
  dcAllocatee.sent = heard.length;
  if (dcAllocatee.sent >= DC_UID_LEN) return;
  // Tfollowup: a randomised wait in [MIN_FOLLOWUP_DELAY_MS, MAX_FOLLOWUP_DELAY_MS), during which
  // a real allocatee listens and abandons its follow-up if it hears anyone else. Randomised
  // rather than fixed for the same reason the discriminator is random - so two devices that
  // started together do not stay in lockstep.
  setTimeout(dcAllocateeSend, Math.floor(Math.random() * DC_MAX_FOLLOWUP_DELAY_MS));
}


function dronecanClear() {
  dcNodes.clear();
  dcRx.asm.clear();
  dcRx.err.crc = dcRx.err.toggle = dcRx.err.tid = dcRx.err.orphan = dcRx.err.oversize = 0;
  dcTxCount = 0; dcLastTx = 0; dcArm = null; dcFlight = null;
  // Bus state, all of it: the per-node uptime clocks and the heartbeat sweep. dcFailMask and
  // dcCtl deliberately survive - they are operator intent, not something the bus told us.
  dcNodeUpAt.length = 0; dcNsLastAt.length = 0; dcRebootAt.length = 0; dcCmdPending = null;
  // The service and allocation layers are bus state too - what a node answered, and which ids
  // have been handed out, are both things this side learned FROM the bus rather than decided.
  // The per-node parameters survive for the same reason dcFailMask does: a period somebody set
  // is operator intent. dcAllocatee survives nothing - an allocatee mid-handshake on a bus that
  // just went away has no handshake left.
  dcSvcPending.clear(); dcNodeInfo.clear(); dcNodeParamsSeen.clear();
  dcAllocTable.clear(); dcAllocLog.length = 0; dcAllocSession = null; dcAllocatee = null;
  dcSvcNote = '';
  dcTab.clearLog();
}

function dronecanStop() { dcDemoStop(); }

// ── Demo ──────────────────────────────────────────────────────────────────────
// Synthesises a hovering quad and pushes it through the SAME encoder, so demo mode
// exercises the real encode -> reassemble -> decode path with no hardware and no game.
let dcDemoTimer = null;
function dcDemoStart() {
  dcDemoStop();
  const t0 = Date.now();
  dcDemoTimer = setInterval(() => {
    if (!window.ingestFrame) return;
    // One producer (j1939.js's rule): while the game's drone is on the bus, a synthetic quad would
    // be a second airframe at the same node ids, so it stands down until that stops - read off
    // what the telemetry path actually forwarded, not a second copy of this module's packer gate.
    const prod = window.carlitoProducing ? window.carlitoProducing() : null;
    if (prod && prod.producesFlavor('dronecan')) return;
    const s = (Date.now() - t0) / 1000;
    const base = 6500 + 300 * Math.sin(s * 0.7);
    const lean = 900 * Math.sin(s * 0.31);           // front/back split
    const yaw  = 500 * Math.sin(s * 0.19);           // counter-rotating diagonals
    const rpm = [base + lean + yaw, base + lean - yaw, base - lean - yaw, base - lean + yaw];
    const amps = rpm.map(r => 15 + (r - 6500) / 60);
    const temp = amps.map(a => 20 + a * 0.9);
    const fault = temp.reduce((m, c, i) => c > 90 ? (m | (1 << i)) : m, 0);
    const packA = amps.reduce((a, b) => a + b, 0) + 1.5;   // + the avionics draw, as the game does
    const soc = Math.max(0, 100 - s * 0.17);
    // A slow orbit over the Paris origin, drifting in and out of a satellite shadow so the
    // Fix2 payload, sats and hdop all move; agl dips to the -1 sentinel once a lap so the
    // range sensor's UNDEFINED branch is exercised too.
    const sats = Math.max(0, Math.round(9 + 7 * Math.sin(s * 0.23)));
    // The GNSS node off the bus for part of each lap, on its own phase (the agl sentinel below is
    // the RANGE node's business and they are different nodes).
    const gnssDown = Math.sin(s * 0.09) < -0.9;
    const needFix = dcCtl.mode === 2 || dcCtl.mode === 3;   // LOITER / RTL want a position fix
    const alt = 40 + 12 * Math.sin(s * 0.11);
    for (const f of dcBuildFrames({
      esc_rpm: rpm, esc_current: amps, esc_temp: temp, esc_fault: fault,
      battery: 16.8 - 0.042 * (100 - soc), armed: true,
      pack_current: packA, soc: soc, pack_temp: 20 + packA * 0.12,
      lat: 48.8566 + 0.0004 * Math.sin(s * 0.13), lon: 2.3522 + 0.0004 * Math.cos(s * 0.13),
      altitude: alt, sats: sats, fix_type: sats >= 4 ? 3 : (sats >= 3 ? 2 : (sats ? 1 : 0)),
      hdop: sats >= 4 ? 0.9 + 6 / Math.max(1, sats) : 10,
      agl: Math.sin(s * 0.13) < -0.95 ? -1 : alt - 8,
      pitch: 6 * Math.sin(s * 0.31), roll: -12 * Math.sin(s * 0.19),
      roll_rate: 0.4 * Math.cos(s * 0.19), pitch_rate: 0.3 * Math.cos(s * 0.31),
      yaw: 0.5 * Math.sin(s * 0.07),
      accLong: 1.5 * Math.sin(s * 0.41), accLat: 0.8 * Math.cos(s * 0.29),
      acc_vert: 0.6 * Math.sin(s * 0.17),
      arming_state: 2, prearm_fail: 0,
      // The GNSS node drops off the bus for part of each lap, which is what makes Demo mode
      // exercise the whole of this phase with no game attached: its Fix2 frames stop and its
      // roster row goes silent, and if LOITER or RTL is selected in the bar the mode degrades to
      // ALT HOLD with failsafe GPS_LOST - the readings the aircraft gives when it is killed for
      // real. The synthesised mode_actual otherwise follows the selector, so an idle demo shows
      // agreement rather than a disagreement nothing caused.
      node_online: gnssDown ? (DC_ALL_ONLINE & ~(1 << DC_I_GNSS)) : DC_ALL_ONLINE,
      node_health: DC_ROSTER.map((_, i) =>
        (gnssDown && i === DC_I_GNSS) ? 3 : (((fault >> i) & 1) ? 1 : 0)),
      mode_actual: (gnssDown && needFix) ? 1 : dcCtl.mode,
      failsafe: (gnssDown && needFix) ? 3 : 0,
      home_dist: 40 + 30 * Math.abs(Math.sin(s * 0.13)),
      // The cargo hook, picked up and put down once a lap so hardpoint.Status is exercised in
      // BOTH states rather than sitting empty: the weight follows the latch, in NEWTON.
      hardpoint_state: Math.sin(s * 0.05) > 0,
      payload_weight: Math.sin(s * 0.05) > 0 ? 19.6 : 0,
      // The gimbal, panning and tilting on its own phases so the quaternion in gimbal.Status is
      // never the identity for long (an identity quaternion is exactly what a sign error looks
      // like when it is right).
      gimbal_pitch_actual: -30 + 30 * Math.sin(s * 0.17),
      gimbal_yaw_actual: 60 * Math.sin(s * 0.11),
      // The barometer, solved through the same ISA the game uses, with the demo's own altitude
      // and a slow QNH wander - so the pressure REALLY corresponds to the altitude beside it and
      // baro_alt really disagrees, rather than being two unrelated sines.
      static_press: (101325 + 100 * Math.sin(s * 0.026)) * Math.pow(1 - 0.0065 * alt / 288.15, 5.255876),
      oat: 15 - 0.0065 * alt,
    })) window.ingestFrame({ id: f.id, isExt: true, isRtr: false, dlc: f.data.length, data: f.data });
  }, 100);
}
function dcDemoStop() { if (dcDemoTimer) { clearInterval(dcDemoTimer); dcDemoTimer = null; } }

// ── Config ────────────────────────────────────────────────────────────────────
function dcClampNode(el, def) {
  if (!el) return def;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) ? Math.max(1, Math.min(127, v)) : def;
}
function dronecanCfgChange() {
  const en = document.getElementById('dcTxEnabled');
  if (en) dcCfg.txEnabled = !!en.checked;
  dcCfg.fcNode      = dcClampNode(document.getElementById('dcFcNode'), 1);
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dronecanOnShow();
}

// ── Controls ──────────────────────────────────────────────────────────────────
// RGB565 is the LightsCommand wire layout AND the contract's `led` low 16 bits, so one packed
// value feeds both. The picker is 24-bit and the wire is 5/6/5, so the round trip QUANTISES -
// a colour comes back a shade off, which is the LEDs' real resolution and not a rounding bug.
function dcRgb565FromHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xFF, g = (v >> 8) & 0xFF, b = v & 0xFF;
  return ((Math.round(r * 31 / 255) & 0x1F) << 11) | ((Math.round(g * 63 / 255) & 0x3F) << 5) | (Math.round(b * 31 / 255) & 0x1F);
}
function dcHexFromRgb565(c) {
  const r = Math.round(((c >> 11) & 0x1F) * 255 / 31);
  const g = Math.round(((c >> 5) & 0x3F) * 255 / 63);
  const b = Math.round((c & 0x1F) * 255 / 31);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Read the three bench controls out of the bar. Only a CHANGE latches an indication command -
// see dcFlushCommands.
function dronecanCtlChange() {
  const md = document.getElementById('dcFlightMode');
  if (md) dcCtl.mode = parseInt(md.value, 10) || 0;

  const col = document.getElementById('dcLedColor');
  if (col) {
    const led = dcRgb565FromHex(col.value);
    if (led !== dcCtl.led) { dcCtl.led = led; (dcCmdPending = dcCmdPending || {}).led = led; }
  }
  const bp = document.getElementById('dcBeep');
  if (bp && !!bp.checked !== dcCtl.beep) {
    dcCtl.beep = !!bp.checked;
    (dcCmdPending = dcCmdPending || {}).beep = dcCtl.beep;
  }
  const hk = document.getElementById('dcHook');
  if (hk && !!hk.checked !== dcCtl.hook) {
    dcCtl.hook = !!hk.checked;
    (dcCmdPending = dcCmdPending || {}).hook = dcCtl.hook;
  }
  // The gimbal's two axes latch ONE command between them: an orientation is both angles, so
  // sending half of one is sending a lie about the other. Ranges come off the CONTRACT rather
  // than being typed here, the flight_mode-selector rule - the mount's stops and the signal's
  // range are one number, declared once.
  const gp = document.getElementById('dcGimbalPitch');
  const gy = document.getElementById('dcGimbalYaw');
  if (gp || gy) {
    const pitch = dcClampToRange('gimbal_pitch', gp ? parseFloat(gp.value) : dcCtl.gimbalPitch);
    const yaw = dcClampToRange('gimbal_yaw', gy ? parseFloat(gy.value) : dcCtl.gimbalYaw);
    if (pitch !== dcCtl.gimbalPitch || yaw !== dcCtl.gimbalYaw) {
      dcCtl.gimbalPitch = pitch;
      dcCtl.gimbalYaw = yaw;
      (dcCmdPending = dcCmdPending || {}).gimbal = { pitch: pitch, yaw: yaw };
    }
    dcGimbalReadout();
  }
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dcTab.markDirty();
}
// Print the commanded angles beside their sliders. The mount's ACTUAL angles are separate
// signals and are read off the telemetry in the pane below - a slider showing where the camera
// IS would hide the slew, which is the whole reason there are two pairs of signals.
function dcGimbalReadout() {
  const out = document.getElementById('dcGimbalOut');
  if (out) out.textContent = `${dcCtl.gimbalPitch >= 0 ? '+' : ''}${dcCtl.gimbalPitch}\u00B0 / ` +
    `${dcCtl.gimbalYaw >= 0 ? '+' : ''}${dcCtl.gimbalYaw}\u00B0`;
}
function dronecanGimbalCentre() {
  const gp = document.getElementById('dcGimbalPitch');
  const gy = document.getElementById('dcGimbalYaw');
  if (gp) gp.value = '0';
  if (gy) gy.value = '0';
  dronecanCtlChange();
}
function dronecanLedOff() {
  const col = document.getElementById('dcLedColor');
  if (col) col.value = '#000000';
  if (dcCtl.led !== 0) { dcCtl.led = 0; (dcCmdPending = dcCmdPending || {}).led = 0; }
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dcTab.markDirty();
}
// Failure injection: flip one roster bit of node_fail. A bench SWITCH, not a DroneCAN message and
// not damage - which is why nothing here reports a fault; the node simply stops publishing and
// the game does the rest (an offline ESC's mixer command is forced to zero at the motor).
function dronecanToggleNodeFail(i) {
  if (!(i >= 0 && i < DC_ROSTER.length)) return;
  dcFailMask ^= (1 << i);
  dcTab.markDirty(); dcTab.render();
}

// ── The bench controls, from somewhere that is not the tab ────────────────────
// drone.js drives the same aircraft from a floating panel, and it does it THROUGH THIS PAIR
// rather than by keeping its own copy of the switches. One owner per signal is the rule the
// uplink registry states; a panel with its own arm latch and mode index would be a second
// owner, and the two would disagree the first time you touched the tab.
//
// The tab's widgets are re-read from dcCtl by dronecanOnShow, which switchViewTab already calls
// on every show - so a panel change reaches them when you next look. The one case that needs
// pushing is the tab being visible RIGHT NOW, behind the floating window.
function dronecanCtl() {
  return {
    mode: dcCtl.mode, led: dcCtl.led, beep: dcCtl.beep, hook: dcCtl.hook,
    gimbalPitch: dcCtl.gimbalPitch, gimbalYaw: dcCtl.gimbalYaw,
    arm: dcCtl.arm, climb: dcCtl.climb, failMask: dcFailMask,
  };
}

// Apply a partial patch. Only a CHANGE latches an indication command, the same rule
// dronecanCtlChange follows - holding a slider still must not spam LightsCommand.
function dronecanSetCtl(patch) {
  const p = patch || {};
  // No DroneCAN message behind these four (see the dcCtl header): they ride the uplink only.
  if ('arm' in p) dcCtl.arm = !!p.arm;
  if ('climb' in p) dcCtl.climb = dcClampToRange('climb', p.climb);
  if ('mode' in p) dcCtl.mode = Math.max(0, Math.round(Number(p.mode)) || 0);
  if ('failMask' in p) dcFailMask = (Number(p.failMask) | 0) & DC_ALL_ONLINE;
  if ('led' in p) {
    const led = (Number(p.led) | 0) & 0xFFFF;
    if (led !== dcCtl.led) { dcCtl.led = led; (dcCmdPending = dcCmdPending || {}).led = led; }
  }
  if ('beep' in p && !!p.beep !== dcCtl.beep) {
    dcCtl.beep = !!p.beep;
    (dcCmdPending = dcCmdPending || {}).beep = dcCtl.beep;
  }
  if ('hook' in p && !!p.hook !== dcCtl.hook) {
    dcCtl.hook = !!p.hook;
    (dcCmdPending = dcCmdPending || {}).hook = dcCtl.hook;
  }
  // The gimbal's two axes latch ONE command between them - an orientation is both angles, so a
  // patch carrying either has to send the pair (dronecanCtlChange's rule, and its reason).
  if ('gimbalPitch' in p || 'gimbalYaw' in p) {
    const pitch = dcClampToRange('gimbal_pitch', 'gimbalPitch' in p ? p.gimbalPitch : dcCtl.gimbalPitch);
    const yaw = dcClampToRange('gimbal_yaw', 'gimbalYaw' in p ? p.gimbalYaw : dcCtl.gimbalYaw);
    if (pitch !== dcCtl.gimbalPitch || yaw !== dcCtl.gimbalYaw) {
      dcCtl.gimbalPitch = pitch;
      dcCtl.gimbalYaw = yaw;
      (dcCmdPending = dcCmdPending || {}).gimbal = { pitch: pitch, yaw: yaw };
    }
  }
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dcCtlChanged();
}
// The refresh after a dcCtl change, from a panel edit (dronecanSetCtl) or a command that came off
// the bus (dronecan-core.js's dcUplinkDecode). The tab's widgets are re-read from dcCtl on show;
// push now only if it is on screen.
dcCtlChanged = () => {
  const wrap = document.getElementById('dronecanWrap');
  if (wrap && wrap.style.display !== 'none') dronecanOnShow();
  else dcTab.markDirty();
};

// Which pre-arm checks refused, by name. A SET BIT IS A FAILED CHECK, and the seven names are
// the contract's own bit order (prearm_fail's desc) - the same table the tab's arming pane
// reads, exported so the panel cannot grow a second copy that drifts a bit out of step.
function dronecanPrearmNames(mask) {
  const m = (Number(mask) | 0) & 0xFFFF;
  const out = [];
  for (let i = 0; i < 16; i++) if ((m >> i) & 1) out.push(DC_PREARM_BITS[i] || ('bit ' + i));
  return out;
}

// The node roster, copied out: name + DroneCAN id in node_health / node_fail bit order.
function dronecanRoster() { return DC_ROSTER.map(r => ({ name: r.name, id: r.id })); }

function dronecanOnShow() {
  const en = document.getElementById('dcTxEnabled');
  if (en) en.checked = dcCfg.txEnabled;
  // The service bar's node list comes off DC_ROSTER, never typed into the markup - the roster is
  // the ONE place a node id is declared, and a hand-written <option> would be a second.
  const sn = document.getElementById('dcSvcNode');
  if (sn && !sn.options.length) {
    sn.innerHTML = DC_ROSTER.map(r => `<option value="${r.id}">${r.id} ${dcEscHtml(r.name)}</option>`).join('');
  }
  const fc = document.getElementById('dcFcNode');
  if (fc) fc.value = dcCfg.fcNode;
  const md = document.getElementById('dcFlightMode');
  if (md) {
    // Positions and labels come off the CONTRACT's own enum table (built once), never retyped -
    // the same rule the mode_actual / failsafe readouts follow.
    if (!md.options.length) {
      md.innerHTML = dcEnumKeys('flight_mode', 'in')
        .map(k => `<option value="${k}">${dcEscHtml(dcEnumLabel('flight_mode', 'in', k))}</option>`).join('');
    }
    md.value = String(dcCtl.mode);
  }
  const col = document.getElementById('dcLedColor');
  if (col) col.value = dcHexFromRgb565(dcCtl.led);
  const bp = document.getElementById('dcBeep');
  if (bp) bp.checked = dcCtl.beep;
  const hk = document.getElementById('dcHook');
  if (hk) hk.checked = dcCtl.hook;
  // Slider bounds come off the CONTRACT's own ranges, never retyped - the same rule the flight
  // mode selector's options follow. A contract that moves a gimbal stop moves the slider with it.
  for (const [id, name] of [['dcGimbalPitch', 'gimbal_pitch'], ['dcGimbalYaw', 'gimbal_yaw']]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const sig = (window.CARLITO_CONTRACT ? window.CARLITO_CONTRACT.signals : [])
      .find(x => x.name === name && x.dir === 'in');
    if (sig && Array.isArray(sig.range) && sig.range.length === 2) {
      el.min = String(sig.range[0]);
      el.max = String(sig.range[1]);
    }
  }
  const gp = document.getElementById('dcGimbalPitch');
  if (gp) gp.value = String(dcCtl.gimbalPitch);
  const gy = document.getElementById('dcGimbalYaw');
  if (gy) gy.value = String(dcCtl.gimbalYaw);
  dcGimbalReadout();
  dcTab.markDirty(); dcTab.render();
}

// ── Render ────────────────────────────────────────────────────────────────────
// The panes are a skeleton built ONCE, with keyed rows and change-only writes inside (sloppycan.js's
// renderKeyedTable / setHtmlIfChanged): rebuilt every tick, a roster row was a new node under the
// pointer several times a second, which split clicks and restarted the hover fade.
function dcPaneSlots(el) {
  if (el._dcSlots) return el._dcSlots;
  el.innerHTML =
    `<div><div class="dc-grp-title">Node roster (uavcan.protocol.NodeStatus, msg 341 - click a row to fail it)</div><div data-slot="roster"></div></div>` +
    `<div><div class="dc-grp-title">Services (GetNodeInfo 1 · RestartNode 5 · param.GetSet 11)</div><div class="dc-readout" data-slot="svcNote"></div><div data-slot="info"></div><div data-slot="param"></div></div>` +
    `<div><div class="dc-grp-title">Dynamic node ID allocation (uavcan.protocol.dynamic_node_id.Allocation, msg 1, anonymous)</div><div data-slot="alloc"></div><div data-slot="allocLog"></div></div>` +
    `<div><div class="dc-grp-title">Flight mode</div><div data-slot="mode"></div></div>` +
    `<div><div class="dc-grp-title">ESC status (uavcan.equipment.esc.Status, msg 1034)</div><div data-slot="esc"></div></div>` +
    `<div><div class="dc-grp-title">Arming (uavcan.equipment.safety.ArmingStatus, msg 1100)</div><div data-slot="arm"></div></div>` +
    `<div><div class="dc-grp-title">Everything else on the bus</div><div data-slot="nodes"></div></div>` +
    `<div class="dc-readout" data-slot="tx"></div>` +
    `<div class="dc-readout" style="color:var(--text3)" data-slot="presence">No DroneCAN heard on this bus (no NodeStatus in 5 s, no drone on the Carlito link, not DroneCAN demo): decoding only - service requests and allocations are not answered.</div>`;
  const slots = {};
  el.querySelectorAll('[data-slot]').forEach(s => { slots[s.dataset.slot] = s; });
  // One delegated listener for the roster's click-to-fail rows (data-dc-fail = roster index).
  el.addEventListener('click', e => {
    const tr = e.target.closest('[data-dc-fail]');
    if (tr) dronecanToggleNodeFail(+tr.dataset.dcFail);
  });
  return (el._dcSlots = slots);
}

function dcRenderTop() {
  const el = document.getElementById('dc-panes');
  if (!el) return;
  const slot = dcPaneSlots(el);
  const keyed = window.renderKeyedTable, setHtml = window.setHtmlIfChanged;

  // ESC roster, from what has actually been decoded off the bus (ours included - the frames
  // we forward come straight back through ingestFrame, so this doubles as an encoder check).
  const escNodes = [...dcNodes.entries()].sort((a, b) => a[0] - b[0])
    .filter(([, n]) => n.last && n.last.name === 'esc.Status');
  keyed(slot.esc, {
    tableClass: 'dc-tbl',
    theadHtml: '<tr><th>esc_index</th><th>Node</th><th>RPM</th><th>A</th><th>°C</th><th>V</th><th>Pwr %</th><th>Errors</th></tr>',
    emptyHtml: `<div class="dc-empty">No esc.Status decoded yet.<br>Fly the <b>drone</b> in the Carlito window, or press <b>Demo</b> with this tab open for a simulated quad - no hardware needed.</div>`,
  }, escNodes, ([node]) => node, ([node, n]) => {
    const v = n.last.vals;
    return { cells: [
      { cls: 'dc-node', html: v.esc_index },
      node,
      Math.round(v.rpm),
      Number.isFinite(v.current) ? v.current.toFixed(1) : '-',
      Number.isFinite(v.temperature) ? (v.temperature - 273.15).toFixed(1) : '-',
      Number.isFinite(v.voltage) ? v.voltage.toFixed(2) : '-',
      v.power_rating_pct,
      `<span class="dc-chip ${v.error_count ? 'warn' : 'ok'}">${v.error_count}</span>`,
    ] };
  });

  // ── The roster view ─────────────────────────────────────────────────────────
  // DRIVEN OFF THE DECODED NodeStatus TRAFFIC, never off the telemetry dict, and that is what
  // makes it a bus monitor rather than a second copy of the game's own node strip: a node going
  // quiet shows up AS SILENCE, which is how a real DroneCAN listener learns a node is gone. A
  // stale row is therefore the correct reading of a failed node - never red-but-live.
  const nowMs = Date.now();
  keyed(slot.roster, {
    tableClass: 'dc-tbl',
    theadHtml: '<tr><th>Node</th><th>ID</th><th>Health</th><th>Uptime</th><th>Last seen</th><th>State</th></tr>',
  }, DC_ROSTER, (r, i) => i, (r, i) => {
    const n = dcNodes.get(r.id);
    const seen = n && n.nsAt;
    const stale = !seen || (nowMs - seen) > DC_NODE_STALE_MS;   // 3x the 1 Hz heartbeat
    const h = n && n.health != null ? n.health : null;
    const killed = (dcFailMask >> i) & 1;
    const rebooting = dcRebootAt[i] && (nowMs - dcRebootAt[i]) < DC_REBOOT_MS;
    const health = !seen ? '<span class="dc-chip off">never seen</span>'
      : stale ? '<span class="dc-chip off">silent</span>'
      : `<span class="dc-chip ${h ? 'warn' : 'ok'}">${h == null ? '-' : dcEscHtml(DC_HEALTH[h] || String(h))}</span>`;
    // uptime_sec straight out of the node's own last NodeStatus, which is the ONLY place a
    // restart is visible: the number goes backwards. Reading it off the decoded heartbeat rather
    // than off dcNodeUpAt keeps this a bus monitor - it shows what the node SAID, not what this
    // module knows it would have said.
    const upt = (n && n.uptime != null && !stale) ? n.uptime + ' s' : '-';
    // The publication period is a parameter a param.GetSet can write, so a row whose period has
    // been pushed past the staleness threshold says so - otherwise "silent" reads as a failure.
    const per = dcNodeParams[i].statusPeriodMs;
    const perNote = per !== DC_NS_PERIOD_MS ? ` <span class="dc-chip warn">${per} ms</span>` : '';
    const state = rebooting ? '<span class="dc-chip warn">restarting</span>'
      : killed ? '<span class="dc-chip warn">commanded off</span>'
      : '<span class="dc-chip off">on bus</span>';
    return {
      style: 'cursor:pointer', data: { dcFail: i },
      title: `Click to take this node off the bus (contract node_fail bit ${i})`,
      cells: [
        { cls: 'dc-node', html: dcEscHtml(r.name) },
        r.id,
        health,
        upt + perNote,
        { cls: 'dc-ts', html: seen ? dcRelTs(seen) : '-' },
        state,
      ],
    };
  });

  // ── The services pane ───────────────────────────────────────────────────────
  // What the roster ANSWERED, kept apart from what it publishes: a service response is not a
  // heartbeat, and a node that answered a question five seconds ago may be off the bus now. So
  // this is a record of exchanges, timestamped, rather than a live view of anything.
  setHtml(slot.svcNote, dcSvcNote ? dcEscHtml(dcSvcNote) : 'A service is a question addressed to one node, and that node&#39;s answer addressed back - the only two-way traffic on this bus.');
  keyed(slot.info, {
    tableClass: 'dc-tbl',
    theadHtml: '<tr><th>Node</th><th>Name</th><th>SW / HW</th><th>Unique ID</th><th>Uptime</th><th>Health</th></tr>',
    emptyHtml: '<div class="dc-empty">No node has been asked who it is yet.<br>Pick a node in the bar above and press <b>Get node info</b> - the request is an EMPTY transfer, and the answer is the widest one on this bus.</div>',
  }, [...dcNodeInfo.entries()].sort((a, b) => a[0] - b[0]), ([node]) => node, ([node, v]) => ({ cells: [
    { cls: 'dc-node', html: node },
    { cls: 'dc-msg', html: dcEscHtml(v.nameText) },
    `${v.sw_major}.${v.sw_minor} / ${v.hw_major}.${v.hw_minor}`,
    { cls: 'dc-raw', html: dcEscHtml(v.uidHex) },
    `${v.uptime_sec} s`,
    `<span class="dc-chip ${v.health ? 'warn' : 'ok'}">${dcEscHtml(DC_HEALTH[v.health] || String(v.health))}</span>`,
  ] }));

  const params = [...dcNodeParamsSeen.entries()].sort((a, b) => a[0] - b[0])
    .flatMap(([node, list]) => list.map((p, k) => ({ node, p, k })));
  keyed(slot.param, {
    tableClass: 'dc-tbl',
    theadHtml: '<tr><th>Node</th><th>Parameter</th><th>Value</th><th>Default</th><th>Range</th></tr>',
    emptyHtml: '<div class="dc-empty">No parameters read yet. <b>Read parameters</b> walks them by index until a nameless answer says there are no more - there is no count to ask for.</div>',
  }, params, r => r.node + ':' + r.k, ({ node, p, k }) => ({ cells: [
    { cls: 'dc-node', html: k ? '' : node },
    { cls: 'dc-msg', html: dcEscHtml(p.name) },
    dcEscHtml(dcValueText(p.value)),
    { cls: 'dc-raw', html: dcEscHtml(dcValueText(p.def)) },
    { cls: 'dc-raw', html: `${dcEscHtml(dcValueText(p.min))} … ${dcEscHtml(dcValueText(p.max))}` },
  ] }));

  keyed(slot.alloc, {
    tableClass: 'dc-tbl',
    theadHtml: '<tr><th>Granted ID</th><th>Unique ID (16 bytes)</th></tr>',
  }, [...dcAllocTable.entries()], ([uid]) => uid, ([uid, id]) => ({ cells: [
    { cls: 'dc-node', html: id }, { cls: 'dc-raw', html: dcEscHtml(uid) },
  ] }));
  setHtml(slot.allocLog, dcAllocLog.length
    ? `<div class="dc-readout">${dcAllocLog.map(e => dcEscHtml(e.text)).join('<br>')}</div>`
    : '<div class="dc-empty">Nothing has asked for a node id yet.<br>The eight roster ids above are DECLARED - somebody decided the GNSS node is 20. <b>New node asks for an ID</b> plugs in a device that has only a 16-byte unique id, and it has to negotiate one over a bus whose addressing is built out of node ids.</div>');

  // ── The mode triple ─────────────────────────────────────────────────────────
  // THE PAIR IS THE POINT: a request and an actual mode that disagree is the reading, so the two
  // states must not look alike. Agreement is one plain chip; a disagreement grows an arrow and
  // turns the actual chip amber, and `failsafe` beside them says WHY - without it a LOITER that
  // dropped to ALT HOLD looks the same whether the receiver died or someone moved a switch.
  // Fixed rows, but keyed all the same: home_dist changes every tick in flight.
  let modeRows = [];
  if (dcFlight) {
    const req = dcEnumLabel('flight_mode', 'in', dcFlight.req);
    const act = dcEnumLabel('mode_actual', 'out', dcFlight.actual);
    const agree = dcFlight.req === dcFlight.actual;
    const modeCell = agree
      ? `<span class="dc-chip ok">${dcEscHtml(act)}</span>`
      : `<span class="dc-chip">${dcEscHtml(req)}</span> <b style="color:var(--amber)">&rarr;</b> <span class="dc-chip warn">${dcEscHtml(act)}</span>`;
    const fs = dcEnumLabel('failsafe', 'out', dcFlight.fs);
    modeRows = [
      [agree ? 'flight_mode' : 'flight_mode &rarr; mode_actual', modeCell + (agree ? '' : ' <span style="color:var(--text3)">the flight controller is not flying what was asked for</span>')],
      [{ span: 2, style: 'color:var(--text3)', html: 'The request is THIS BAR\'S selector - with the Carlito window\'s Up link off it is not being sent, and the craft is flying whatever its own Z key selected.' }],
      ['failsafe', `<span class="dc-chip ${dcFlight.fs ? 'warn' : 'off'}">${dcEscHtml(fs)}</span>`],
      ['home_dist', `${Number.isFinite(dcFlight.home) ? dcFlight.home.toFixed(1) + ' m' : '-'} <span style="color:var(--text3)">derived FC state - no DroneCAN message carries it</span>`],
    ];
  }
  keyed(slot.mode, {
    tableClass: 'dc-tbl',
    emptyHtml: '<div class="dc-empty">No flight mode yet - it arrives with the drone\'s telemetry.</div>',
  }, modeRows, (r, i) => i, cells => ({ cells }));

  keyed(slot.nodes, {
    tableClass: 'dc-tbl',
    theadHtml: '<tr><th>Node</th><th>Messages</th><th>Last seen</th></tr>',
    emptyHtml: '<div class="dc-empty">No DroneCAN nodes seen yet.</div>',
  }, [...dcNodes.entries()].sort((a, b) => a[0] - b[0]), ([node]) => node, ([node, n]) => ({ cells: [
    { cls: 'dc-node', html: node },
    { cls: 'dc-msg', html: dcEscHtml([...n.msgs].join(', ')) },
    { cls: 'dc-ts', html: dcRelTs(n.lastSeen) },
  ] }));

  // Arming, and the pre-arm readout that is the whole reason BLOCKED does not go on the wire.
  // A set prearm_fail bit is a FAILED check (0 = everything passes), and the seven names are
  // the contract's own, frozen in the same way `status` is - a new check appends at bit 7.
  // prearm_fail PUBLISHES 0 WHILE ARMED BY DESIGN, because a flying craft deflects its stick
  // and leans past ten degrees constantly and live bits would light STICK and ATTITUDE through
  // every manoeuvre. So "all checks pass" while airborne is the correct reading, not a decode
  // that has failed, and the readout says which of the two it is looking at.
  // Keyed like the mode rows: prearm_fail bits toggle while the sticks move.
  let armRows = [];
  if (dcArm) {
    const state = DC_ARM_STATE[dcArm.state] || 'DISARMED';
    const cls = dcArm.state === 2 ? 'ok' : dcArm.state === 1 ? 'warn' : 'off';
    const bits = [];
    for (let i = 0; i < 16; i++) {
      if (!((dcArm.fail >> i) & 1)) continue;
      bits.push(DC_PREARM_BITS[i] || ('bit ' + i));
    }
    const checks = bits.length
      ? bits.map(b => `<span class="dc-chip warn">${dcEscHtml(b)}</span>`).join(' ')
      : `<span class="dc-chip ok">all checks pass</span>${dcArm.armed ? ' <span style="color:var(--text3)">(armed - the FC stops running pre-arm checks, so 0 is expected here)</span>' : ''}`;
    armRows = [
      ['ArmingStatus on the wire', { cls: 'dc-msg', html: dcArm.armed ? 'FULLY_ARMED' : 'DISARMED' }],
      ['arming_state (game)', `<span class="dc-chip ${cls}">${state}</span>${dcArm.state === 1 ? ' <span style="color:var(--text3)">the FC was asked to arm and refused - ArmingStatus has no field for this</span>' : ''}`],
      [`prearm_fail ${dcH(dcArm.fail, 4)}`, checks],
    ];
  }
  keyed(slot.arm, {
    tableClass: 'dc-tbl',
    emptyHtml: '<div class="dc-empty">No arming state yet - it arrives with the drone\'s telemetry.</div>',
  }, armRows, (r, i) => i, cells => ({ cells }));

  const txState = !dcCfg.txEnabled
    ? '<span class="dc-chip off">TX off</span>'
    : dcLastTx && (Date.now() - dcLastTx) < 2000
      ? `<span class="dc-chip ok">publishing</span> ${dcTxCount} frames`
      : `<span class="dc-chip off">idle</span> ${dcTxCount} frames${dcLastTx ? ' · last ' + dcRelTs(dcLastTx) : ''}`;
  setHtml(slot.tx, `Publishing to the bus: ${txState}`);
  const quiet = dcPresent() ? 'none' : '';
  if (slot.presence.style.display !== quiet) slot.presence.style.display = quiet;

  // Transfer-level errors live on the log bar, next to the log they explain. `orphan` is not a
  // fault - it counts transfers we joined mid-flight, which is normal right after connecting.
  const errEl = document.getElementById('dc-errs');
  if (errEl) {
    const e = dcRx.err;
    const part = (label, v) => v ? `<b>${label} ${v}</b>` : `${label} ${v}`;
    setHtml(errEl, `${part('CRC', e.crc)} · ${part('toggle', e.toggle)} · ${part('transfer-id', e.tid)} · ${part('oversize', e.oversize)} · joined mid-transfer ${e.orphan}`);
  }
}

// ── Stacked log tab (render loop + transfer-log table via the shared factory) ──
// One row per REASSEMBLED transfer, not per CAN frame - the frame count is a column.
dcTab = window.makeStackedLogTab({
  wrapId: 'dronecanWrap', logElId: 'dc-log',
  tableClass: 'dc-tbl', logMax: DC_LOG_MAX,
  theadHtml: '<tr><th>Time</th><th>CAN ID</th><th>Node</th><th>Message</th><th>Frm</th><th>CRC</th><th>Payload</th><th>Decoded</th></tr>',
  emptyHtml: '<div class="dc-empty">No DroneCAN transfers yet.<br>' +
    'A 29-bit id splits into priority / message type id / source node; multi-frame transfers are reassembled here and their CRC checked.<br>' +
    'Press <b>Demo</b> with this tab open for a simulated quad, or fly the drone in the Carlito window.</div>',
  renderTop: dcRenderTop,
  row: (e) => {
    const cnt = e.count && e.count > 1 ? ` <span style="color:var(--text3)">×${e.count}</span>` : '';
    const crc = e.crcOk === null ? '<span class="dc-chip off">n/a</span>'
      : e.crcOk ? '<span class="dc-chip ok">ok</span>' : '<span class="dc-chip warn">FAIL</span>';
    const raw = e.data.length ? dcHexBytes(e.data.slice(0, 14)) + (e.data.length > 14 ? '…' : '') : '-';
    return { cls: e.bad ? 'dc-bad' : '', data: { seecanTs: e.ts }, cells: [
      { cls: 'dc-ts', lead: '<a href="#" data-seecan="" title="See this frame in the Traffic Dump" class="dc-seecan">⊞</a>', html: dcRelTs(e.ts) },
      { cls: 'dc-id', html: dcH(e.id, 8) },
      { cls: 'dc-node', html: e.node },
      { cls: 'dc-msg', html: dcEscHtml(e.name) },
      e.frames,
      crc,
      { cls: 'dc-raw', html: raw },
      { cls: 'dc-dec', html: `${dcEscHtml(e.summary)}${cnt}` },
    ] };
  },
});

// ── Self-test ─────────────────────────────────────────────────────────────────
// Run from the console: window.dronecanSelfTest(). Covers the three things that are easy to
// get backwards and impossible to eyeball - DSDL bit order, the tail byte / framing, and the
// transfer CRC round-trip.
//
// HERMETIC: the checks drive the live packer, the uplink decoder and the allocator, so every piece
// of module state they read or write is snapshotted first and put back in a `finally` - the result
// must not depend on what traffic ran before, and the run must leave nothing behind (a spent
// command latch, a reset uptime, a test sample in the power window).
function dronecanSelfTest() {
  const arr = (a) => a.slice(), map = (m) => new Map(m);
  const s = {
    tid: map(dcTidCounters), escErr: arr(dcEscErrCount), escPrev: dcEscFaultPrev, t0: dcT0,
    pwr: arr(dcPwrWin), arm: dcArm, flight: dcFlight, upAt: arr(dcNodeUpAt), nsAt: arr(dcNsLastAt),
    reboot: arr(dcRebootAt), periods: dcNodeParams.map(p => p.statusPeriodMs), pending: dcCmdPending, linkUp: dcLinkUp,
    busCmd: Object.assign({}, dcBusCmd),
    alloc: map(dcAllocTable), ctl: Object.assign({}, dcCtl), upAsm: map(dcUpRx.asm),
    upErr: Object.assign({}, dcUpRx.err), nsHeard: dcNsHeardAt, fcNode: dcCfg.fcNode,
  };
  const put = (a, v) => { a.length = 0; a.push(...v); };
  const putMap = (m, v) => { m.clear(); for (const [k, x] of v) m.set(k, x); };
  // The checks assume a quiet airframe: no node mid-restart, the default period and FC id, and an
  // empty allocation table (a granted id would move dcAllocFindFree's answers).
  dcRebootAt.length = 0;
  dcNodeParams.forEach(p => { p.statusPeriodMs = DC_NS_PERIOD_MS; });
  dcAllocTable.clear();
  dcCfg.fcNode = 1;
  // ...and no command latched off the bus, so section 9's link-up edge re-emits all of them.
  dcBusCmd = { led: undefined, hook: undefined, gimbal: undefined };
  try {
    return dcSelfTestChecks();
  } finally {
    putMap(dcTidCounters, s.tid); put(dcEscErrCount, s.escErr); dcEscFaultPrev = s.escPrev; dcT0 = s.t0;
    put(dcPwrWin, s.pwr); dcArm = s.arm; dcFlight = s.flight; put(dcNodeUpAt, s.upAt); put(dcNsLastAt, s.nsAt);
    put(dcRebootAt, s.reboot); dcNodeParams.forEach((p, i) => { p.statusPeriodMs = s.periods[i]; });
    dcCmdPending = s.pending; dcLinkUp = s.linkUp; dcBusCmd = s.busCmd; putMap(dcAllocTable, s.alloc); Object.assign(dcCtl, s.ctl);
    putMap(dcUpRx.asm, s.upAsm); Object.assign(dcUpRx.err, s.upErr); dcNsHeardAt = s.nsHeard;
    dcCfg.fcNode = s.fcNode;
    // The bus-command checks pushed test values into the tab if it is on screen. Redraw it from the
    // RESTORED state - after dcCfg too - or the next widget touch reads the test's values back out
    // of the inputs (the FC node id among them) and saves them.
    const wrap = document.getElementById('dronecanWrap');
    if (wrap && wrap.style.display !== 'none') dronecanOnShow();
  }
}
function dcSelfTestChecks() {
  const failures = [];
  const eq = (what, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) failures.push(`${what}: got ${g}, want ${w}`);
  };

  // 1. Bit order. health=2 (uint2 at bit offset 32) must land in the TOP two bits of byte 4,
  //    and the u16 vendor code must come out little-endian.
  eq('NodeStatus bit order',
    dcEncode(DC_MSGS[341], { uptime_sec: 1, health: 2, mode: 0, sub_mode: 0, vendor_specific_status_code: 0x1234 }),
    [0x01, 0x00, 0x00, 0x00, 0x80, 0x34, 0x12]);
  eq('NodeStatus is single-frame',
    dcTransfer(DC_MSGS[341], 1, dcEncode(DC_MSGS[341], { uptime_sec: 0, health: 0, mode: 0, sub_mode: 0, vendor_specific_status_code: 0 }), 3)
      .map(f => f.data[f.data.length - 1]),
    [0xC3]);   // SOT|EOT, toggle 0, tid 3

  // 2. float16.
  eq('f16 1.0', dcFloat16(1), 0x3C00);
  eq('f16 -2.0', dcFloat16(-2), 0xC000);
  eq('f16 NaN for absent', dcFloat16(undefined), 0x7E00);
  eq('f16 round-trip 14.8', Math.round(dcFloat16Decode(dcFloat16(14.8)) * 100) / 100, 14.8);

  // 3. esc.Status: 110 bits -> 14 bytes -> 16 with the CRC -> 3 frames of 7/7/2 (+tail).
  const vals = { error_count: 7, voltage: 14.8, current: 15.5, temperature: 303.15, rpm: -6543, power_rating_pct: 19, esc_index: 3 };
  const payload = dcEncode(DC_MSGS[1034], vals);
  eq('esc.Status payload length', payload.length, 14);
  const frames = dcTransfer(DC_MSGS[1034], 14, payload, 5);
  eq('esc.Status frame dlcs', frames.map(f => f.data.length), [8, 8, 3]);
  eq('esc.Status tails', frames.map(f => f.data[f.data.length - 1]), [0x85, 0x25, 0x45]);
  //   SOT tog0 tid5 = 0x85, mid tog1 tid5 = 0x25, EOT tog0 tid5 = 0x45
  eq('esc.Status can id', frames[0].id, dcMsgId(20, 1034, 14));
  eq('esc.Status id fields', dcParseMsgId(frames[0].id), { priority: 20, dataTypeId: 1034, service: 0, srcNode: 14 });

  // 4. Full round-trip through the reassembler (CRC included).
  const st = dcNewRxState();
  let done = null;
  for (const f of frames) done = dcFeedFrame(st, f.id, f.data) || done;
  if (!done) failures.push('esc.Status round-trip: transfer never completed');
  else {
    eq('esc.Status round-trip crc', done.crcOk, true);
    eq('esc.Status round-trip frames', done.frames, 3);
    const back = dcDecode(DC_MSGS[1034], done.payload);
    eq('esc.Status round-trip rpm', back.rpm, -6543);
    eq('esc.Status round-trip esc_index', back.esc_index, 3);
    eq('esc.Status round-trip error_count', back.error_count, 7);
    eq('esc.Status round-trip power_rating_pct', back.power_rating_pct, 19);
    eq('esc.Status round-trip current', Math.round(back.current * 10) / 10, 15.5);
  }

  // 5. A corrupted payload byte must be caught by the CRC.
  const bad = frames.map(f => ({ id: f.id, data: f.data.slice() }));
  bad[1].data[0] ^= 0xFF;
  const st2 = dcNewRxState();
  let done2 = null;
  for (const f of bad) done2 = dcFeedFrame(st2, f.id, f.data) || done2;
  eq('corrupt payload fails CRC', done2 && done2.crcOk, false);

  // 6. The five messages phase 3 added, one encode -> reassemble -> decode round trip each.
  //    The pinned payload vectors are not this module marking its own homework: each one was
  //    generated by pydronecan from the same field values and compared byte for byte, so they
  //    pin the DSDL layout (void padding, inlined nested types, array length prefixes, the
  //    tail array optimization) against an independent implementation. The ONE deliberate
  //    difference is the float16 NaN pattern - pydronecan writes 0x7FFF, this module writes
  //    0x7E00, and both are quiet NaNs.
  const roundTrip = (label, m, vals, node, wantPayload, wantDlcs) => {
    const p = dcEncode(m, vals);
    if (wantPayload) eq(label + ' payload', p, wantPayload);   // null = framing/decode only
    const fr = dcTransfer(m, node, p, 9);
    eq(label + ' frame dlcs', fr.map(f => f.data.length), wantDlcs);
    const s = dcNewRxState();
    let d = null;
    for (const f of fr) d = dcFeedFrame(s, f.id, f.data) || d;
    if (!d) { failures.push(label + ' round-trip: transfer never completed'); return null; }
    if (fr.length > 1) eq(label + ' round-trip crc', d.crcOk, true);
    eq(label + ' round-trip srcNode', d.srcNode, node);
    eq(label + ' round-trip dataTypeId', d.dataTypeId, m.id);
    return dcDecode(m, d.payload);
  };

  const bi = roundTrip('BatteryInfo', DC_MSGS[1092], {
    temperature: 303.15, voltage: 14.8, current: 61, average_power_10sec: 902.8,
    remaining_capacity_wh: NaN, full_charge_capacity_wh: NaN, hours_to_full_charge: NaN,
    status_flags: DC_BATT_IN_USE, state_of_health_pct: DC_SOH_UNKNOWN,
    state_of_charge_pct: 77, state_of_charge_pct_stdev: 0,
    battery_id: 0, model_instance_id: 0,
  }, DC_ROSTER[DC_I_POWER].id, [
    0xBD, 0x5C, 0x66, 0x4B, 0xA0, 0x53, 0x0E, 0x63, 0x00, 0x7E, 0x00, 0x7E,
    0x00, 0x7E, 0x01, 0x1F, 0xE6, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  ], [8, 8, 8, 5]);
  if (bi) {
    eq('BatteryInfo soc', bi.state_of_charge_pct, 77);
    eq('BatteryInfo health unknown', bi.state_of_health_pct, DC_SOH_UNKNOWN);
    eq('BatteryInfo volts', Math.round(bi.voltage * 100) / 100, 14.8);
    eq('BatteryInfo capacity stays unknown', Number.isNaN(bi.full_charge_capacity_wh), true);
  }

  const fx = roundTrip('Fix2', DC_MSGS[1063], {
    timestamp_usec: 0, gnss_timestamp_usec: 0, gnss_time_standard: 0, void13: 0,
    num_leap_seconds: 0,
    longitude_deg_1e8: 235220000, latitude_deg_1e8: 4885660000,
    height_ellipsoid_mm: 123456, height_msl_mm: 123456,
    ned_velocity_n: DC_F32_NAN, ned_velocity_e: DC_F32_NAN, ned_velocity_d: DC_F32_NAN,
    sats_used: 11, status: 3, mode: 0, sub_mode: 0, covariance_len: 0, pdop: 0.9,
  }, DC_ROSTER[DC_I_GNSS].id, [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x20, 0x2C, 0x05, 0x0E, 0x03, 0x02, 0x09, 0xA9, 0x18,
    0x50, 0x38, 0x80, 0x42, 0x07, 0x10, 0x08, 0x00, 0x00, 0xC0, 0x7F, 0x00, 0x00,
    0xC0, 0x7F, 0x00, 0x00, 0xC0, 0x7F, 0x2F, 0x00, 0x00, 0x33, 0x3B,
  ], [8, 8, 8, 8, 8, 8, 8, 4]);
  if (fx) {
    // The signed 37-bit pair is the one field width nothing else in the module exercises.
    eq('Fix2 latitude', fx.latitude_deg_1e8, 4885660000);
    eq('Fix2 longitude', fx.longitude_deg_1e8, 235220000);
    eq('Fix2 sats/status', [fx.sats_used, fx.status], [11, 3]);
    eq('Fix2 ned velocity is NaN', Number.isNaN(dcF32FromBits(fx.ned_velocity_d)), true);
  }
  // A southern/western position must come back negative, not as a huge unsigned number.
  const fxNeg = roundTrip('Fix2 negative', DC_MSGS[1063], {
    timestamp_usec: 0, gnss_timestamp_usec: 0, gnss_time_standard: 0, void13: 0,
    num_leap_seconds: 0,
    longitude_deg_1e8: -17750000000, latitude_deg_1e8: -3385660000,
    height_ellipsoid_mm: -1234, height_msl_mm: -1234,
    ned_velocity_n: DC_F32_NAN, ned_velocity_e: DC_F32_NAN, ned_velocity_d: DC_F32_NAN,
    sats_used: 0, status: 0, mode: 0, sub_mode: 0, covariance_len: 0, pdop: 10,
  }, DC_ROSTER[DC_I_GNSS].id, null, [8, 8, 8, 8, 8, 8, 8, 4]);
  if (fxNeg) {
    eq('Fix2 negative lon', fxNeg.longitude_deg_1e8, -17750000000);
    eq('Fix2 negative lat', fxNeg.latitude_deg_1e8, -3385660000);
    eq('Fix2 negative msl', fxNeg.height_msl_mm, -1234);
  }

  const rm = roundTrip('range.Measurement', DC_MSGS[1050], {
    timestamp_usec: 0, sensor_id: 0,
    beam_roll: 0, beam_pitch: 0, beam_yaw: 0, orientation_defined: 0,
    field_of_view: 0, sensor_type: 2, reading_type: 1, range: 12.5,
  }, DC_ROSTER[DC_I_RANGE].id, [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x11, 0x40, 0x4A,
  ], [8, 8, 4]);
  if (rm) eq('range valid reading', [rm.reading_type, rm.range], [1, 12.5]);

  const so = roundTrip('ahrs.Solution', DC_MSGS[1000], {
    timestamp_usec: 0,
    orientation_x: -0.10438521064158734, orientation_y: 0.05204925439864352,
    orientation_z: 0.005470597079718074, orientation_w: 0.9931589376748557,
    void4_a: 0, orientation_covariance_len: 0,
    angular_velocity_x: 0.1, angular_velocity_y: -0.2, angular_velocity_z: -0.3,
    void4_b: 0, angular_velocity_covariance_len: 0,
    linear_acceleration_x: 1.5, linear_acceleration_y: -0.5, linear_acceleration_z: -0.3,
  }, DC_ROSTER[DC_I_AHRS].id, [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xAE, 0xAE, 0xAA, 0x2A, 0x9A, 0x1D,
    0xF2, 0x3B, 0x00, 0x66, 0x2E, 0x66, 0xB2, 0xCD, 0xB4, 0x00, 0x00, 0x3E, 0x00,
    0xB8, 0xCD, 0xB4,
  ], [8, 8, 8, 8, 4]);
  if (so) eq('Solution quaternion is unit', Math.round(1000 * (
    so.orientation_x * so.orientation_x + so.orientation_y * so.orientation_y +
    so.orientation_z * so.orientation_z + so.orientation_w * so.orientation_w)) / 1000, 1);

  // The quaternion helper against the same pitch/roll, to three decimals.
  eq('quat from pitch 6 / roll -12',
    dcQuatFromPitchRoll(6, -12).map(x => Math.round(x * 1000) / 1000),
    [-0.104, 0.052, 0.005, 0.993]);
  eq('quat level is identity', dcQuatFromPitchRoll(0, 0), [0, 0, 0, 1]);

  const am = roundTrip('ArmingStatus', DC_MSGS[1100], { status: 255 }, dcCfg.fcNode, [0xFF], [2]);
  if (am) eq('ArmingStatus armed', am.status, 255);

  // The two indication commands. The RGB565 vector is the one thing here a hand-packed uint16
  // would get backwards: red 1 / green 2 / blue 3 is 00001 000010 00011, i.e. 0x0843 MSB-first,
  // and a little-endian uint16 of the same colour would come out 0x4308.
  const lc = roundTrip('LightsCommand', DC_MSGS[1081],
    { light_id: 0, red: 1, green: 2, blue: 3 }, dcCfg.fcNode, [0x00, 0x08, 0x43], [4]);
  if (lc) eq('LightsCommand colour channels', [lc.light_id, lc.red, lc.green, lc.blue], [0, 1, 2, 3]);
  const bc = roundTrip('BeepCommand', DC_MSGS[1080],
    { frequency: DC_BEEP_HZ, duration: 0 }, dcCfg.fcNode, [0xB0, 0x68, 0x00, 0x00], [5]);
  if (bc) eq('BeepCommand frequency', bc.frequency, DC_BEEP_HZ);
  // ── The seven messages contract v30 added ───────────────────────────────────
  // Same rule as the block above: every pinned vector was generated by pydronecan from these
  // exact field values and compared byte for byte, so they pin the DSDL layout against an
  // independent implementation rather than against this module's own encoder. The signatures
  // were taken the same way (the method re-derives the older ones identically), which matters
  // since a wrong signature is invisible at runtime on a single-frame
  // transfer and produces frames this decoder accepts on a multi-frame one.
  const hc = roundTrip('hardpoint.Command', DC_MSGS[1070],
    { hardpoint_id: 0, command: DC_HOOK_HOLD }, dcCfg.fcNode, [0x00, 0x01, 0x00], [4]);
  if (hc) eq('hardpoint.Command holds', hc.command, DC_HOOK_HOLD);
  // 19.6 N is 2 kg at g - the shipped crate, so this vector is a real load rather than a
  // round number. float16 rounds it to 19.594, which is what the decode comes back as.
  const hs = roundTrip('hardpoint.Status', DC_MSGS[1071],
    { hardpoint_id: 0, payload_weight: 19.6, payload_weight_variance: 0, status: DC_HOOK_HOLD },
    dcCfg.fcNode, [0x00, 0xE6, 0x4C, 0x00, 0x00, 0x01, 0x00], [8]);
  if (hs) {
    eq('hardpoint.Status latched', hs.status, DC_HOOK_HOLD);
    eq('hardpoint.Status weight is Newton', Math.abs(hs.payload_weight - 19.6) < 0.02, true);
  }
  // The IDENTITY quaternion, deliberately: a level, centred mount is the one case where a sign
  // error in dcQuatFromPitchYaw is invisible, so the pinned bytes cover the LAYOUT and the two
  // sign checks below cover the conversion.
  const gac = roundTrip('gimbal.AngularCommand', DC_MSGS[1040],
    { gimbal_id: 0, mode: 2, quaternion_x: 0, quaternion_y: 0, quaternion_z: 0, quaternion_w: 1 },
    dcCfg.fcNode, [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3C], [8, 6]);
  if (gac) eq('gimbal.AngularCommand is body frame', gac.mode, 2);
  const gst = roundTrip('gimbal.Status', DC_MSGS[1044],
    { gimbal_id: 0, mode: 2, orientation_x: 0, orientation_y: 0, orientation_z: 0, orientation_w: 1 },
    dcCfg.fcNode, [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3C], [8, 6]);
  if (gst) eq('gimbal.Status is body frame', gst.mode, 2);
  // THE TWO SIGNS. DSDL body frame is NED (z DOWN), the contract's angles are the game's
  // (+ pitch = up, + yaw = right), so a mount looking DOWN must produce a NEGATIVE-w-relative
  // y component and a pan to the RIGHT a positive z. Getting either backwards produces a
  // perfectly valid quaternion pointing the wrong way, which nothing else here would catch.
  eq('gimbal quat level is identity', dcQuatFromPitchYaw(0, 0), [0, 0, 0, 1]);
  eq('gimbal quat pitched down has -y', dcQuatFromPitchYaw(-90, 0)[1] < 0, true);
  eq('gimbal quat yawed right has +z', dcQuatFromPitchYaw(0, 90)[2] > 0, true);
  // ArrayCommand's tail array optimization: TWO commands back to back with no length prefix,
  // which is what makes the payload exactly 8 bytes rather than 9. A length prefix would put a
  // byte at the front and every field after it would decode one nibble out.
  const arr = roundTrip('actuator.ArrayCommand', DC_MSGS[1010],
    { actuator_id_0: 0, command_type_0: 1, command_value_0: 0.5,
      actuator_id_1: 1, command_type_1: 1, command_value_1: -0.25 },
    dcCfg.fcNode, [0x00, 0x01, 0x00, 0x38, 0x01, 0x01, 0x00, 0xB4], [8, 4]);
  if (arr) eq('ArrayCommand carries two POSITION axes',
    [arr.actuator_id_0, arr.command_type_0, arr.command_value_0,
     arr.actuator_id_1, arr.command_type_1, arr.command_value_1], [0, 1, 0.5, 1, 1, -0.25]);
  // A REAL float32, and this vector is the reason it has to be: 101325 Pa in float16 is
  // Infinity, so an f16 field here would put an unusable pressure on the wire and the decode
  // would still look plausible.
  const sp = roundTrip('StaticPressure', DC_MSGS[1028],
    { static_pressure: dcF32ToBits(101325), static_pressure_variance: 0 },
    dcCfg.fcNode, [0x80, 0xE6, 0xC5, 0x47, 0x00, 0x00], [7]);
  // Decoded back THROUGH the pattern, which is the half of `f32bits` a caller gets wrong: the
  // field holds a bit pattern both ways, and comparing it to 101325 as a number would pass only
  // for the mistake this check exists to catch.
  if (sp) eq('StaticPressure is sea-level standard', dcF32FromBits(sp.static_pressure), 101325);
  // Finite temperatures rather than the NaNs the live packer sends, for the reason the block
  // above gives: pydronecan writes float16 NaN as 0x7FFF and this module writes 0x7E00, so a
  // NaN in a pinned vector would compare a real difference that is not a defect.
  const rad = roundTrip('RawAirData', DC_MSGS[1027],
    { flags: 0, static_pressure: dcF32ToBits(101325), differential_pressure: dcF32ToBits(0),
      static_pressure_sensor_temperature: 288.25,
      differential_pressure_sensor_temperature: 288.25,
      static_air_temperature: 288.25, pitot_temperature: 288.25 },
    dcCfg.fcNode,
    [0x00, 0x80, 0xE6, 0xC5, 0x47, 0x00, 0x00, 0x00, 0x00,
     0x81, 0x5C, 0x81, 0x5C, 0x81, 0x5C, 0x81, 0x5C], [8, 8, 6]);
  if (rad) eq('RawAirData static air temperature is Kelvin',
    Math.abs(rad.static_air_temperature - 288.25) < 0.1, true);

  // The picker's own round trip. 24-bit in, 5/6/5 out: #FF8000 quantises, and the check is that
  // it quantises to the RIGHT bits rather than that it comes back unchanged.
  eq('picker -> RGB565', dcRgb565FromHex('#FF8000'), (31 << 11) | (32 << 5) | 0);
  eq('RGB565 -> picker', dcHexFromRgb565((31 << 11) | (32 << 5) | 0), '#ff8200');
  eq('black is off', dcRgb565FromHex('#000000'), 0);

  // The roster against the contract's node_health count - the assertion that makes a grown
  // game-side roster fail here rather than address the wrong node.
  eq('roster length matches contract node_health count',
    DC_ROSTER.length, dcContractNum('node_health', 'count', DC_ROSTER.length));

  // 7. The conversions, end to end through dcBuildFrames. These are the ones a wrong sign or
  //    a zeroed sentinel would hide: nothing about the frames would look unusual. Unlike
  //    every check above, this one drives the LIVE packer (dronecanSelfTest puts its state back).
  const pick = (frames, dtid) => {
    const s = dcNewRxState();
    let d = null;
    for (const f of frames) {
      const r = dcFeedFrame(s, f.id, f.data);
      if (r && r.dataTypeId === dtid) d = r;
    }
    return d ? dcDecode(DC_MSGS[dtid], d.payload) : null;
  };
  const built = dcBuildFrames({
    esc_rpm: [6500, 6500, 6500, 6500], esc_current: [15, 15, 15, 15],
    esc_temp: [30, 30, 30, 30], esc_fault: 0, battery: 14.8, armed: false,
    pack_current: 61.5, soc: 77, pack_temp: 30,
    lat: 48.8566, lon: 2.3522, altitude: 123.456, sats: 11, fix_type: 3, hdop: 0.9,
    agl: -1,
    pitch: 6, roll: -12, roll_rate: 0.1, pitch_rate: -0.2, yaw: 0.3,
    accLong: 1.5, accLat: -0.5, acc_vert: 0.3,
    arming_state: 1, prearm_fail: 0x01,
  });
  const bSol = pick(built, 1000), bRange = pick(built, 1050), bArm = pick(built, 1100);
  if (bSol) {
    // NED: roll_rate and pitch_rate pass straight through, yaw NEGATES (the game reads it
    // about its own UP axis, DSDL's z points DOWN), and acc_vert negates for the same reason.
    eq('Solution rates -> NED', [bSol.angular_velocity_x, bSol.angular_velocity_y, bSol.angular_velocity_z]
      .map(x => Math.round(x * 1000) / 1000), [0.1, -0.2, -0.3]);
    eq('Solution accel -> NED', [bSol.linear_acceleration_x, bSol.linear_acceleration_y, bSol.linear_acceleration_z]
      .map(x => Math.round(x * 100) / 100), [1.5, -0.5, -0.3]);
  }
  if (bRange) {
    // agl = -1 must become "no reading", and the range field must NOT become 0 - a landing
    // detector acting on a zero is exactly the failure the sentinel exists to prevent.
    eq('agl -1 -> READING_TYPE_UNDEFINED', bRange.reading_type, 0);
    eq('agl -1 -> range NaN, never 0', Number.isNaN(bRange.range), true);
  }
  // BLOCKED is not on the wire: the game asked, the FC refused, and ArmingStatus still says
  // DISARMED because it has no third state to say it with.
  if (bArm) eq('BLOCKED still encodes DISARMED', bArm.status, 0);
  eq('BLOCKED and its failed check reach the tab', dcArm && [dcArm.state, dcArm.fail], [1, 0x01]);

  // 8. PRESENCE. The phase's whole point, and the one behaviour that looks completely normal on
  //    the wire when it is wrong - four healthy ESCs from an aircraft flying on three.
  const escIndices = (frames) => {
    const st3 = dcNewRxState();
    const seen = [];
    for (const f of frames) {
      const r = dcFeedFrame(st3, f.id, f.data);
      if (r && r.dataTypeId === 1034) seen.push(dcDecode(DC_MSGS[1034], r.payload).esc_index);
    }
    return seen.sort();
  };
  const nodeIds = (frames) => {
    const st4 = dcNewRxState();
    const seen = [];
    for (const f of frames) {
      const r = dcFeedFrame(st4, f.id, f.data);
      if (r && r.dataTypeId === 341) seen.push(r.srcNode);
    }
    return seen.sort((a, b) => a - b);
  };
  const flying = {
    esc_rpm: [6500, 6500, 6500, 6500], esc_current: [15, 15, 15, 15],
    esc_temp: [30, 30, 30, 30], esc_fault: 0, battery: 14.8, armed: true,
    pack_current: 61.5, soc: 77, pack_temp: 30,
    lat: 48.8566, lon: 2.3522, altitude: 40, sats: 11, fix_type: 3, hdop: 0.9, agl: 32,
    pitch: 0, roll: 0, roll_rate: 0, pitch_rate: 0, yaw: 0,
    accLong: 0, accLat: 0, acc_vert: 0, arming_state: 2, prearm_fail: 0,
  };
  // A node_online with ESC2 (roster index 1) clear: no esc.Status for esc_index 1, and no
  // heartbeat from node 12 - the node is SILENT, which is the only way a bus says "gone".
  dcNsLastAt.length = 0;
  eq('offline ESC2 publishes no esc.Status',
    escIndices(dcBuildFrames(Object.assign({}, flying, { node_online: DC_ALL_ONLINE & ~(1 << 1) }))),
    [0, 2, 3]);
  dcNsLastAt.length = 0;
  eq('offline ESC2 sends no NodeStatus',
    nodeIds(dcBuildFrames(Object.assign({}, flying, { node_online: DC_ALL_ONLINE & ~(1 << 1) }))),
    [11, 13, 14, 20, 21, 22, 23]);
  // An ABSENT node_online is every node online, not every node silent: an older game build, and
  // any telemetry dict predating the signal, must not take the whole bus off the air.
  dcNsLastAt.length = 0;
  eq('absent node_online means all online', escIndices(dcBuildFrames(flying)), [0, 1, 2, 3]);
  dcNsLastAt.length = 0;
  eq('absent node_online heartbeats the whole roster',
    nodeIds(dcBuildFrames(flying)), DC_ROSTER.map(r => r.id));
  // health comes off the game's array verbatim rather than being re-derived from esc_fault.
  dcNsLastAt.length = 0;
  const hb = dcBuildFrames(Object.assign({}, flying, { node_health: [0, 1, 0, 0, 0, 0, 0, 3] }));
  const stH = dcNewRxState();
  const healths = {};
  for (const f of hb) {
    const r = dcFeedFrame(stH, f.id, f.data);
    if (r && r.dataTypeId === 341) healths[r.srcNode] = dcDecode(DC_MSGS[341], r.payload).health;
  }
  eq('per-node health is published verbatim', [healths[11], healths[12], healths[23]], [0, 1, 3]);

  // 9. The commands are APERIODIC: a tick with nothing latched carries neither of them.
  dcCmdPending = null;
  eq('no indication command on a quiet tick', dcFlushCommands(), []);
  dcCmdPending = { led: (1 << 11) | (2 << 5) | 3, beep: true };
  const cmd = dcFlushCommands();
  eq('a change emits one LightsCommand and one BeepCommand',
    cmd.map(f => dcParseMsgId(f.id).dataTypeId).sort((a, b) => a - b), [1080, 1081]);
  eq('commands come from the FC, not a peripheral',
    cmd.every(f => dcParseMsgId(f.id).srcNode === (dcCfg.fcNode & 0x7F)), true);
  eq('the latch is spent', dcFlushCommands(), []);
  //    Decision 2: the packer's first drone tick after none (dcNoteLink) re-emits all four commands
  //    once - the gimbal as AngularCommand + ArrayCommand - and the tick after it carries none.
  //    Counted per TRANSFER (the tail byte's start-of-transfer bit), so a multi-frame one counts once.
  const cmdIds = (frames) => frames.filter(f => f.data[f.data.length - 1] & 0x80).map(f => dcParseMsgId(f.id))
    .filter(m => m.srcNode === (dcCfg.fcNode & 0x7F) && [1081, 1080, 1070, 1040, 1010].includes(m.dataTypeId))
    .map(m => m.dataTypeId).sort((a, b) => a - b);
  dcCmdPending = null;
  dcNoteLink({});   // not a drone: the link is down
  dcNoteLink(flying);
  eq('link-up re-emits every command once', cmdIds(dcBuildFrames(flying)), [1010, 1040, 1070, 1080, 1081]);
  dcNoteLink(flying);
  eq('...and only once', cmdIds(dcBuildFrames(flying)), []);
  //    The demo quad shares dcBuildFrames: a drone frame build is not a link-up, and neither is a
  //    car on the link beside it.
  dcNoteLink({});
  dcBuildFrames(flying);
  eq('dcBuildFrames alone neither sees nor clears the edge', [dcLinkUp, dcCmdPending], [false, null]);

  // ── 10. THE SERVICES ────────────────────────────────────────────────────────
  //     A different id layout, a different reassembly key and two new field kinds, none of
  //     which the nine broadcast messages exercised. Everything below is arithmetic that is
  //     impossible to eyeball and silently plausible when it is wrong.

  // 10a. The service id, and the fact that it is NOT a message id. The bit that decides is bit
  //      7, and a parser that read a service frame with dcParseMsgId would report a message
  //      type id built out of the service id and the destination - a number that looks fine.
  const svcIdA = dcSvcId(24, 1, true, 20, 127);
  eq('service id bits', svcIdA.toString(16).toUpperCase(), '180194FF');
  eq('service id round-trips', dcParseSvcId(svcIdA),
    { priority: 24, svcTypeId: 1, isRequest: true, destNode: 20, srcNode: 127 });
  eq('a service frame is not read as a message', dcParseAnyId(svcIdA).kind, 'svc');
  eq('a response clears the request bit', dcParseSvcId(dcSvcId(24, 1, false, 127, 20)).isRequest, false);
  //      ...and the reassembly key keeps two nodes answering two tools apart. Same service type,
  //      same source, different destination: four independent transfers, not one spliced one.
  eq('service transfers key on both ends',
    dcParseAnyId(dcSvcId(24, 1, false, 127, 20)).key !== dcParseAnyId(dcSvcId(24, 1, false, 126, 20)).key, true);

  // 10b. The anonymous id. Source node id 0, only the LOW TWO BITS of the message type id, and
  //      14 bits of discriminator - which is why an anonymous transfer identifies almost
  //      nothing and can only be used for a protocol both ends already agree on.
  const anonA = dcAnonId(24, 1, 0x2ABC);
  const anonP = dcParseAnonId(anonA);
  eq('anonymous keeps only the low 2 bits of the type id', anonP.msgTypeIdLow, 1);
  eq('anonymous discriminator round-trips', anonP.discriminator, 0x2ABC);
  eq('anonymous source node id is zero', anonA & 0x7F, 0);
  eq('an anonymous frame is read as anonymous', dcParseAnyId(anonA).kind, 'anon');

  // 10c. The two new field kinds. A fixed byte array is inlined; a TAIL array is literally the
  //      bytes that are left, which only works because everything ahead of it is byte-aligned -
  //      so that is asserted rather than assumed. A tail that started mid-byte would shift the
  //      node name by a bit and decode as garbage that still looks like a name.
  const gni = DC_SVCS[1].resp;
  eq('GetNodeInfo response is byte-aligned before its tail array', gni.bits % 8, 0);
  eq('a tail field is last', gni.fields[gni.fields.length - 1].tail, true);
  const gniVals = {
    uptime_sec: 4242, health: 1, mode: 0, sub_mode: 0, vendor_specific_status_code: 0,
    sw_major: 1, sw_minor: 0, sw_optional_field_flags: 0, sw_vcs_commit: 0,
    sw_image_crc_lo: 0, sw_image_crc_hi: 0, hw_major: 1, hw_minor: 0,
    unique_id: dcUniqueId(DC_I_GNSS), coa_len: 0, name: 'org.example.node',
  };
  const gniBytes = dcEncode(gni, gniVals);
  eq('GetNodeInfo response length is the fixed part plus the tail', gniBytes.length, (gni.bits >> 3) + 16);
  const gniBack = dcDecode(gni, gniBytes);
  eq('GetNodeInfo uptime round-trips', gniBack.uptime_sec, 4242);
  eq('GetNodeInfo health round-trips', gniBack.health, 1);
  eq('GetNodeInfo unique id round-trips', gniBack.unique_id, dcUniqueId(DC_I_GNSS));
  eq('GetNodeInfo name round-trips', dcAscii(gniBack.name), 'org.example.node');
  //      ...and it is a MULTI-frame transfer, so its CRC is seeded with the SERVICE's signature.
  //      A wrong signature here is invisible on the single-frame RestartNode and fatal on this.
  const gniFrames = dcSvcTransfer(DC_SVCS[1], false, 20, 127, gniBytes, 7);
  const stG = dcNewRxState();
  let gniDone = null;
  for (const f of gniFrames) gniDone = dcFeedFrame(stG, f.id, f.data) || gniDone;
  eq('GetNodeInfo response reassembles', gniDone && gniDone.crcOk, true);
  eq('GetNodeInfo response is nine frames', gniDone && gniDone.frames, 9);
  eq('the response carries the request transfer id', gniDone && gniDone.tid, 7);
  eq('the response is a response', gniDone && gniDone.isRequest, false);

  // 10d. THE 64-BIT WRAP. `20 + 2**64` is not exactly representable, so a modulo-based wrap
  //      would round it away and every parameter value, default and range would come back 0.
  //      Pinned at three widths, because 32 bits is fine either way and 64 is not.
  const w64 = dcBitWriter(64); w64.put(20, 64);
  eq('a small value survives a 64-bit field', dcBitReader(w64.bytes()).get(64), 20);
  const w32 = dcBitWriter(32); w32.put(4000, 32);
  eq('a small value survives a 32-bit field', dcBitReader(w32.bytes()).get(32), 4000);
  const wNeg = dcBitWriter(64); wNeg.put(-1, 64);
  eq("a negative still wraps to two's complement", dcBitReader(wNeg.bytes()).get(64, true), -1);

  // 10e. RestartNode's magic number, which the DSDL says must be checked. 0xACCE551B1E is a
  //      uint40, so it is neither a byte count nor a 32-bit value - both of which it would
  //      silently become if the field width were wrong.
  eq('the restart magic is 40 bits', DC_SVCS[5].req.bits, 40);
  const magicBytes = dcEncode(DC_SVCS[5].req, { magic_number: DC_RESTART_MAGIC });
  eq('the restart magic encodes little-endian', magicBytes.map(b => dcH(b)).join(' '), '0x1E 0x1B 0x55 0xCE 0xAC');
  eq('the restart magic round-trips', dcDecode(DC_SVCS[5].req, magicBytes).magic_number, DC_RESTART_MAGIC);

  // 10f. param.GetSet, the one message with no field table - a union's width depends on its tag.
  //      The void paddings are what keep every variant byte-aligned, so the name tail lands on a
  //      boundary; a missing void5 would shift the whole response by five bits.
  const gsReq = dcGetSetEncodeReq(3, dcValInt(4000), 'uavcan.node.status_period_ms');
  const gsReqBack = dcGetSetDecodeReq(gsReq);
  eq('GetSet request index round-trips', gsReqBack.index, 3);
  eq('GetSet request name round-trips', gsReqBack.name, 'uavcan.node.status_period_ms');
  eq('GetSet request value round-trips', [gsReqBack.value.kind, gsReqBack.value.v], [DC_VAL_INT, 4000]);
  const gsEmpty = dcGetSetDecodeReq(dcGetSetEncodeReq(0, dcValEmpty(), ''));
  eq('an EMPTY value is a get, not a set of zero', gsEmpty.value.kind, DC_VAL_EMPTY);
  const gsResp = dcGetSetDecodeResp(dcGetSetEncodeResp({
    value: dcValInt(1000), defaultValue: dcValInt(1000),
    maxValue: dcNumInt(10000), minValue: dcNumInt(100), name: 'uavcan.node.status_period_ms' }));
  eq('GetSet response value round-trips', gsResp.value.v, 1000);
  eq('GetSet response range round-trips', [gsResp.minValue.v, gsResp.maxValue.v], [100, 10000]);
  eq('GetSet response name round-trips', gsResp.name, 'uavcan.node.status_period_ms');
  //      An empty name AND an empty value is the DSDL's "no such parameter", which is the only
  //      thing that ends an index walk - there is no count to ask for.
  const gsNone = dcGetSetDecodeResp(dcGetSetEncodeResp({
    value: dcValEmpty(), defaultValue: dcValEmpty(),
    maxValue: { kind: DC_NUM_EMPTY }, minValue: { kind: DC_NUM_EMPTY }, name: '' }));
  eq('the end of the parameter list is an empty name and an empty value',
    [gsNone.name, gsNone.value.kind], ['', DC_VAL_EMPTY]);
  //      A float parameter takes a different amount of room from an integer one, which is the
  //      whole reason this message has no field table.
  eq("a union's width follows its tag",
    [dcValueBits(dcValEmpty()), dcValueBits(dcValBool(1)), dcValueBits(dcValReal(1.5)), dcValueBits(dcValInt(1))],
    [3, 11, 35, 67]);

  // 10g. Allocation. The DSDL's allocation algorithm hands an allocatee with NO preference the
  //      HIGHEST free id rather than the lowest, which is what keeps dynamically allocated nodes
  //      out of the way of declared ones - and 126/127 are skipped because they belong to tools.
  eq('no preference gets the highest free id', dcAllocFindFree(0), DC_ALLOC_MAX_ID);
  eq('the tool id is never handed out', dcAllocFindFree(127) <= DC_ALLOC_MAX_ID, true);
  eq('a preferred id that is free is granted', dcAllocFindFree(60), 60);
  // The four ESCs occupy 11-14, so a request preferring 11 walks up past all four to 15.
  eq('a preferred id that is taken searches upward', dcAllocFindFree(11), 15);
  //      The message: node_id is a uint7 in the TOP seven bits and first_part_of_unique_id is
  //      the bottom one, which is exactly the byte libcanard builds by hand as
  //      `(PREFERRED_NODE_ID << 1) | 1`. unique_id is a tail array, so a first-stage request is
  //      seven payload bytes and a grant is seventeen - the same message, two lengths.
  const allocFirst = dcEncode(DC_ALLOC, { node_id: 0, first_part_of_unique_id: 1, unique_id: [1, 2, 3, 4, 5, 6] });
  eq('a first-stage request is one byte plus six', allocFirst.length, 7);
  eq('node_id sits above the first-part bit', allocFirst[0], 0x01);
  eq('a preferred id shifts left by one', dcEncode(DC_ALLOC, { node_id: 42, first_part_of_unique_id: 1, unique_id: [] })[0], (42 << 1) | 1);
  const allocBack = dcDecode(DC_ALLOC, allocFirst);
  eq('the unique-id chunk round-trips', allocBack.unique_id, [1, 2, 3, 4, 5, 6]);
  //      ...and it is single-frame BY CONSTRUCTION. A multi-frame anonymous transfer has no
  //      source node id to key a reassembly buffer on, so two allocatees would splice together.
  eq('an anonymous transfer is one frame', dcAnonTransfer(DC_ALLOC, allocFirst, 0).length, 1);
  let anonThrew = false;
  try { dcAnonTransfer(DC_ALLOC, new Array(9).fill(0), 0); } catch (e) { anonThrew = true; }
  eq('an oversized anonymous transfer is refused rather than truncated', anonThrew, true);

  // The commands off the BUS (dcUplinkDecode): from another node they drive dcCtl, from the FC
  // node they are this side's own echo, and a bus command latches no relay. Built with this
  // module's own encoder, so a single-frame and a multi-frame (AngularCommand) transfer are both
  // reassembled through the decoder's own state.
  {
    dcCmdPending = null;
    dcNsHeardAt = Date.now();   // dcUplinkDecode listens only to a bus shown to be DroneCAN
    const feed = (m, node, vals) => { for (const fr of dcTransfer(m, node, dcEncode(m, vals))) dcUplinkDecode(fr); };
    const other = (dcCfg.fcNode & 0x7F) === 100 ? 101 : 100;   // never the FC node, whatever it is set to
    dcCtl.led = 0;
    feed(DC_MSGS[1081], dcCfg.fcNode & 0x7F, { light_id: 0, red: 31, green: 0, blue: 0 });
    eq('the FC node\'s own LightsCommand is its echo', dcCtl.led, 0);
    feed(DC_MSGS[1081], other, { light_id: 0, red: 31, green: 0, blue: 0 });
    eq('LightsCommand from another node sets led', dcCtl.led, 31 << 11);
    feed(DC_MSGS[1081], other, { light_id: 5, red: 0, green: 63, blue: 0 });
    eq('a light other than 0 is not this airframe\'s', dcCtl.led, 31 << 11);
    dcCtl.hook = false;
    feed(DC_MSGS[1070], other, { hardpoint_id: DC_HARDPOINT_ID, command: DC_HOOK_HOLD });
    eq('hardpoint.Command hold', dcCtl.hook, true);
    const gq = dcQuatFromPitchYaw(-30, 45);
    feed(DC_MSGS[1040], other, { gimbal_id: DC_GIMBAL_ID, mode: 2,
      quaternion_x: gq[0], quaternion_y: gq[1], quaternion_z: gq[2], quaternion_w: gq[3] });
    eq('AngularCommand round-trips to whole degrees', [dcCtl.gimbalPitch, dcCtl.gimbalYaw], [-30, 45]);
    const gd = dcQuatFromPitchYaw(-90, 45);
    feed(DC_MSGS[1040], other, { gimbal_id: DC_GIMBAL_ID, mode: 2,
      quaternion_x: gd[0], quaternion_y: gd[1], quaternion_z: gd[2], quaternion_w: gd[3] });
    eq('a mount looking straight down keeps its pan', [dcCtl.gimbalPitch, dcCtl.gimbalYaw], [-90, 45]);
    eq('a bus command latches no relay', dcCmdPending, null);
    //    ...and link-up relays none either: led / hook / gimbal now hold what node `other` said, so
    //    only beep (never read back) goes out - until the panel moves one off the bus value.
    dcNoteLink({}); dcNoteLink(flying);
    eq('link-up re-emits no bus-latched command, but beep', cmdIds(dcFlushCommands()), [1080]);
    dcCtl.led = 1;
    dcNoteLink({}); dcNoteLink(flying);
    eq('a panel value off the bus one goes out at link-up', cmdIds(dcFlushCommands()), [1080, 1081]);
  }

  return { pass: failures.length === 0, failures };
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Only the LED colour joins the config: the flight mode, the beep and the node-failure mask are
// bench switches, and a workspace that re-killed ESC2 on load would be a trap rather than a setting.
function dronecanCollect() { return { txEnabled: dcCfg.txEnabled, fcNode: dcCfg.fcNode, led: dcCtl.led }; }
function dronecanApply(p) {
  p = p || {};
  dcCfg.txEnabled   = typeof p.txEnabled === 'boolean' ? p.txEnabled : true;
  // An older workspace's escBaseNode is ignored: the roster is the only id source now.
  dcCtl.led = typeof p.led === 'number' ? (p.led & 0xFFFF) : 0;
  dcCfg.fcNode      = typeof p.fcNode === 'number' ? Math.max(1, Math.min(127, p.fcNode)) : 1;
  if (document.getElementById('dcTxEnabled')) dronecanOnShow();
  dcTab.markDirty();
}

// ── Exports ───────────────────────────────────────────────────────────────────
window.dronecanIngestFrame = dronecanIngestFrame;
window.dronecanClear = dronecanClear;
window.dronecanStop = dronecanStop;
window.dronecanDemoStart = dcDemoStart;   // demo base-traffic engine starts/stops the quad
window.dronecanDemoStop = dcDemoStop;
window.dronecanOnShow = dronecanOnShow;
window.dronecanCfgChange = dronecanCfgChange;
window.dronecanCtlChange = dronecanCtlChange;
window.dronecanLedOff = dronecanLedOff;
window.dronecanToggleNodeFail = dronecanToggleNodeFail;
// The bench controls, reachable from the floating Drone Control panel (drone.js). dcCtl stays
// the single owner of every drone "in" signal; these are its accessors.
window.dronecanCtl = dronecanCtl;
window.dronecanSetCtl = dronecanSetCtl;
window.dronecanPrearmNames = dronecanPrearmNames;
window.dronecanRoster = dronecanRoster;
// Contract readers the panel would otherwise re-implement: enum labels come off the contract's
// own tables, and RGB565 is the LED's real resolution rather than a rounding choice.
window.dronecanEnumKeys = dcEnumKeys;
window.dronecanEnumLabel = dcEnumLabel;
window.dronecanRgb565FromHex = dcRgb565FromHex;
window.dronecanHexFromRgb565 = dcHexFromRgb565;
window.dronecanGetNodeInfo = dronecanGetNodeInfo;
window.dronecanReadParams = dronecanReadParams;
window.dronecanSetPeriod = dronecanSetPeriod;
window.dronecanRestartNode = dronecanRestartNode;
window.dronecanRestartBadMagic = dronecanRestartBadMagic;
window.dronecanRequestAllocation = dronecanRequestAllocation;
window.dronecanCollect = dronecanCollect;
window.dronecanApply = dronecanApply;
window.dronecanSelfTest = dronecanSelfTest;
if (window._dronecanPending) dronecanApply(window._dronecanPending);
