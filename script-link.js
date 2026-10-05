// ── script-link.js - live CAN I/O with local scripts over a WebSocket relay ─────────
// Lets user scripts (any language) act as nodes on sloppyCAN's bus through the local relay
// scripting/sloppycan_relay.py: this page joins it on ws://127.0.0.1:29540, scripts on a plain
// TCP port, and the relay broadcasts every line to every other client.
//
// CLICK-ONLY: the header "Script" button opens a window explaining the link, and only its Connect
// button opens the socket. Nothing is remembered, so every page load starts disconnected - Chrome
// 147+ shows a Local Network Access prompt when a public origin opens a localhost socket, and that
// prompt must never appear unasked. ?scriptLink=<port> only points at a relay run with --ws-port.
//
// Wire protocol: one frame per '\n'-terminated line, cansend grammar - `123#DEADBEEF` (3 hex id
// digits = 11-bit, exactly 8 = 29-bit), `123#R` / `123#R4` remote. Unparseable lines are ignored.
//
// Integration hooks in sloppycan.js (remove to revert):
//   ingestFrameBody → scriptLinkFrame(frame)   every frame on the bus: RX, demo traffic, telemetry
//   recordTxFrame   → scriptLinkFrame({...})   frames sloppyCAN transmits itself
// Inbound frames go through window.canForward (the gateway model): ingested once, transmitted when
// the bus is TX-ready (listen-only / no bus → ingest only), shown once as FW. index.html carries
// the #scriptBtn button + its #scriptLinkStatus dot.
(function () {
  const DEFAULT_PORT  = 29540;
  const MAX_BUFFERED  = 256 * 1024;       // ws.bufferedAmount above this → drop outbound batches
  const RX_QUEUE_MAX  = 512;              // inbound frames awaiting transmit (tail-drop beyond)
  const BACKOFF_MS    = [1000, 2000, 4000, 10000];
  // cansend grammar: 3 or 8 hex id digits, then R[dlc] or 0-8 hex bytes with optional '.' separators.
  const LINE_RE = /^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})#(?:R([0-8])?|((?:[0-9A-Fa-f]{2}\.?){0,8}))$/;
  const HEX = '0123456789ABCDEF';
  const REPO_DIR = 'https://github.com/leaukojo/sloppycan/tree/dev/scripting';

  const btn = document.getElementById('scriptBtn');
  const dot = document.getElementById('scriptLinkStatus');
  if (!btn) return;
  const baseTitle = btn.title;

  let wsPort = DEFAULT_PORT;
  const qPort = parseInt(new URLSearchParams(location.search).get('scriptLink'), 10);
  if (qPort > 1 && qPort < 65536) wsPort = qPort;

  let enabled = false, state = 'off';     // state: off | connecting | connected | retrying
  let ws = null, wasOpen = false;
  let retryTimer = null, retryAt = 0, attempt = 0, countdownTimer = null;
  let win = null;                         // the explainer window while open
  let outBatch = [], flushQueued = false;
  let injecting = null;                   // frame currently being ingested from the socket (echo guard)
  const rxQueue = [];
  let draining = false, drainGen = 0;
  let dropOut = 0, dropIn = 0, badLines = 0, injectErr = 0, lastWarn = 0;
  // A file:// page sends Origin: null, which the relay refuses unless run with --allow-file-origin.
  const FILE_PAGE = location.protocol === 'file:';
  const RELAY_CMD = 'python sloppycan_relay.py' + (FILE_PAGE ? ' --allow-file-origin' : '');

  const say = (msg, level) => { if (window.log) window.log(msg, level); };

  // ── Line format ──
  function formatLine(f) {
    let s = (f.id >>> 0).toString(16).toUpperCase().padStart(f.isExt ? 8 : 3, '0') + '#';
    if (f.isRtr) return s + 'R' + (f.dlc ? Math.min(f.dlc, 8) : '');
    const d = f.data || [];
    for (let i = 0; i < d.length && i < 8; i++) s += HEX[(d[i] >> 4) & 15] + HEX[d[i] & 15];
    return s;
  }

  function parseLine(line) {
    const m = LINE_RE.exec(line);
    if (!m) return null;
    const isExt = m[1].length === 8;
    const id = parseInt(m[1], 16);
    if (id > (isExt ? 0x1FFFFFFF : 0x7FF)) return null;
    if (m[3] === undefined) return { id, isExt, isRtr: true, dlc: m[2] ? +m[2] : 0, data: [] };
    const hex = m[3].replace(/\./g, '');
    const data = [];
    for (let i = 0; i < hex.length; i += 2) data.push(parseInt(hex.substr(i, 2), 16));
    return { id, isExt, isRtr: false, dlc: data.length, data };
  }

  // Drop / bad-line counts are reported at most every 5 s rather than per frame.
  function warnThrottled() {
    const now = Date.now();
    if (now - lastWarn < 5000 || !(dropOut || dropIn || badLines || injectErr)) return;
    lastWarn = now;
    const parts = [];
    if (badLines)  parts.push(`${badLines} unparseable line(s) ignored`);
    if (dropIn)    parts.push(`${dropIn} script frame(s) dropped - sent faster than the adapter transmits`);
    if (dropOut)   parts.push(`${dropOut} bus frame(s) not forwarded - relay not keeping up`);
    if (injectErr) parts.push(`${injectErr} script frame(s) failed to inject (a module threw)`);
    say('Script link: ' + parts.join('; '), 'warn');
    dropOut = dropIn = badLines = injectErr = 0;
  }

  // ── Outbound: every frame on the bus → relay ──
  // Batched per task via a microtask, so a USB transfer's worth of frames (or one demo tick) goes out
  // as one WS message; microtasks aren't timer-throttled when the tab is hidden.
  window.scriptLinkFrame = function (frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN || frame === injecting) return;
    outBatch.push(formatLine(frame));
    if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
  };

  function flush() {
    flushQueued = false;
    const lines = outBatch;
    outBatch = [];
    if (!lines.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) { dropOut += lines.length; warnThrottled(); return; }
    ws.send(lines.join('\n') + '\n');
  }

  // ── Inbound: relay → bus ──
  // Ordered FIFO, deliberately not coalesced per id (a script may send an ISO-TP burst on one id).
  function onMessage(ev) {
    if (typeof ev.data !== 'string') return;
    for (const raw of ev.data.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const f = parseLine(line);
      if (!f) { badLines++; continue; }
      if (rxQueue.length >= RX_QUEUE_MAX) { dropIn++; continue; }
      rxQueue.push(f);
    }
    warnThrottled();
    if (!draining) drain();
  }

  // canForward ingests synchronously (so `injecting` marks exactly that frame for the echo guard in
  // scriptLinkFrame) and returns the transmit promise when the bus is TX-ready; awaiting it keeps
  // the script's frames in order on the wire. A frame whose ingest throws (a module hook) is
  // counted and skipped; Disconnect bumps drainGen, so a loop stuck on a transmit that never
  // settles is abandoned rather than blocking the next connection.
  async function drain() {
    const gen = drainGen;
    draining = true;
    try {
      while (rxQueue.length && window.canForward && gen === drainGen) {
        const f = rxQueue.shift();
        let p;
        injecting = f;
        try { p = window.canForward(f); }
        catch (e) { injectErr++; warnThrottled(); continue; }
        finally { injecting = null; }
        if (p) await p;
      }
    } finally { if (gen === drainGen) draining = false; }
  }

  // ── Status: header dot + button state + the window's status line ──
  function statusText() {
    if (state === 'connecting') return 'Connecting…';
    if (state === 'connected')  return `Connected to the relay (ws://127.0.0.1:${wsPort})`;
    if (state === 'retrying') {
      const s = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      return `Relay not reachable - retrying in ${s}s. Is it running (${RELAY_CMD})?`;
    }
    return 'Not connected';
  }

  function render() {
    const color = state === 'connected' ? 'var(--green)' : state === 'off' ? '' : 'var(--amber)';
    if (dot) { dot.textContent = state === 'off' ? '' : '●'; dot.style.color = color; }
    btn.title = `${baseTitle} (${statusText()})`;
    if (win) {
      win.status.textContent = 'Status: ' + statusText();
      win.status.style.color = color;
      win.toggle.textContent = enabled ? 'Disconnect' : 'Connect';
    }
  }

  function setStatus(s) {
    state = s;
    clearInterval(countdownTimer); countdownTimer = null;
    if (s === 'retrying') countdownTimer = setInterval(render, 1000);
    render();
  }

  // ── Connection ──
  function connect() {
    clearTimeout(retryTimer); retryTimer = null;
    if (!enabled || ws) return;
    setStatus('connecting');
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${wsPort}/`); }
    catch (e) { scheduleRetry(); return; }
    ws = sock; wasOpen = false;
    sock.onopen = () => {
      if (ws !== sock) return;
      wasOpen = true; attempt = 0;
      setStatus('connected');
      say(`Script link connected (ws://127.0.0.1:${wsPort})`, 'ok');
    };
    sock.onmessage = (ev) => { if (ws === sock) onMessage(ev); };
    sock.onclose = () => {                 // also follows every onerror
      if (ws !== sock) return;             // a deliberate close from setEnabled(false)
      ws = null; outBatch = [];
      if (wasOpen) say('Script link lost - retrying', 'warn');
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (!enabled) { setStatus('off'); return; }
    const ms = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    retryAt = Date.now() + ms;
    retryTimer = setTimeout(connect, ms);
    setStatus('retrying');
  }

  function setEnabled(on) {
    enabled = on;
    if (on) { attempt = 0; connect(); return; }
    clearTimeout(retryTimer); retryTimer = null;
    if (ws) { const s = ws; ws = null; s.close(); }
    rxQueue.length = 0; outBatch = [];
    drainGen++; draining = false;
    setStatus('off');
  }

  // A tab coming back to the foreground retries straight away instead of waiting out the backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled && !ws) { attempt = 0; connect(); }
  });

  // ── Explainer window (header "Script" button) ──
  const css = document.createElement('style');
  css.textContent = `
.sl-dot { margin-left:4px; font-size:10px; }
.sl-ov { position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center;
  background:#0008; backdrop-filter:blur(2px); }
.sl-win { background:var(--bg2); border:1px solid var(--border2); border-radius:10px; max-width:520px; margin:16px;
  padding:22px 24px; font-family:var(--sans); color:var(--text); box-shadow:0 8px 40px #000a; font-size:13px; line-height:1.5; }
.sl-win h3 { margin:0 0 10px; font-size:15px; font-weight:600; color:var(--amber); }
.sl-win p, .sl-win ol { margin:0 0 10px; color:var(--text2); }
.sl-win ol { padding-left:20px; }
.sl-win b { color:var(--text); }
.sl-win code { font-family:var(--mono); font-size:12px; color:var(--text); }
.sl-win a { color:var(--amber); }
.sl-status { margin-top:14px; font-size:12px; color:var(--text2); }
.sl-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
.sl-actions button { padding:7px 14px; border-radius:6px; border:1px solid var(--border2); background:var(--bg3);
  color:var(--text); cursor:pointer; font-family:var(--sans); }
.sl-actions .sl-primary { border-color:var(--amber); background:var(--amber-dim); color:var(--amber); }`;
  document.head.appendChild(css);

  const fileLink = f => `<a href="scripting/${f}" download>${f}</a>`;

  function onKey(e) { if (e.key === 'Escape') closeWindow(); }

  function closeWindow() {
    if (!win) return;
    win.ov.remove();
    document.removeEventListener('keydown', onKey);
    win = null;
  }

  // Static markup only - the port is a parsed integer, nothing bus- or user-controlled goes in here.
  window.scriptLinkShow = function () {
    if (win) return;
    const ov = document.createElement('div');
    ov.className = 'sl-ov';
    ov.innerHTML = `<div class="sl-win" role="dialog" aria-modal="true" aria-labelledby="slTitle">
  <h3 id="slTitle">Script link</h3>
  <p>Let your own scripts - Python or any language - read and send live CAN frames on this bus. Scripts
  see every frame sloppyCAN sees, and what they send is handled as if it arrived on the bus (and goes out
  on the wire when a bus is open and Listen-only is off).</p>
  <ol>
    <li>Start the relay on this computer: <code>${RELAY_CMD}</code>${FILE_PAGE ? ' - this page was opened from a file, which the relay only accepts with that flag (or serve the folder with <code>python -m http.server</code>)' : ''}</li>
    <li>Click <b>Connect</b> below.</li>
    <li>Run a script, e.g. <code>python example.py</code></li>
  </ol>
  <p><b>Connect opens a WebSocket to <code>ws://127.0.0.1:${wsPort}</code></b>, the relay on your own
  machine. On the hosted site Chrome then asks to allow <b>Local network access</b> - allow it. If it was
  blocked, the link just keeps retrying: re-allow it via the padlock ▸ Site settings ▸ Local network
  access, then reload.</p>
  <p>The relay and the examples are in the <a href="${REPO_DIR}" target="_blank" rel="noopener">scripting
  folder</a>: ${fileLink('sloppycan_relay.py')} (the relay), ${fileLink('sloppybus.py')} (helper - keep it
  next to your scripts), ${fileLink('example.py')}, ${fileLink('example_dump.py')},
  ${fileLink('example_send_every_1s.py')}. Standard-library Python 3.8+, nothing to install.</p>
  <div class="sl-status"></div>
  <div class="sl-actions"><button class="sl-close">Close</button><button class="sl-primary sl-toggle"></button></div>
</div>`;
    win = { ov, status: ov.querySelector('.sl-status'), toggle: ov.querySelector('.sl-toggle') };
    ov.querySelector('.sl-close').onclick = closeWindow;
    win.toggle.onclick = () => setEnabled(!enabled);
    ov.addEventListener('click', e => { if (e.target === ov) closeWindow(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    render();
    win.toggle.focus();
  };

  render();
})();
