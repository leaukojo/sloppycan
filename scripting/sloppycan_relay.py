"""
sloppycan_relay.py - local broadcast hub between sloppyCAN (browser) and scripts.

A browser page cannot listen on a socket, so this relay sits in the middle:

    sloppyCAN tab ──ws://127.0.0.1:29540──┐
                                           ├── sloppycan_relay.py
    script A  ─────tcp://127.0.0.1:29541──┤
    script B / nc / any language ─────────┘

It is a dumb broadcast hub: every line one client sends is forwarded to every
OTHER connected client (WS and TCP alike), verbatim, and never parsed as CAN.
It does not know what a CAN id is - it just moves lines of text around.

Run it:
    python sloppycan_relay.py
Then in sloppyCAN, click the "Script" button (top right), then Connect, to
connect the tab to ws://127.0.0.1:29540.

Wire protocol (identical on both ports)
----------------------------------------
ASCII, one frame per line, newline-terminated ('\\n'; a trailing '\\r' is
stripped). A single WebSocket text message may carry several lines - split
on '\\n' and don't rely on message boundaries meaning anything.

Frame grammar is the same as `cansend` / `candump -L` use:
    <id>#<data>
  - id is EXACTLY 3 hex digits (standard, 11-bit, value <= 0x7FF) or EXACTLY
    8 hex digits (extended, 29-bit, value <= 0x1FFFFFFF). The width of the id
    field alone decides standard vs extended (123# is not the same id as
    00000123#).
  - data is 0-8 bytes written as hex pairs; '.' separators are accepted on
    input (DE.AD.BE.EF) but never produced on output. The number of bytes is
    the DLC.
  - Remote frame: <id>#R (DLC 0) or <id>#R<d> where d is a single 0-8 digit
    giving the requested DLC.
  - Anything else (CAN FD '##', a '_' DLC-escape suffix, error frames, or a
    line that just doesn't match) is not part of this protocol and should be
    ignored by receivers - this relay does not need to know the grammar at
    all, it just forwards lines, but scripts using sloppybus.py rely on it.

Semantics: a line represents a frame that appeared on the bus. Exactly like a
real CAN controller, THE SENDER NEVER GETS ITS OWN LINE BACK. There are no
acknowledgements and no timestamps on the wire - receivers stamp frames on
arrival if they care.

Try it with plain tools (no sloppyCAN needed):
    nc 127.0.0.1 29541
        is a live candump - anything anyone else sends shows up here.
    echo 123#DEADBEEF | nc 127.0.0.1 29541
        is a one-shot cansend.
    (Windows users without BSD nc can use `ncat` from the nmap project, or
    Git Bash's bundled nc.)

Any language can be a client - it's just line-based TCP. A ~10-line Node.js
example:

    const net = require('net');
    const sock = net.connect(29541, '127.0.0.1', () => {
      sock.write('123#DEADBEEF\\n');           // cansend
    });
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\\n');
      buf = lines.pop();                        // keep the partial tail
      for (const line of lines) if (line) console.log('rx:', line);
    });

Opening sloppyCAN from file:// (no web server): browsers send
`Origin: null` for file:// pages (and for sandboxed iframes from ANY site,
which is why that origin isn't allowed by default - see below). Pass
--allow-file-origin to accept it, or just serve the page instead:
    python -m http.server 8000
Chrome 147+ shows a one-time "local network access" permission prompt when a
github.io-hosted page (a public site) tries to reach this relay on your
local machine. A DENIED prompt looks exactly like "relay isn't running" -
if frames don't arrive, check the page's address-bar padlock -> Site
settings -> Local network access, and re-allow it there.

Security
--------
WebSockets do not do CORS - any web page you happen to have open could open
a WS connection to 127.0.0.1:29540 with no cross-origin restriction at all.
Since sloppyCAN can drive a real CAN adapter (a real vehicle, a real bus),
an unrelated malicious page reaching this relay is not a toy risk. Hence:

  - Binds 127.0.0.1 only by default. --host changes this; doing so exposes
    the relay (and therefore the bus) to your whole network/LAN - only use
    it if you understand and accept that.
  - The WS handshake is rejected (403) unless the Origin header is one of:
    https://leaukojo.github.io, or http(s)://localhost:<port>,
    127.0.0.1:<port>, [::1]:<port> for any port (or those hosts with no
    port at all). --allow-origin scheme://host[:port] (repeatable) adds
    more exact origins.
  - Origin: null (file:// pages, but ALSO any sandboxed iframe from any
    site) is rejected unless --allow-file-origin is passed.
  - A MISSING Origin header is allowed - real browsers always send Origin on
    a WebSocket handshake, so no Origin means a non-browser local client
    (e.g. a script opening a raw WS out of curiosity), which is no more
    dangerous than a plain TCP client.
  - The Host header's hostname must be localhost/127.0.0.1/[::1] (or the
    literal --host value), to block DNS-rebinding attacks that would
    otherwise dress up as a same-origin request.
  - The TCP port drops a connection whose first line is an HTTP request line:
    a web page can fetch()/POST to any localhost port, and the body lines of
    that request would otherwise be forwarded as frames.
"""

