"""
example_dump.py - print every CAN frame on the bus, candump style.

Shows the linear recv() style (no callbacks): just loop and read. You see
everything sloppyCAN sees (adapter RX, Demo traffic, Carlito telemetry, and
what sloppyCAN transmits) plus what other scripts send.

How to run:
    1. Start the relay:           python sloppycan_relay.py
    2. In sloppyCAN, click the "Script" button (top right), then Connect.
    3. Run this file:             python example_dump.py     (Ctrl+C to stop)

Output:
    15:30:01.123       024  [8]  0F A0 00 01 77 E2 C3 D4
    15:30:01.124  18FEF100  [8]  00 00 00 00 00 00 00 00
    15:30:01.130       321  [4]  remote request
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sloppybus import Bus


def show(f):
    stamp = time.strftime("%H:%M:%S", time.localtime(f.ts)) + ".%03d" % int(f.ts % 1 * 1000)
    ident = ("%08X" if f.ext else "%03X") % f.id
    body = "remote request" if f.rtr else " ".join("%02X" % b for b in f.data)
    print("%s  %8s  [%d]  %s" % (stamp, ident, f.dlc, body))


try:
    with Bus() as bus:
        while True:
            show(bus.recv())   # blocks until the next frame
except KeyboardInterrupt:
    pass
