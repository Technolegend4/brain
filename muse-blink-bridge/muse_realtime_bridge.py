# -*- coding: utf-8 -*-
"""
Muse 实时眨眼桥接器  muse_realtime_bridge.py
=====================================================================
作用
    用 BrainFlow 通过蓝牙【实时】直连 Muse S / Muse 2 脑电仪，
    持续读取前额两个通道(AF7/AF8)的 EEG 信号，用滑动窗口【实时】检测眨眼，
    每检测到一次眨眼，就通过 WebSocket 把事件推给网页游戏
    （眨眼小鸟 / Blink Bird，对应它「信号源」里的「Python 桥接器(WebSocket)」）。

    整条链路是流式实时的，不落盘、不先保存再回放：
        眨眼 → Muse 蓝牙实时流 → 本程序实时检测 → WebSocket 实时推送 → 小鸟振翅
    固有检测延迟约 0.3~0.5 秒（眨眼信号本身持续这么久 + 滤波群延迟），
    这是脑电眨眼的物理特性，不是"先存再传"。

两种运行模式
    1) 真实模式（默认）：BrainFlow 直连 Muse，实时读 EEG。
       需要先给 Muse 开机、在系统蓝牙里配对好，并保证没有被 XMuseLab 占用。
    2) 自检模式（--selftest）：不连任何设备，用合成 EEG 模拟眨眼，
       验证「桥接器 → 检测 → WebSocket → 网页」整条链路是否打通。
       强烈建议先跑自检模式确认链路，再连真实设备。

用法示例
    # 自检（先验证链路）
    py muse_realtime_bridge.py --selftest

    # 真实连接（自动发现已配对的 Muse S）
    py muse_realtime_bridge.py

    # 真实连接，指定 Muse 的蓝牙 MAC（更稳）
    py muse_realtime_bridge.py --mac 00:55:DA:B0:XX:XX

    # 如果你的设备是 Muse 2（默认按 Muse S）
    py muse_realtime_bridge.py --board 22

依赖：brainflow  numpy  scipy  websockets   （见 requirements.txt）
=====================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import deque

import numpy as np

# 复用 outputs/blink-detector 里的成熟离线检测算法（已复制到本目录）
import blink_detector as bd

try:
    from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
    _HAS_BRAINFLOW = True
except Exception:
    _HAS_BRAINFLOW = False

try:
    from websockets.sync.server import serve as ws_serve
    _HAS_WS = True
except Exception:
    _HAS_WS = False


# ============================ 实时检测参数 ============================
WIN_S = 2.5            # 滑动窗口长度(秒)：需覆盖一次完整眨眼(~0.4s) + 滤波收敛
DET_INTERVAL_S = 0.1   # 检测间隔(秒)：每 100ms 对窗口重新检测一次
MIN_SAMPLES_S = 1.0    # 至少攒满 1 秒数据才开始检测
AF7_IDX = 1            # Muse 4 个 EEG 通道顺序：TP9, AF7, AF8, TP10
AF8_IDX = 2            # 眨眼伪迹在前额 AF7/AF8 最强


# ============================ 数据源抽象 ============================
class RealSource:
    """真实数据源：BrainFlow 直连 Muse。"""

    def __init__(self, board, fs, ch0, ch1):
        self.board = board
        self.fs = fs
        self.ch0 = ch0
        self.ch1 = ch1

    def latest(self, n):
        """返回 (x0, x1, 当前绝对样本总数, fs)，数据不足时返回 None。"""
        count = self.board.get_board_data_count()
        if not count:
            return None
        data = self.board.get_current_board_data(min(n, count))
        if data is None or data.shape[1] == 0:
            return None
        return data[self.ch0], data[self.ch1], count, self.fs


class FakeSource:
    """自检数据源：合成双通道 EEG，含背景噪声、50Hz 工频与周期性眨眼。"""

    def __init__(self, fs=256.0):
        self.fs = float(fs)
        self._rng = np.random.default_rng(7)
        self._buf0 = deque(maxlen=int(fs * 30))
        self._buf1 = deque(maxlen=int(fs * 30))
        self._count = 0
        self._t = 0.0
        self._next_blink = 1.2

    def _advance(self, n):
        fs = self.fs
        for _ in range(n):
            t = self._t
            self._t += 1.0 / fs
            # 背景：慢漂移 + 噪声 + 50Hz 工频
            drift = 400.0 * np.sin(2 * np.pi * 0.25 * t) + 200.0 * np.sin(2 * np.pi * 0.7 * t)
            noise = self._rng.normal(0, 25.0)
            hum = 25.0 * np.sin(2 * np.pi * 50.0 * t)
            x0 = drift + noise + hum
            x1 = -drift + noise * 0.9 - hum * 0.8
            # 周期性眨眼：负向高斯，持续约 0.4 秒
            if self._next_blink <= t < self._next_blink + 0.4:
                rel = t - self._next_blink
                g = np.exp(-0.5 * ((rel - 0.18) / 0.09) ** 2)
                x0 -= 900.0 * g
                x1 -= 700.0 * g
            if t >= self._next_blink + 0.4:
                self._next_blink = t + 2.0 + self._rng.uniform(0, 1.5)
            self._buf0.append(x0)
            self._buf1.append(x1)
            self._count += 1

    def latest(self, n):
        # 每次调用向前推进约一个检测间隔的新样本，模拟实时流
        self._advance(max(1, int(self.fs * DET_INTERVAL_S)))
        if self._count < n:
            n = self._count
        x0 = np.array(list(self._buf0)[-n:], dtype=float)
        x1 = np.array(list(self._buf1)[-n:], dtype=float)
        return x0, x1, self._count, self.fs


# ============================ 主程序 ============================
def main(argv=None):
    # 让中文日志在 Windows 控制台不乱码（配合 `chcp 65001` 使用）
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(
        description="Muse 实时眨眼桥接器：BrainFlow 直连 + 实时检测 + WebSocket 推给网页",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--board", type=int, default=38,
                    help="BrainFlow 板卡 id：38=Muse S，22=Muse 2")
    ap.add_argument("--mac", type=str, default="",
                    help="Muse 蓝牙 MAC 地址(形如 00:55:DA:B0:XX:XX)。留空则自动发现已配对设备")
    ap.add_argument("--port", type=int, default=8765, help="WebSocket 监听端口")
    ap.add_argument("--host", type=str, default="127.0.0.1", help="WebSocket 监听地址")
    ap.add_argument("--selftest", action="store_true", help="用合成 EEG 自检整条链路，不连设备")
    ap.add_argument("--k", type=float, default=bd.THRESHOLD_K, help="检测阈值系数")
    ap.add_argument("--gate", type=float, default=bd.GATE_S, help="双通道同向门限")
    ap.add_argument("--refractory", type=float, default=bd.REFRACTORY_S, help="不应期(秒)")
    ap.add_argument("--polarity", default="auto",
                    choices=["auto", "neg", "pos", "both"], help="眨眼极性")
    args = ap.parse_args(argv)

    if not _HAS_WS:
        print("[错误] 缺少 websockets 库。请先运行：pip install websockets")
        return 2

    if args.selftest:
        print("=" * 64)
        print("自检模式：使用合成 EEG，验证桥接器 → 检测 → WebSocket 链路")
        print("=" * 64)
        source = FakeSource()
    else:
        if not _HAS_BRAINFLOW:
            print("[错误] 缺少 brainflow 库。请先运行：pip install brainflow")
            return 2
        print("=" * 64)
        print("正在连接 Muse（board_id=%d）…" % args.board)
        print("=" * 64)
        params = BrainFlowInputParams()
        if args.mac:
            params.serial_port = args.mac          # 老版本用 serial_port 存 MAC
            try:
                params.mac_address = args.mac      # 新版本用 mac_address
            except Exception:
                pass
        try:
            board = BoardShim(BoardIds(args.board), params)
            board.prepare_session()
            board.start_stream(45000, "")
        except Exception as e:
            print("[错误] Muse 连接失败：%s" % e)
            print("排查：")
            print("  1) Muse 是否已开机(头带侧键长按，指示灯呼吸)？")
            print("  2) 是否已在 Windows 蓝牙设置里配对(能搜到 Muse-XXXX)？")
            print("  3) XMuseLab 是否还开着占用了蓝牙？请先彻底退出。")
            print("  4) 若设备不是标准 Muse S，可试 --board 22 (Muse 2)。")
            print("  5) 换用 --mac 00:55:DA:B0:XX:XX 指定设备(印在头带左耳后)。")
            return 2

        fs = BoardShim.get_sampling_rate(BoardIds(args.board))
        eeg_ch = BoardShim.get_eeg_channels(BoardIds(args.board))
        print("采样率：%g Hz       EEG 通道索引：%s" % (fs, eeg_ch))
        if len(eeg_ch) < 3:
            print("[错误] 未读到预期的 4 通道 EEG，实际：%s" % eeg_ch)
            return 2
        ch0, ch1 = eeg_ch[AF7_IDX], eeg_ch[AF8_IDX]
        print("使用前额通道：AF7=%s  AF8=%s" % (ch0, ch1))
        source = RealSource(board, fs, ch0, ch1)

    fs = source.fs
    win_n = int(WIN_S * fs)
    min_n = int(MIN_SAMPLES_S * fs)

    # 共享状态：用 dict 包一层，方便在 handler 闭包里更新
    state = {"last_report": -int(fs * 10), "locked_pol": "auto"}

    def handler(ws):
        print("[bridge] 网页已连接，开始实时推送眨眼事件。")
        ws.send(json.dumps({"type": "ready", "count": 0}))
        while True:
            latest = source.latest(win_n)
            if latest is None:
                time.sleep(DET_INTERVAL_S)
                continue
            x0, x1, count, _fs = latest
            if len(x0) < min_n:
                time.sleep(DET_INTERVAL_S)
                continue

            polarity = state["locked_pol"] if state["locked_pol"] != "auto" else "auto"
            res, _score, _note = bd.detect(
                {"AF7": x0, "AF8": x1}, _fs,
                k=args.k, refractory_s=args.refractory,
                polarity=polarity, consistency=True, band=bd.BAND, gate=args.gate)

            # 自动极性锁定：判定到方向后就固定，避免每窗口抖动
            if state["locked_pol"] == "auto" and res.get("polarity", 0) != 0:
                state["locked_pol"] = "neg" if res["polarity"] == -1 else "pos"
                print("[bridge] 已锁定眨眼极性：%s" % state["locked_pol"])

            base = count - len(x0)          # 窗口首样本的绝对序号
            for i, p in enumerate(res["peak_idx"]):
                abs_idx = base + int(p)     # 本次眨眼峰值对应的绝对样本序号
                if abs_idx > state["last_report"] + int(args.refractory * _fs):
                    state["last_report"] = abs_idx
                    msg = {
                        "type": "blink",
                        "t": round(abs_idx / _fs, 4),
                        "score": round(float(res["score"][i]), 3),
                        "tPeak": round(abs_idx / _fs, 4),
                    }
                    try:
                        ws.send(json.dumps(msg))
                    except Exception:
                        return  # 客户端断开
                    print("→ 眨眼 @ t=%.2fs  score=%.2fσ"
                           % (abs_idx / _fs, res["score"][i]))

            time.sleep(DET_INTERVAL_S)

    print("[bridge] 监听 ws://%s:%d  （请到网页把「数据来源」选为「Python 桥接器(WebSocket)」，")
    print("[bridge] 桥接器地址保持 ws://127.0.0.1:%d，然后点「连接并开始」。）" % args.port)
    print("[bridge] 按 Ctrl+C 停止。")

    with ws_serve(handler, args.host, args.port) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