import argparse
import asyncio
import base64
import hashlib
import logging
import re
import struct
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_LINE_LEN = 128
MAX_WS_MESSAGE = 1 * 1024 * 1024  # 1 MB
WRITE_BUFFER_LIMIT = 1 * 1024 * 1024  # 1 MB backpressure cutoff
_HTTP_REQUEST_RE = re.compile(r"^[A-Z]+ \S+ HTTP/\d")   # "POST / HTTP/1.1"

log = logging.getLogger("sloppycan_relay")


# ── shared line filtering ───────────────────────────────────────────────

def _printable_ascii_lines(chunk: bytes):
    """Split chunk on '\n', strip a trailing '\r', drop empty/overlong/
    non-printable-ASCII lines. Returns a list of valid line strings (no
    line terminators). This is CAN-agnostic - it just guards against binary
    garbage and length-based abuse; it does not parse CAN frames at all."""
    out = []
    for raw in chunk.split(b"\n"):
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        if not raw:
            continue
        if len(raw) > MAX_LINE_LEN:
            continue
        # printable ASCII: 0x20-0x7E only (no control chars, no non-ASCII)
        if any(b < 0x20 or b > 0x7E for b in raw):
            continue
        out.append(raw.decode("ascii"))
    return out


# ── client bookkeeping / broadcast ──────────────────────────────────────

class Client:
    """One connected peer, either a TCP socket or a WebSocket."""

    def __init__(self, kind, peer, writer, send_fn):
        self.kind = kind          # 'tcp' or 'ws'
        self.peer = peer          # string, for logging
        self.writer = writer      # asyncio.StreamWriter
        self.send_fn = send_fn    # (bytes-of-joined-lines) -> None, kind-specific framing
        self.drops = 0
        self._last_drop_log = 0.0


class Hub:
    """Holds all connected clients and does the actual broadcast + backpressure."""

    def __init__(self, verbose=False):
        self.clients = set()
        self.verbose = verbose
        self.lines_in = 0
        self.lines_out = 0

    def add(self, client):
        self.clients.add(client)

    def remove(self, client):
        self.clients.discard(client)

    def broadcast(self, lines, sender):
        """Send `lines` (list of str, already validated) to every client
        except `sender`. One unit of broadcast per inbound read - callers
        pass all lines pulled out of a single read/message together."""
        if not lines:
            return
        self.lines_in += len(lines)
        payload = ("\n".join(lines) + "\n").encode("ascii")
        for client in list(self.clients):
            if client is sender:
                continue
            self._send_with_backpressure(client, payload, len(lines))

    def _send_with_backpressure(self, client, payload, n_lines):
        writer = client.writer
        try:
            buffered = writer.transport.get_write_buffer_size()
        except Exception:
            buffered = 0
        if buffered > WRITE_BUFFER_LIMIT:
            client.drops += 1
            now = time.monotonic()
            if now - client._last_drop_log > 5.0:
                log.warning(
                    "dropping output to %s %s (backpressure, %d drops so far)",
                    client.kind, client.peer, client.drops,
                )
                client._last_drop_log = now
            return
        try:
            client.send_fn(payload)
            self.lines_out += n_lines
        except Exception as exc:
            log.debug("send to %s %s failed: %s", client.kind, client.peer, exc)
        # Deliberately never `await drain()` here: broadcast must not block
        # on one slow client while forwarding to the rest.


