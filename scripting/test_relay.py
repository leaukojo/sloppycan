"""
test_relay.py - end-to-end tests for sloppycan_relay.py (stdlib unittest only).

Starts the relay as a subprocess on free ports and talks to it over real sockets:
a script line reaches a WebSocket client, and the three ways a web page could
reach the bus through it (an HTTP request on the TCP port, a WS handshake from
a foreign Origin, a WS handshake with a rebound Host) are refused.

    python -m unittest scripting/test_relay.py    (or: python scripting/test_relay.py)
"""

import base64
import os
import socket
import subprocess
import sys
import time
import unittest

RELAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sloppycan_relay.py")
GOOD_ORIGIN = "http://localhost:8000"
LINE = b"123#DEADBEEF\n"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def connect(port, timeout=2.0):
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.settimeout(timeout)
    return s


def ws_handshake(port, origin=GOOD_ORIGIN, host=None):
    """Open a WS connection; returns (socket, status line)."""
    s = connect(port)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        "GET / HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Origin: %s\r\n\r\n" % (host or "127.0.0.1:%d" % port, key, origin)
    )
    s.sendall(req.encode("ascii"))
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = s.recv(4096)
        if not chunk:
            break
        head += chunk
    return s, head.split(b"\r\n", 1)[0].decode("ascii", "replace")


def ws_read_text(s):
    """Read one unmasked server text frame; returns its payload, or None on timeout/EOF."""
    try:
        hdr = s.recv(2)
        if len(hdr) < 2:
            return None
        n = hdr[1] & 0x7F
        if n == 126:
            n = int.from_bytes(s.recv(2), "big")
        payload = b""
        while len(payload) < n:
            chunk = s.recv(n - len(payload))
            if not chunk:
                break
            payload += chunk
        return payload
    except socket.timeout:
        return None


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.ws_port, self.tcp_port = free_port(), free_port()
        self.proc = subprocess.Popen(
            [sys.executable, RELAY, "--ws-port", str(self.ws_port), "--tcp-port", str(self.tcp_port)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        for port in (self.ws_port, self.tcp_port):
            while True:
                try:
                    connect(port, 0.5).close()
                    break
                except OSError:
                    if time.monotonic() > deadline or self.proc.poll() is not None:
                        self.fail("relay did not start listening on %d" % port)
                    time.sleep(0.1)
        self.socks = []

    def tearDown(self):
        for s in self.socks:
            s.close()
        self.proc.kill()
        self.proc.wait()

    def listener(self):
        """A WS client from an allowed origin, registered with the hub."""
        s, status = ws_handshake(self.ws_port)
        self.socks.append(s)
        self.assertIn(" 101 ", status)
        time.sleep(0.3)   # the hub adds the client just after the 101 goes out
        return s

    def assert_rejected_http(self, request):
        ws = self.listener()
        ws.settimeout(0.8)
        tcp = connect(self.tcp_port)
        self.socks.append(tcp)
        tcp.sendall(request)
        try:
            self.assertEqual(tcp.recv(1024), b"", "relay answered an HTTP request instead of closing")
        except ConnectionError:
            pass   # a reset is a close too
        except socket.timeout:
            self.fail("relay kept an HTTP request's connection open")
        self.assertIsNone(ws_read_text(ws), "an HTTP request's body reached the WebSocket client")

    def test_script_line_reaches_websocket(self):
        ws = self.listener()
        tcp = connect(self.tcp_port)
        self.socks.append(tcp)
        tcp.sendall(LINE)
        self.assertEqual(ws_read_text(ws), LINE)

    def test_short_post_rejected(self):
        self.assert_rejected_http(
            b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 13\r\n\r\n" + LINE)

    def test_long_path_post_rejected(self):
        self.assert_rejected_http(
            b"POST /" + b"a" * 200 + b" HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 13\r\n\r\n" + LINE)

    def test_lowercase_method_rejected(self):
        self.assert_rejected_http(
            b"patch / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 13\r\n\r\n" + LINE)

    def test_ws_bad_origin_rejected(self):
        s, status = ws_handshake(self.ws_port, origin="https://evil.example")
        self.socks.append(s)
        self.assertIn(" 403 ", status)

    def test_ws_bad_host_rejected(self):
        s, status = ws_handshake(self.ws_port, host="evil.example:%d" % self.ws_port)
        self.socks.append(s)
        self.assertIn(" 403 ", status)


if __name__ == "__main__":
    unittest.main()
