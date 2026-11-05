# -*- coding: utf-8 -*-
"""
眨眼 → 跳跃 桥接器  bridge.py
=====================================================================
把 blink_detector 的检测结果变成 Flappy Bird 能消费的"起跳指令"。

两种用法
    1) 离线：CSV 跑检测 → 输出 jumps.json（可直接粘贴进网页的时间点输入框）
         py bridge.py detect 脑电.csv -o jumps.json

    2) 实时：起一个 WebSocket 服务，按时间轴把眨眼事件推给网页
         py bridge.py serve jumps.json --port 8765 --speed 1.0

网页端收到的消息格式
    {"type":"blink","t":1.500,"floor":1.5,"score":6.3}
    {"type":"ready","count":3}
    {"type":"done"}

设计要点
    * 检测器输出的是**峰值时刻**（回溯），实时场景里事件是"事后确认"的，
      所以消息里带 floor 字段：网页应按 floor 判断"这一跳属于哪个时间窗"。
    * 眨眼频率远低于游戏所需起跳频率，实际接入请用 mode=gate 或 boost，
      见 README 讨论。默认推送不替用户做这个决定，只给事件流。
=====================================================================
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "blink-detector"))

import blink_detector as bd  # noqa: E402


def detect_file(path, k=3.0, gate=2.0, polarity="auto", band=(0.5, 8.0)):
    """CSV → (时间轴, 眨眼峰值时刻列表, 峰值强度列表, 元信息)。"""
    header, t, fs, chans = bd.load_and_prepare(path)
    res, score, note = bd.detect(chans, fs, k=k, gate=gate,
                                 polarity=polarity, band=band)
    pk = res["peak_idx"]
    times = [round(float(t[p]), 4) for p in pk]
    amps = [round(float(a), 2) for a in res["score"]]
    meta = {
        "fs": fs,
        "duration_s": round(float(t[-1] - t[0]), 3),
        "channels": list(chans.keys()),
        "polarity": note,
        "k": k,
        "gate": gate,
        "n": len(times),
    }
    return t, times, amps, meta


def cmd_detect(args):
    t, times, amps, meta = detect_file(args.input, k=args.k, gate=args.gate,
                                       polarity=args.polarity)
    out = {
        "source": os.path.abspath(args.input),
        "meta": meta,
        "blinks": times,
        "amps": amps,
    }
    path = args.out or os.path.join(os.getcwd(), "jumps.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("检测到 %d 次眨眼" % len(times))
    print("时间点：%s" % ", ".join("%.3f" % v for v in times))
    print("已写入：%s" % os.path.abspath(path))
    print("提示：把上面的时间点直接粘贴进网页的『起跳时间点』输入框即可离线回放。")
    return 0


async def _serve(args, payload):
    import websockets

    blinks = payload["blinks"]
    amps = payload.get("amps") or [0.0] * len(blinks)

    async def handler(ws):
        print("[连接] %s" % (getattr(ws, "remote_address", "?"),))
        await ws.send(json.dumps({"type": "ready", "count": len(blinks)}))
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        origin = blinks[0] - args.lead if blinks else 0.0
        for i, bt in enumerate(blinks):
            # 按原始时间轴回放，speed 倍速
            delay = (bt - origin) / args.speed
            now = loop.time() - t0
            if delay > now:
                await asyncio.sleep(delay - now)
            msg = {
                "type": "blink",
                "t": bt,
                "floor": round(bt, 1),
                "score": amps[i] if i < len(amps) else 0.0,
            }
            await ws.send(json.dumps(msg))
            print("[推送] t=%.3f score=%.2f" % (bt, msg["score"]))
        await ws.send(json.dumps({"type": "done"}))
        print("[完成] 事件推送结束")

    async with websockets.serve(handler, args.host, args.port):
        print("WebSocket 已启动：ws://%s:%d  事件数=%d  倍速=%.2fx"
              % (args.host, args.port, len(blinks), args.speed))
        print("在网页里点击『连接实时信号』即可。Ctrl+C 退出。")
        await asyncio.Future()


def cmd_serve(args):
    if not os.path.isfile(args.json):
        print("[错误] 找不到事件文件：%s" % args.json)
        return 2
    with open(args.json, encoding="utf-8") as f:
        payload = json.load(f)
    if not payload.get("blinks"):
        print("[警告] 事件列表为空，仍会启动服务但不会推送。")
    try:
        asyncio.run(_serve(args, payload))
    except KeyboardInterrupt:
        print("\n已停止。")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="眨眼事件 → Flappy Bird 起跳指令")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("detect", help="对 EEG CSV 跑检测，输出 jumps.json")
    d.add_argument("input", help="EEG 数据 CSV")
    d.add_argument("-o", "--out", default=None, help="输出 JSON 路径")
    d.add_argument("--k", type=float, default=3.0)
    d.add_argument("--gate", type=float, default=2.0)
    d.add_argument("--polarity", default="auto",
                   choices=["auto", "neg", "pos", "both"])
    d.set_defaults(func=cmd_detect)

    s = sub.add_parser("serve", help="启动 WebSocket 回放服务")
    s.add_argument("json", help="jumps.json")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--speed", type=float, default=1.0, help="回放倍速")
    s.add_argument("--lead", type=float, default=0.5, help="首事件前的准备时间(s)")
    s.set_defaults(func=cmd_serve)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
