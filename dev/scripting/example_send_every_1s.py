"""
example_send_every_1s.py - send one CAN frame every second.

The frame appears in sloppyCAN's ID list as FW, and goes out on the wire too
when a bus is open and Listen-only is off.

How to run:
    1. Start the relay:           python sloppycan_relay.py
    2. In sloppyCAN, click the "Script" button (top right), then Connect.
    3. Run this file:             python example_send_every_1s.py     (Ctrl+C to stop)
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sloppybus import Bus

bus = Bus()
counter = 0


@bus.every(1.0)  # runs once a second
def send_status():
    global counter
    counter = (counter + 1) % 256
    # id 0x456, 4 data bytes: a rolling counter, then three fixed bytes.
    # For a 29-bit id pass ext=True, e.g. bus.send(0x18FF0010, [...], ext=True).
    if bus.send(0x456, [counter, 0x11, 0x22, 0x33]):
        print("sent 456#%02X112233" % counter)


bus.run()