# ── TCP side ─────────────────────────────────────────────────────────────

async def handle_tcp(reader, writer, hub):
    peer = "%s:%s" % writer.get_extra_info("peername")[:2]
    client = Client("tcp", peer, writer, lambda payload: writer.write(payload))
    hub.add(client)
    log.info("connect tcp %s", peer)
    try:
        buf = b""
        checked = False
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            buf += chunk
            # keep the trailing partial line (no trailing \n yet) in buf
            if buf.endswith(b"\n"):
                complete, buf = buf, b""
            else:
                idx = buf.rfind(b"\n")
                if idx == -1:
                    if len(buf) > MAX_LINE_LEN * 4:
                        # no newline for way too long - drop and resync
                        log.warning("tcp %s: overlong unterminated data, resyncing", peer)
                        buf = b""
                    continue
                complete, buf = buf[: idx + 1], buf[idx + 1 :]
            lines = _printable_ascii_lines(complete)
            if lines and not checked:
                checked = True
                if _HTTP_REQUEST_RE.match(lines[0]):
                    # A web page's fetch()/form POST: its body lines would otherwise reach the bus.
                    log.warning("reject tcp %s (an HTTP request - a web page, not a script)", peer)
                    break
            hub.broadcast(lines, client)
    except ConnectionError:   # reset / aborted (Windows) / broken pipe
        pass
    finally:
        hub.remove(client)
        writer.close()
        log.info("disconnect tcp %s", peer)


# ── minimal RFC 6455 WebSocket server ───────────────────────────────────

class WSCloseConnection(Exception):
    def __init__(self, code=1000, reason=b""):
        self.code = code
        self.reason = reason


_LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}


def _split_host_port(hostport):
    """Split a 'host:port' or bracketed '[ipv6]:port' string into
    (hostname, port_or_None), stripping the brackets from an IPv6 literal."""
    hostport = hostport.strip()
    if hostport.startswith("["):
        end = hostport.find("]")
        if end == -1:
            return hostport.lower(), None
        hostname = hostport[1:end]
        rest = hostport[end + 1 :]
        port = rest[1:] if rest.startswith(":") else None
        return hostname.lower(), port
    if hostport.count(":") == 1:
        hostname, _, port = hostport.partition(":")
        return hostname.lower(), port
    # no colon, or a bare (unbracketed) IPv6 literal with multiple colons
    return hostport.lower(), None


def _origin_allowed(origin, allowed_exact, allow_file_origin, host_arg):
    if origin is None:
        # real browsers always send Origin on a WS handshake; a missing
        # header means a non-browser local client.
        return True
    if origin == "null":
        return allow_file_origin
    if origin in allowed_exact:
        return True
    m = re.match(r"^(https?)://(\[[^\]]+\]|[^/]+?)$", origin)
    if not m:
        return False
    scheme, hostport = m.group(1), m.group(2)
    hostname, _port = _split_host_port(hostport)
    if hostname in _LOCAL_HOSTNAMES:   # http or https, any port
        return True
    return False


def _host_allowed(host_header, host_arg):
    if not host_header:
        return False
    hostname, _port = _split_host_port(host_header)
    if hostname in _LOCAL_HOSTNAMES:
        return True
    if host_arg and hostname == host_arg.lower():
        return True
    return False


async def _read_http_headers(reader):
    """Read a request line + headers terminated by a blank line. Returns
    (request_line, {lowercased-header-name: value})."""
    data = await reader.readuntil(b"\r\n\r\n")
    text = data.decode("iso-8859-1")
    lines = text.split("\r\n")
    request_line = lines[0]
    headers = {}
    for line in lines[1:]:
        if not line:
            continue
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return request_line, headers


