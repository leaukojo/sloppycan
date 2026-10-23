"""
example.py - template showing each sloppybus.py feature. Copy this file as
a starting point for your own script.

How to run:
    1. Start the relay:           python sloppycan_relay.py
    2. In sloppyCAN, click the "Script" button (top right), then Connect.
    3. Run this file:             python example.py

Smaller single-purpose examples: example_dump.py (print every frame) and
example_send_every_1s.py (send one frame every second).
"""

import os
import sys

# Make `import sloppybus` work no matter what directory this is run from,
# as long as sloppybus.py sits next to this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sloppybus import Bus

bus = Bus()
counts = {}  # id -> number of frames seen since the last report


@bus.on_any  # runs on ANY received frame
def count(f):
    counts[f.id] = counts.get(f.id, 0) + 1


_last_brake = None


@bus.on(0x024)  # runs only on id 0x024 (RAMN brake pedal)
def brake(f):
    global _last_brake
    # RAMN brake pedal: 12-bit big-endian value in bytes 0-1, 0x000..0xFFF
    # maps to 0..100%. Guard against short/garbage frames (and remote
    # frames, which carry no data) before indexing into f.data.
    if f.rtr or len(f.data) < 2:
        return
    raw = (f.data[0] << 8 | f.data[1]) & 0xFFF
    pct = round(raw / 0xFFF * 100)
    # React: republish the brake position as a plain percentage on a new id -
    # only when it changes, since 0x024 itself arrives every 10 ms.
    if pct != _last_brake:
        _last_brake = pct
        bus.send(0x3E0, [pct])


_heartbeat_n = 0


@bus.every(0.1)  # runs every 100 ms
def heartbeat():
    global _heartbeat_n
    _heartbeat_n = (_heartbeat_n + 1) % 256
    bus.send(0x123, [_heartbeat_n, 0xDE, 0xAD])


@bus.every(1.0)  # runs once a second
def report():
    if counts:
        summary = ", ".join("%03X:%d" % (i, n) for i, n in sorted(counts.items()))
        print("seen: " + summary)
    counts.clear()


@bus.on_connect  # one-shot sends each time the link comes up (including reconnects)
def hello():
    bus.send(0x7DF, [0x02, 0x01, 0x0C, 0, 0, 0, 0, 0])  # 11-bit: OBD-II "engine RPM?" request
    bus.send(0x18FEF100, bytes(8), ext=True)            # 29-bit: J1939 CCVS, all zero
    bus.send(0x321, rtr=True, dlc=4)                    # remote frame requesting 4 bytes


# --- Steering the Carlito car via RAMN steering id 0x062 ---------------
# Uncomment to try it. 12-bit big-endian value in bytes 0-1: 0x000 = full
# left, 0x7FF = centre, 0xFFF = full right; bytes 2-7 unused (send zero).
#
# In sloppyCAN Demo mode, first click "Disable traffic" in the RAMN Control
# Panel - otherwise the demo's own 0x062 frames (sent every 10 ms) fight
# this script for the wheel.
#
# import math, time
# _steer_t0 = time.monotonic()
#
# @bus.every(0.02)  # 50 Hz sine sweep, full lock to full lock
# def steer_sweep():
#     t = time.monotonic() - _steer_t0
#     frac = (math.sin(t) + 1) / 2       # 0..1
#     raw = round(frac * 0xFFF)
#     bus.send(0x062, [raw >> 8, raw & 0xFF, 0, 0, 0, 0, 0, 0])

bus.run()
