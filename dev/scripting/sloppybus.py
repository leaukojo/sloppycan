"""
sloppybus.py - client helper for talking to sloppycan_relay.py over plain TCP.

Quick start:

    from sloppybus import Bus

    bus = Bus()                      # 127.0.0.1:29541 - connects on first send/run/recv

    @bus.on(0x123)                   # runs whenever id 0x123 shows up
    def handler(frame):
        print(frame)

    @bus.every(0.5)                  # runs every 500 ms
    def heartbeat():
        bus.send(0x100, [1, 2, 3])

    bus.run()                        # blocks; auto-reconnects if the relay drops

Everything (callbacks, `every()` tasks) runs on the single thread that calls
`run()`, so user code never needs locks.

Protocol reminder (see sloppycan_relay.py for the full spec): one frame per
line, `<id>#<hexdata>` / `<id>#R<dlc>` for remote frames, 3 hex digits = an
11-bit standard id, 8 hex digits = a 29-bit extended id. You never receive
your own sent frames back - the relay treats the wire like a real CAN bus.
"""

import collections
import re
import select
import socket
import sys
import time
import traceback

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 29541
RECONNECT_INTERVAL = 1.0  # seconds between reconnect attempts

_LINE_RE = re.compile(
    r"^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{8})#(R([0-8])?|((?:[0-9A-Fa-f]{2}\.?){0,8}))$"
)


class Frame:
    """One CAN frame. `ts` is a time.time() timestamp - stamped on arrival
    for received frames, or at send time for sent ones."""

    __slots__ = ("id", "data", "ext", "rtr", "dlc", "ts")

    def __init__(self, id, data=b"", ext=False, rtr=False, dlc=None, ts=None):
        self.id = id
        self.data = bytes(data)
        self.ext = ext
        self.rtr = rtr
        self.dlc = len(self.data) if dlc is None else dlc
        self.ts = time.time() if ts is None else ts

    def __repr__(self):
        return "Frame(%s)" % str(self)

    def __str__(self):
        return format_frame(self.id, self.data, ext=self.ext, rtr=self.rtr, dlc=self.dlc)


def format_frame(id, data=b"", ext=None, rtr=False, dlc=None):
    """Build a canonical wire line for one frame, e.g. '024#0FA0',
    '18FEF100#0000000000000000', '321#R4'. `ext` defaults to id > 0x7FF."""
    data = bytes(data)
    if ext is None:
        ext = id > 0x7FF
    width = 8 if ext else 3
    max_id = 0x1FFFFFFF if ext else 0x7FF
    if not (0 <= id <= max_id):
        raise ValueError("id 0x%X out of range for %s frame" % (id, "extended" if ext else "standard"))
    if rtr:
        d = dlc if dlc is not None else len(data)
        if not (0 <= d <= 8):
            raise ValueError("rtr dlc must be 0-8, got %r" % (d,))
        return "%0*X#R%d" % (width, id, d) if d else "%0*X#R" % (width, id)
    if len(data) > 8:
        raise ValueError("data must be 0-8 bytes, got %d" % len(data))
    return "%0*X#%s" % (width, id, data.hex().upper())


def parse_line(line):
    """Parse one wire line into a Frame, or None if it doesn't match the
    grammar (unsupported/garbage lines are ignored, not errors - this keeps
    the protocol forward-compatible)."""
    line = line.strip("\r\n")
    m = _LINE_RE.match(line)
    if not m:
        return None
    id_hex, body, rtr_dlc, data_hex = m.group(1), m.group(2), m.group(3), m.group(4)
    ext = len(id_hex) == 8
    can_id = int(id_hex, 16)
    max_id = 0x1FFFFFFF if ext else 0x7FF
    if can_id > max_id:
        return None
    if body.startswith("R"):
        dlc = int(rtr_dlc) if rtr_dlc else 0
        return Frame(can_id, b"", ext=ext, rtr=True, dlc=dlc)
    hex_bytes = data_hex.replace(".", "")
    if len(hex_bytes) % 2 != 0:
        return None
    try:
        data = bytes.fromhex(hex_bytes)
    except ValueError:
        return None
    if len(data) > 8:
        return None
    return Frame(can_id, data, ext=ext, rtr=False, dlc=len(data))


