#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bridge.py — 眨眼事件桥接器（纯标准库，零依赖）
=====================================================================
把 EEG 眨眼检测结果变成网页游戏能消费的「起跳指令」。

两个子命令
    # 1) 离线检测：CSV → jumps.json
    python3 tools/bridge.py detect ../../EEG-EyeBlinks\\ 5/EEG-IO/S00_data.csv

    # 2) 实时回放：起 WebSocket 服务，按原始时间轴推给网页
    python3 tools/bridge.py serve jumps.json --port 8765 --speed 1.0

    网页端：信号源选「Python 桥接器（WebSocket）」，地址 ws://127.0.0.1:8765

推送协议（与 js/sources.js 的 WsSource 对齐）
    {"type":"ready","count":25}
    {"type":"blink","t":4.42,"score":6.31}
    {"type":"done"}

为什么不用再装库
    * 本文件只用 Python 标准库（socket / struct / hashlib / base64）。
    * 内置与 js/detector.js 同构的因果检测器：一阶带通 → 滑动稳健基线
      → 双通道同向合成 → 双阈值 + 不应期。
    * 若本机已装 numpy + scipy，加 `--engine py` 可改走
      ../blink-detector/blink_detector.py（离线版本，指标更高）。
=====================================================================
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import socket
import struct
import sys
import threading
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
REPO = os.path.dirname(PROJECT)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


