"""Link self-test for eeg_receiver.py: OSC(8000) -> blink + EEG -> WS(7000) -> client.

Run this AFTER starting the receiver (e.g. double-click start_receiver.bat).

Usage:
    python test_link.py
"""
import asyncio
import json
import sys

# Make stdout UTF-8 on Windows so non-ASCII logs don't garble.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from pythonosc.udp_client import SimpleUDPClient
from websockets.asyncio.client import connect

OSC_HOST = "127.0.0.1"
OSC_PORT = 8000
WS_URL = "ws://127.0.0.1:7000"

client = SimpleUDPClient(OSC_HOST, OSC_PORT)


async def main():
    blinks = []
    eeg_batches = []

    async with connect(WS_URL) as ws:
        print("[TEST] WebSocket connected to %s" % WS_URL)

        # 1) Blink link: send a rising edge (1) then falling edge (0)
        client.send_message("/ABC123/elements/blink", 1)
        await asyncio.sleep(0.05)
        client.send_message("/ABC123/elements/blink", 0)

        # 2) EEG link: simulate 5 channels, ~220Hz, for 0.5s
        import math
        for i in range(110):
            v = 30 * math.sin(i * 0.4) + (400 if 40 < i < 46 else 0)  # fake blink spike in the middle
            client.send_message("/ABC123/elements/eeg", [v, v * 1.2, v * 0.8, v, 0.0])
            await asyncio.sleep(0.004)

        # 3) Collect results for up to 2 seconds
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
                d = json.loads(msg)
                if "blink" in d:
                    blinks.append(d)
                elif "eeg" in d:
                    eeg_batches.append(d["eeg"])
        except asyncio.TimeoutError:
            pass

    saw_rise = any(b.get("blink") is True for b in blinks)
    saw_fall = any(b.get("blink") is False for b in blinks)
    ok_blink = saw_rise and saw_fall
    total = sum(len(b) for b in eeg_batches)
    ok_eeg = total > 50

    print("[TEST] Blink signal : %s (rise=%s, fall=%s)"
          % ("PASS" if ok_blink else "FAIL", saw_rise, saw_fall))
    sample = eeg_batches[0][:6] if eeg_batches else []
    print("[TEST] EEG data     : %s (%d batches, %d samples, sample=%s)"
          % ("PASS" if ok_eeg else "FAIL", len(eeg_batches), total, sample))
    print("[TEST] Result       :", "PASS" if ok_blink and ok_eeg else "FAIL")


if __name__ == "__main__":
    asyncio.run(main())