class Bus:
    """Single-threaded client for one relay TCP connection.

    Use either the callback style (`on_any` / `on` / `every` / `on_connect`
    then `run()`) or the linear style (`recv()`), not both - `recv()` does
    not dispatch registered callbacks.
    """

    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT):
        self.host = host
        self.port = port
        self.sock = None
        self._buf = b""
        self._connected = False
        self._warned_disconnected = False  # send() warns once per disconnection
        self._warned_unreachable = False   # "relay not running?" hint, once per outage
        self._next_reconnect = 0.0
        self._pending = collections.deque()   # frames read but not yet returned by recv()

        self._any_handlers = []
        self._id_handlers = []      # list of (ids_set, ext, callback)
        self._connect_handlers = []
        self._periodic = []         # list of [period, next_deadline, callback]

        self._running = False

    # -- decorators ---------------------------------------------------

    def on_any(self, fn):
        """Decorator: fn(frame) runs for every received frame."""
        self._any_handlers.append(fn)
        return fn

    def on(self, *ids, ext=None):
        """Decorator factory: fn(frame) runs when frame.id is one of `ids`.
        ext=None matches either width, ext=True/False restricts to it."""
        id_set = set(ids)

        def decorator(fn):
            self._id_handlers.append((id_set, ext, fn))
            return fn

        return decorator

    def every(self, seconds):
        """Decorator factory: fn() runs every `seconds`, drift-free (the
        schedule is prev + period, not now + period) - if a task falls more
        than one period behind it skips ahead rather than bursting."""

        def decorator(fn):
            self._periodic.append([seconds, time.monotonic() + seconds, fn])
            return fn

        return decorator

    def on_connect(self, fn):
        """Decorator: fn() runs once each time the connection is (re)established."""
        self._connect_handlers.append(fn)
        return fn

    # -- connection management -----------------------------------------

    def _connect(self):
        # Short timeout: a loopback connect succeeds in well under a millisecond, but on Windows a
        # REFUSED one blocks for the full timeout (it retries the SYN), which would stall every()
        # tasks while the relay is down.
        try:
            sock = socket.create_connection((self.host, self.port), timeout=0.2)
        except OSError:
            return False
        # Blocking with a timeout (not non-blocking): recv only runs after select() says readable,
        # and sendall() then waits out a momentarily full buffer instead of failing mid-burst.
        sock.settimeout(5.0)
        self.sock = sock
        self._buf = b""
        self._connected = True
        self._warned_disconnected = False
        self._warned_unreachable = False
        print("sloppybus: connected to %s:%d" % (self.host, self.port), file=sys.stderr)
        for fn in self._connect_handlers:
            self._safe_call(fn)
        return True

    def _ensure_connected(self):
        """Connect if not connected and a retry is due (every RECONNECT_INTERVAL).
        Returns True if connected."""
        if self._connected:
            return True
        now = time.monotonic()
        if now >= self._next_reconnect and not self._connect():
            self._next_reconnect = now + RECONNECT_INTERVAL
            if not self._warned_unreachable:
                self._warned_unreachable = True
                print("sloppybus: can't reach the relay at %s:%d - is sloppycan_relay.py running? "
                      "(retrying every %gs)" % (self.host, self.port, RECONNECT_INTERVAL), file=sys.stderr)
        return self._connected

    def _disconnect(self, reason=""):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        if self._connected:
            print("sloppybus: disconnected%s" % (" (" + reason + ")" if reason else ""), file=sys.stderr)
        self._connected = False

    def close(self):
        self._running = False
        self._disconnect()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False

    @staticmethod
    def _safe_call(fn, *args):
        try:
            fn(*args)
        except Exception:
            traceback.print_exc()

    # -- sending ---------------------------------------------------------

    def send(self, id, data=b"", ext=None, rtr=False, dlc=None):
        """Send one frame. `data` may be bytes/bytearray/a list of ints.
        Returns True if written to the socket, False if currently
        disconnected (the frame is dropped and a warning printed once per
        disconnection, not on every call)."""
        if isinstance(data, int):   # bytes(5) would silently be five zero bytes
            raise TypeError("data must be bytes or a list of ints, not a single int - did you mean [%d]?" % data)
        if isinstance(data, (list, tuple)):
            for b in data:
                if not (0 <= b <= 255):
                    raise ValueError("data byte %r out of range 0-255" % (b,))
            data = bytes(data)
        else:
            data = bytes(data)
        line = format_frame(id, data, ext=ext, rtr=rtr, dlc=dlc)

        if not self._ensure_connected():
            if not self._warned_disconnected:
                print("sloppybus: dropping send, not connected: %s" % line, file=sys.stderr)
                self._warned_disconnected = True
            return False
        try:
            self.sock.sendall((line + "\n").encode("ascii"))
            return True
        except OSError:
            self._disconnect("send failed")
            return False

    # -- receiving ---------------------------------------------------------

    def _pump_socket(self, timeout):
        """Wait up to `timeout` seconds for data (or a connection error),
        read what's available, and return a list of newly parsed Frames.
        Handles reconnects. Returns [] on timeout or while disconnected."""
        if not self._ensure_connected():
            if timeout:
                time.sleep(min(timeout, RECONNECT_INTERVAL))
            return []

        try:
            r, _, _ = select.select([self.sock], [], [], timeout)
        except OSError:
            self._disconnect("select failed")
            return []
        if not r:
            return []

        try:
            chunk = self.sock.recv(65536)
        except (BlockingIOError, InterruptedError):
            return []
        except OSError:
            self._disconnect("recv failed")
            return []
        if not chunk:
            self._disconnect("connection closed")
            return []

        self._buf += chunk
        lines = self._buf.split(b"\n")
        self._buf = lines.pop()  # keep the partial trailing line
        frames = []
        for raw in lines:
            text = raw.decode("ascii", errors="ignore")
            f = parse_line(text)
            if f is not None:
                frames.append(f)
        return frames

    def recv(self, timeout=None, id=None):
        """Linear-script style: block for the next Frame (optionally only
        one matching `id`), or return None after `timeout` seconds. Does
        NOT dispatch on_any/on/every/on_connect callbacks - use run() for
        that instead. Connects lazily and reconnects as needed."""
        deadline = None if timeout is None else time.monotonic() + timeout
        pumped = False
        while True:
            # One socket read can carry many frames: hand them out one per call.
            while self._pending:
                f = self._pending.popleft()
                if id is None or f.id == id:
                    return f
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0 and pumped:
                return None
            self._pending.extend(self._pump_socket(1.0 if remaining is None else max(0.0, remaining)))
            pumped = True

    # -- main loop ---------------------------------------------------------

    def _dispatch(self, frame):
        for fn in self._any_handlers:
            self._safe_call(fn, frame)
        for id_set, ext, fn in self._id_handlers:
            if frame.id not in id_set:
                continue
            if ext is not None and frame.ext != ext:
                continue
            self._safe_call(fn, frame)

    def _run_due_periodics(self):
        now = time.monotonic()
        for task in self._periodic:
            period, deadline, fn = task
            if now < deadline:
                continue
            self._safe_call(fn)
            # advance in fixed steps from the previous deadline (drift-free);
            # if we're more than one period behind, skip ahead instead of
            # bursting through every missed tick.
            deadline += period
            if deadline < now:
                deadline = now + period
            task[1] = deadline

    def _next_deadline(self):
        if not self._periodic:
            return None
        return min(task[1] for task in self._periodic)

    def run(self):
        """Block forever, dispatching received frames to on_any/on
        handlers and running every()/on_connect callbacks. Ctrl+C exits
        cleanly. Auto-reconnects to the relay every second while it's
        unreachable; periodic tasks keep firing even while disconnected."""
        self._running = True
        try:
            while self._running:
                next_deadline = self._next_deadline()
                if next_deadline is None:
                    timeout = RECONNECT_INTERVAL if not self._connected else 1.0
                else:
                    timeout = max(0.0, next_deadline - time.monotonic())
                    if not self._connected:
                        timeout = min(timeout, RECONNECT_INTERVAL)
                for frame in self._pump_socket(timeout):
                    self._dispatch(frame)
                self._run_due_periodics()
        except KeyboardInterrupt:
            pass
        finally:
            self._disconnect()