# ------------------------------------------------------------------ #
#  一、CSV 读取（自动适配 EEG-IO 与 OpenBCI 两种格式）
# ------------------------------------------------------------------ #
def parse_eeg_csv(path):
    """返回 dict(t, fs, ch0, ch1, names, format)。"""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        lines = f.read().splitlines()

    comments, body = [], []
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if s[0] in "%#":
            comments.append(s)
        else:
            body.append(ln)
    if not body:
        raise ValueError("文件里没有数据行：%s" % path)

    head = body[0]
    sep = max((";", ",", "\t"), key=lambda d: head.count(d))
    if head.count(sep) == 0:
        sep = ","

    fs = None
    for c in comments:
        low = c.lower()
        if "sample rate" in low or "sampling rate" in low or "采样率" in c:
            tail = c.split("=")[-1] if "=" in c else c
            num = "".join(ch if (ch.isdigit() or ch in ".-") else " " for ch in tail)
            for tok in num.split():
                try:
                    v = float(tok)
                    if v > 0:
                        fs = v
                        break
                except ValueError:
                    pass
        if fs:
            break

    def to_nums(cells):
        out = []
        for c in cells:
            try:
                out.append(float(c))
            except ValueError:
                out.append(float("nan"))
        return out

    first = to_nums(head.split(sep))
    n_num = sum(1 for v in first if v == v)
    has_header = n_num < max(1, len(first) // 2)

    names = [c.strip() for c in head.split(sep)] if has_header else []
    data_lines = body[1:] if has_header else body
    rows = []
    for ln in data_lines:
        vals = to_nums(ln.split(sep))
        if any(v == v for v in vals):
            rows.append(vals)
    if not rows:
        raise ValueError("没有可解析的数值行")

    ncol = max(len(r) for r in rows)
    for r in rows:
        r.extend([float("nan")] * (ncol - len(r)))

    # 时间列 / 采样率列
    tcol = 0
    fscol = -1
    if has_header:
        for i, h in enumerate(names):
            hl = h.lower()
            if ("sampling" in hl and "rate" in hl) or "采样率" in h:
                fscol = i
            if i == 0 and ("time" in hl or "时间" in h):
                tcol = 0
    if fs is None and fscol >= 0:
        v = rows[0][fscol]
        if v == v and v > 0:
            fs = v

    # 通道列：优先 Fp1/Fp2，否则跳过时间列取前两路
    c0, c1 = 1, 2
    fmt = "OpenBCI 原始数据" if comments else "通用 CSV"
    if has_header and len(names) > 2:
        fp1 = next((i for i, h in enumerate(names) if h.lower().startswith("fp1")), -1)
        fp2 = next((i for i, h in enumerate(names) if h.lower().startswith("fp2")), -1)
        if fp1 >= 0 and fp2 >= 0:
            c0, c1 = fp1, fp2
        fmt = "表头 CSV（%s 分隔）" % sep
    if ncol <= 2:
        c0 = c1 = ncol - 1

    # 时间轴 + 采样率
    t_raw = [r[tcol] for r in rows]
    looks_index = (
        len(t_raw) > 2
        and abs(t_raw[0]) < 1e-9
        and abs(t_raw[1] - 1) < 1e-6
        and abs(t_raw[2] - 2) < 1e-6
    )
    if fs is None or fs <= 0:
        if not looks_index:
            dts = sorted(
                t_raw[i] - t_raw[i - 1]
                for i in range(1, min(len(t_raw), 2000))
                if t_raw[i] - t_raw[i - 1] > 0
            )
            fs = 1.0 / dts[len(dts) // 2] if dts else 250.0
        else:
            fs = 250.0
    fs = float(fs)

    if looks_index:
        t = [i / fs for i in range(len(rows))]
    else:
        t0 = t_raw[0]
        t = [(v - t0) if v == v else i / fs for i, v in enumerate(t_raw)]

    ch0 = [r[c0] for r in rows]
    ch1 = [r[c1] for r in rows]
    _fill_nan(ch0)
    _fill_nan(ch1)

    ch_names = ["CH1", "CH2"]
    if names and max(c0, c1) < len(names):
        ch_names = [names[c0], names[c1]]

    return {
        "t": t, "fs": fs, "ch0": ch0, "ch1": ch1,
        "names": ch_names, "format": fmt,
        "duration": (t[-1] - t[0]) if t else 0.0,
    }


def _fill_nan(arr):
    first = next((i for i, v in enumerate(arr) if v == v), -1)
    if first < 0:
        for i in range(len(arr)):
            arr[i] = 0.0
        return
    for i in range(first):
        arr[i] = arr[first]
    i = first + 1
    while i < len(arr):
        if arr[i] != arr[i]:
            j = i + 1
            while j < len(arr) and arr[j] != arr[j]:
                j += 1
            prev = arr[i - 1]
            nxt = arr[j] if j < len(arr) else prev
            span = j - i + 1
            for k in range(i, j):
                arr[k] = prev + (nxt - prev) * (k - i + 1) / span
            i = j
        else:
            i += 1


# ------------------------------------------------------------------ #
#  二、检测器（与 js/detector.js 同构的因果实现）
# ------------------------------------------------------------------ #
def _median(vals):
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return 0.0
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


class Biquad:
    """RBJ 双二阶（Transposed DF-II），与 js/filter.js 同系数。"""

    def __init__(self, b0, b1, b2, a1, a2):
        self.b0, self.b1, self.b2 = b0, b1, b2
        self.a1, self.a2 = a1, a2
        self.z1 = self.z2 = 0.0

    def step(self, x):
        y = self.b0 * x + self.z1
        self.z1 = self.b1 * x - self.a1 * y + self.z2
        self.z2 = self.b2 * x - self.a2 * y
        return y

    @staticmethod
    def highpass(fs, f0, q=0.7071):
        w0 = 2 * math.pi * f0 / fs
        cw, sw = math.cos(w0), math.sin(w0)
        al = sw / (2 * q)
        a0 = 1 + al
        return Biquad((1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0,
                      -2 * cw / a0, (1 - al) / a0)

    @staticmethod
    def lowpass(fs, f0, q=0.7071):
        w0 = 2 * math.pi * f0 / fs
        cw, sw = math.cos(w0), math.sin(w0)
        al = sw / (2 * q)
        a0 = 1 + al
        return Biquad((1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0,
                      -2 * cw / a0, (1 - al) / a0)

    @staticmethod
    def notch(fs, f0, q=30.0):
        w0 = 2 * math.pi * f0 / fs
        cw, sw = math.cos(w0), math.sin(w0)
        al = sw / (2 * q)
        a0 = 1 + al
        return Biquad(1 / a0, -2 * cw / a0, 1 / a0, -2 * cw / a0, (1 - al) / a0)


def _causal_z(data, band, baseline_s, notch_hz):
    """一遍因果滤波 + 滑动稳健基线，返回 (z0, z1) 数组。"""
    fs = data["fs"]
    n = len(data["ch0"])
    hp = band[0]
    lp = min(band[1], fs / 2.0 * 0.95)

    chains = []
    for _ in range(2):
        st = [Biquad.highpass(fs, hp), Biquad.lowpass(fs, lp)]
        if fs > 2 * notch_hz:
            st.insert(0, Biquad.notch(fs, notch_hz))
        chains.append(st)

    win = max(32, int(baseline_s * fs))
    hop = max(1, int(0.1 * fs))
    bufs = [deque(maxlen=win), deque(maxlen=win)]
    stats = [(0.0, 1.0), (0.0, 1.0)]
    hop_count = 0
    ready = False
    z0 = [0.0] * n
    z1 = [0.0] * n

    for i in range(n):
        ys = []
        for c in range(2):
            y = data["ch0"][i] if c == 0 else data["ch1"][i]
            if y != y:
                y = bufs[c][-1] if bufs[c] else 0.0
            for f in chains[c]:
                y = f.step(y)
            bufs[c].append(y)
            ys.append(y)

        hop_count += 1
        if hop_count >= hop or not ready:
            hop_count = 0
            if len(bufs[0]) >= min(48, win * 0.5):
                for c in range(2):
                    vals = list(bufs[c])
                    med = _median(vals)
                    mad = _median([abs(v - med) for v in vals])
                    stats[c] = (med, max(1.4826 * mad, 1e-6))
                ready = True

        z0[i] = (ys[0] - stats[0][0]) / stats[0][1]
        z1[i] = (ys[1] - stats[1][0]) / stats[1][1]

    return z0, z1


def _estimate_polarity(z0, z1, gate=2.0):
    """用双通道同时、同向的强事件做幅度加权符号投票。返回 -1 / +1。"""
    pos = neg = 0.0
    for a, b in zip(z0, z1):
        if a * b <= 0:
            continue
        mag = min(abs(a), abs(b))
        if mag <= gate:
            continue
        if a > 0:
            pos += mag
        else:
            neg += mag
    return -1 if neg >= pos else 1


def detect_blinks(data, threshold=3.4, gate=2.0, refractory_s=0.4,
                  band=(0.5, 8.0), baseline_s=1.5, min_dur_s=0.06,
                  max_dur_s=0.7, warmup_s=1.2, notch_hz=50.0):
    """返回 [(峰值时刻秒, 得分), ...]。

    两步：先用因果链路算 z 分数并估计极性（离线可看全段，更稳），
    再用确定的极性跑双阈值状态机。实时场景等价于「前几秒自动学极性」。
    """
    fs = data["fs"]
    t = data["t"]
    n = len(t)

    z0, z1 = _causal_z(data, band, baseline_s, notch_hz)
    pol = _estimate_polarity(z0, z1, gate)

    low = threshold * 0.45
    state = "idle"
    onset_t = 0.0
    peak_s = 0.0
    peak_t = 0.0
    last_end_t = -1e9
    events = []

    for i in range(n):
        ti = t[i]
        a = z0[i] * pol
        b = z1[i] * pol
        # 两路都必须同向超过门限，取较强一路作为得分
        s = max(a, b) if (a > gate and b > gate) else -1.0

        if ti < warmup_s:
            continue

        if state == "idle":
            if s > threshold:
                state = "active"
                onset_t = ti
                peak_s, peak_t = s, ti
        else:
            if s > peak_s:
                peak_s, peak_t = s, ti
            dur = ti - onset_t
            if s < low or dur > max_dur_s:
                if dur >= min_dur_s and (ti - last_end_t) >= refractory_s:
                    last_end_t = ti
                    events.append((peak_t, peak_s))
                state = "idle"

    return events


# ------------------------------------------------------------------ #
#  三、WebSocket（标准库最小实现，服务端只发不收）
# ------------------------------------------------------------------ #
def _ws_frame(payload: bytes, opcode=0x1) -> bytes:
    head = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += struct.pack(">H", n)
    else:
        head.append(127)
        head += struct.pack(">Q", n)
    return bytes(head) + payload


def _ws_handshake(conn) -> bool:
    data = b""
    conn.settimeout(5.0)
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return False
        data += chunk
        if len(data) > 65536:
            return False
    key = ""
    for line in data.decode("latin-1").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
            break
    if not key:
        return False
    accept = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("latin-1")).digest()
    ).decode()
    conn.sendall(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
        ).encode("latin-1")
    )
    conn.settimeout(None)
    return True


def _serve_client(conn, addr, events, speed, lead):
    try:
        if not _ws_handshake(conn):
            conn.close()
            return
        print("[连接] %s:%s" % addr)
        conn.sendall(_ws_frame(json.dumps({"type": "ready", "count": len(events)}).encode()))

        if not events:
            conn.sendall(_ws_frame(json.dumps({"type": "done"}).encode()))
            return

        origin = max(0.0, events[0][0] - lead)
        t_start = time.monotonic()
        for t_ev, score in events:
            target = (t_ev - origin) / max(speed, 1e-6)
            now = time.monotonic() - t_start
            if target > now:
                time.sleep(target - now)
            msg = {"type": "blink", "t": round(t_ev, 3), "score": round(score, 2)}
            conn.sendall(_ws_frame(json.dumps(msg).encode()))
            print("[推送] t=%.3f  score=%.2f" % (t_ev, score))

        conn.sendall(_ws_frame(json.dumps({"type": "done"}).encode()))
        print("[完成] 事件推送结束 %s:%s" % addr)
    except (BrokenPipeError, ConnectionResetError, socket.timeout):
        print("[断开] %s:%s" % addr)
    finally:
        try:
            conn.close()
        except OSError:
            pass


def serve(events, host="127.0.0.1", port=8765, speed=1.0, lead=0.5):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(8)
    print("=" * 58)
    print("  WebSocket 已启动：ws://%s:%d" % (host, port))
    print("  事件数：%d   倍速：%.2fx" % (len(events), speed))
    print("  网页里选「Python 桥接器（WebSocket）」即可连接")
    print("  Ctrl+C 停止")
    print("=" * 58)
    try:
        while True:
            conn, addr = srv.accept()
            threading.Thread(
                target=_serve_client, args=(conn, addr, events, speed, lead), daemon=True
            ).start()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.close()


# ------------------------------------------------------------------ #
#  四、CLI
# ------------------------------------------------------------------ #
def cmd_detect(args):
    data = parse_eeg_csv(args.input)
    if args.engine == "py":
        try:
            sys.path.insert(0, os.path.join(REPO, "blink-detector"))
            import blink_detector as bd  # noqa: F401
            header, t, fs, chans = bd.load_and_prepare(args.input)
            res, score, note = bd.detect(chans, fs, k=args.threshold,
                                         refractory_s=args.refractory,
                                         polarity="auto")
            times = [float(t[p]) for p in res["peak_idx"]]
            amps = [float(a) for a in res["score"]]
            note_pol = note
        except Exception as e:  # 退回内置实现
            print("[提示] 调用 blink_detector.py 失败（%s），改用内置检测器。" % e)
            args.engine = "std"
    if args.engine != "py":
        ev = detect_blinks(
            data,
            threshold=args.threshold,
            refractory_s=args.refractory,
            band=(args.band_lo, args.band_hi),
        )
        times = [e[0] for e in ev]
        amps = [e[1] for e in ev]
        note_pol = "自动"

    payload = {
        "source": os.path.abspath(args.input),
        "meta": {
            "fs": data["fs"],
            "duration_s": round(data["duration"], 3),
            "channels": data["names"],
            "format": data["format"],
            "n": len(times),
            "threshold": args.threshold,
            "refractory_s": args.refractory,
            "polarity": note_pol,
            "engine": args.engine,
        },
        "blinks": [round(v, 4) for v in times],
        "amps": [round(a, 2) for a in amps],
    }
    out = args.out or os.path.join(os.getcwd(), "jumps.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print("格式：%s   采样率：%.0f Hz   时长：%.1f s   通道：%s"
          % (data["format"], data["fs"], data["duration"], "/".join(data["names"])))
    print("检测到 %d 次眨眼" % len(times))
    if times:
        print("时间点（秒）：" + ", ".join("%.2f" % v for v in times[:20])
              + (" ..." if len(times) > 20 else ""))
    print("已写入：%s" % os.path.abspath(out))

    if args.serve:
        serve(_load_events(payload), port=args.port, speed=args.speed)
    return 0


def _load_events(payload):
    blinks = payload.get("blinks") or []
    amps = payload.get("amps") or [0.0] * len(blinks)
    return [(float(t), float(amps[i]) if i < len(amps) else 0.0)
            for i, t in enumerate(blinks)]


def cmd_serve(args):
    if not os.path.isfile(args.json):
        print("[错误] 找不到事件文件：%s" % args.json)
        return 2
    with open(args.json, encoding="utf-8") as f:
        payload = json.load(f)
    events = _load_events(payload)
    if not events:
        print("[警告] 事件列表为空，启动后不会推送任何眨眼。")
    serve(events, host=args.host, port=args.port, speed=args.speed, lead=args.lead)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="眨眼事件 → 网页游戏桥接器（零依赖）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("detect", help="对 EEG CSV 跑检测，输出 jumps.json")
    d.add_argument("input", help="EEG 数据 CSV（EEG-IO 或 OpenBCI 格式）")
    d.add_argument("-o", "--out", default=None, help="输出 JSON（默认 ./jumps.json）")
    d.add_argument("--threshold", type=float, default=3.4, help="触发阈值 k（σ）")
    d.add_argument("--refractory", type=float, default=0.4, help="不应期（秒）")
    d.add_argument("--band-lo", type=float, default=0.5, help="带通下限 Hz")
    d.add_argument("--band-hi", type=float, default=8.0, help="带通上限 Hz")
    d.add_argument("--engine", default="std", choices=["std", "py"],
                   help="std=内置零依赖检测器；py=调用 blink-detector（需 numpy）")
    d.add_argument("--serve", action="store_true", help="检测完直接起 WebSocket")
    d.add_argument("--port", type=int, default=8765)
    d.add_argument("--speed", type=float, default=1.0)
    d.set_defaults(func=cmd_detect)

    s = sub.add_parser("serve", help="把 jumps.json 按时间轴推给网页")
    s.add_argument("json", help="jumps.json 路径")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--speed", type=float, default=1.0, help="回放倍速")
    s.add_argument("--lead", type=float, default=0.5, help="首事件前准备时间(s)")
    s.set_defaults(func=cmd_serve)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