async def _send_http_error(writer, code, text):
    reason = {403: "Forbidden", 400: "Bad Request"}.get(code, "Error")
    body = text.encode("utf-8")
    resp = (
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: text/plain\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n\r\n" % (code, reason, len(body))
    ).encode("ascii") + body
    try:
        writer.write(resp)
        await writer.drain()
    except ConnectionError:   # the rejected client already hung up
        pass
    writer.close()


def _ws_accept_key(client_key):
    sha1 = hashlib.sha1((client_key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(sha1).decode("ascii")


def _ws_frame(opcode, payload: bytes) -> bytes:
    """Build one unmasked server->client frame (FIN always set)."""
    header = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack(">H", n)
    else:
        header += bytes([127]) + struct.pack(">Q", n)
    return header + payload


async def _ws_read_frame(reader):
    """Read one client WS frame. Returns (fin, opcode, payload) or raises
    WSCloseConnection / asyncio.IncompleteReadError on EOF."""
    hdr = await reader.readexactly(2)
    b0, b1 = hdr[0], hdr[1]
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if not masked:
        # RFC 6455: client-to-server frames MUST be masked.
        raise WSCloseConnection(1002, b"unmasked client frame")
    if length == 126:
        length = struct.unpack(">H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", await reader.readexactly(8))[0]
    if length > MAX_WS_MESSAGE:
        raise WSCloseConnection(1009, b"message too big")
    mask_key = await reader.readexactly(4)
    masked_payload = await reader.readexactly(length)
    payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(masked_payload))
    return fin, opcode, payload


async def handle_ws_client(reader, writer, hub):
    """After the HTTP handshake, service one WS connection: text frames are
    line-split and broadcast, ping->pong, close->close, binary/oversize are
    rejected per spec."""
    peer = "%s:%s" % writer.get_extra_info("peername")[:2]
    client = Client(
        "ws", peer, writer,
        lambda payload: writer.write(_ws_frame(0x1, payload)),
    )
    hub.add(client)
    try:
        frag_opcode = None
        frag_parts = []
        while True:
            fin, opcode, payload = await _ws_read_frame(reader)
            if opcode == 0x8:  # close
                writer.write(_ws_frame(0x8, payload[:125]))
                await writer.drain()
                break
            elif opcode == 0x9:  # ping
                writer.write(_ws_frame(0xA, payload))
            elif opcode == 0xA:  # pong
                pass
            elif opcode == 0x2:  # binary - not part of this protocol
                raise WSCloseConnection(1003, b"binary frames unsupported")
            elif opcode in (0x0, 0x1):  # continuation / text
                if opcode == 0x1:
                    frag_opcode = 0x1
                    frag_parts = [payload]
                else:
                    if frag_opcode is None:
                        raise WSCloseConnection(1002, b"continuation with no start")
                    frag_parts.append(payload)
                total = sum(len(p) for p in frag_parts)
                if total > MAX_WS_MESSAGE:
                    raise WSCloseConnection(1009, b"message too big")
                if fin:
                    message = b"".join(frag_parts)
                    frag_opcode, frag_parts = None, []
                    lines = _printable_ascii_lines(message)
                    hub.broadcast(lines, client)
            else:
                raise WSCloseConnection(1002, b"unknown opcode")
    except WSCloseConnection as exc:
        try:
            writer.write(_ws_frame(0x8, struct.pack(">H", exc.code) + exc.reason[:123]))
            await writer.drain()
        except Exception:
            pass
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        hub.remove(client)
        writer.close()
        log.info("disconnect ws %s", peer)


async def handle_ws_connection(reader, writer, hub, args):
    """Full lifecycle for a new socket on the WS port: HTTP handshake then
    hand off to handle_ws_client."""
    peer = "%s:%s" % writer.get_extra_info("peername")[:2]
    try:
        request_line, headers = await _read_http_headers(reader)
    except (asyncio.IncompleteReadError, ConnectionError, asyncio.LimitOverrunError):
        writer.close()
        return

    origin = headers.get("origin")
    upgrade = headers.get("upgrade", "").lower()
    ws_key = headers.get("sec-websocket-key")
    host_header = headers.get("host")

    if not _host_allowed(host_header, args.host):
        log.info("reject ws %s (bad Host: %r)", peer, host_header)
        await _send_http_error(writer, 403, "Forbidden: bad Host header\n")
        return
    if upgrade != "websocket" or not ws_key:
        log.info("reject ws %s (not a websocket upgrade)", peer)
        await _send_http_error(writer, 400, "Bad Request: expected a WebSocket upgrade\n")
        return
    if not _origin_allowed(origin, args.allow_origin_set, args.allow_file_origin, args.host):
        log.info("reject ws %s (Origin: %r)", peer, origin)
        await _send_http_error(writer, 403, "Forbidden: origin not allowed\n")
        return

    accept = _ws_accept_key(ws_key)
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
    ).encode("ascii")
    writer.write(resp)
    await writer.drain()
    log.info("connect ws %s (Origin: %r)", peer, origin)
    await handle_ws_client(reader, writer, hub)


