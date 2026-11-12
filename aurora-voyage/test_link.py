"""测试升级版 eeg_receiver.py：OSC(8000) -> 眨眼+脑电 -> WS(7000) -> 客户端"""
import asyncio
import json

from pythonosc.udp_client import SimpleUDPClient
from websockets.asyncio.client import connect

client = SimpleUDPClient("127.0.0.1", 8000)


async def main():
    blinks = []
    eeg_batches = []
    async with connect("ws://127.0.0.1:7000") as ws:
        print("[TEST] WebSocket 已连接到 7000")
        # 1) 眨眼链路
        client.send_message("/ABC123/elements/blink", 1)
        await asyncio.sleep(0.05)
        client.send_message("/ABC123/elements/blink", 0)
        # 2) 脑电链路：模拟 5 通道、220Hz 采样，持续 0.5 秒
        import math
        for i in range(110):
            v = 30 * math.sin(i * 0.4) + (400 if 40 < i < 46 else 0)  # 假装中间有个眨眼尖峰
            client.send_message("/ABC123/elements/eeg", [v, v * 1.2, v * 0.8, v, 0.0])
            await asyncio.sleep(0.004)
        # 3) 收结果：固定收集 2 秒
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
    ok_blink = any(b["blink"] is True for b in blinks) and any(b["blink"] is False for b in blinks)
    total = sum(len(b) for b in eeg_batches)
    print(f"[TEST] 眨眼信号: {'PASS' if ok_blink else 'FAIL'} ({blinks})")
    print(f"[TEST] 脑电数据: 收到 {len(eeg_batches)} 批共 {total} 个样本，示例: {eeg_batches[0][:6] if eeg_batches else '无'}")
    print("[TEST] 总结果:", "PASS" if ok_blink and total > 50 else "FAIL")


if __name__ == "__main__":
    asyncio.run(main())