# ── periodic stats (only under -v) ──────────────────────────────────────

async def stats_loop(hub):
    prev_in, prev_out = 0, 0
    while True:
        await asyncio.sleep(5)
        din = hub.lines_in - prev_in
        dout = hub.lines_out - prev_out
        prev_in, prev_out = hub.lines_in, hub.lines_out
        log.info("lines: %.1f/s in, %.1f/s out (%d clients)",
                  din / 5.0, dout / 5.0, len(hub.clients))


# ── main ─────────────────────────────────────────────────────────────────

def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Local broadcast relay between sloppyCAN (WebSocket) and scripts (TCP)."
    )
    p.add_argument("--ws-port", type=int, default=29540, help="WebSocket port for sloppyCAN (default 29540)")
    p.add_argument("--tcp-port", type=int, default=29541, help="TCP port for scripts (default 29541)")
    p.add_argument("--host", default="127.0.0.1",
                   help="bind address (default 127.0.0.1; opening this to your network "
                        "exposes the relay, and therefore the CAN bus, to it)")
    p.add_argument("--allow-origin", action="append", default=[], metavar="URL",
                   help="extra allowed WS Origin, exact scheme://host[:port] (repeatable)")
    p.add_argument("--allow-file-origin", action="store_true",
                   help="also accept Origin: null (file:// pages, and any sandboxed iframe)")
    p.add_argument("-v", "--verbose", action="store_true", help="also log throughput (lines/s) every 5 s; connects, disconnects and rejections are always logged")
    args = p.parse_args(argv)
    args.allow_origin_set = {"https://leaukojo.github.io"} | set(args.allow_origin)
    return args


async def amain(args):
    hub = Hub(verbose=args.verbose)

    tcp_server = await asyncio.start_server(
        lambda r, w: handle_tcp(r, w, hub), args.host, args.tcp_port
    )
    ws_server = await asyncio.start_server(
        lambda r, w: handle_ws_connection(r, w, hub, args), args.host, args.ws_port
    )

    for sock in tcp_server.sockets:
        log.info("listening (tcp, scripts) on %s", sock.getsockname())
    for sock in ws_server.sockets:
        log.info("listening (ws, sloppyCAN) on %s", sock.getsockname())

    tasks = [asyncio.ensure_future(tcp_server.serve_forever()),
             asyncio.ensure_future(ws_server.serve_forever())]
    if args.verbose:
        tasks.append(asyncio.ensure_future(stats_loop(hub)))

    # Wake up once a second so Ctrl+C (KeyboardInterrupt) is delivered
    # promptly on Windows, where a fully-blocked asyncio loop can otherwise
    # swallow it until the next I/O event.
    try:
        while True:
            await asyncio.sleep(1)
    finally:
        for t in tasks:
            t.cancel()
        tcp_server.close()
        ws_server.close()


def main():
    args = parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    # startup banner lines are informational, not warnings - always show them
    log.setLevel(logging.INFO)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("binding to %s exposes this relay (and the CAN bus behind it) beyond this machine", args.host)
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("", file=sys.stderr)  # move past a stray ^C
        sys.exit(0)


if __name__ == "__main__":
    main()
