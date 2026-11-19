# -*- coding: utf-8 -*-
"""eeg_receiver.py —— 星海航行计划 / 眨眼脑电接收器

链路：
    Muse Direct --蓝牙--> OSC/UDP :8000 --> 本脚本 --> WebSocket :7000 --> 网页

本脚本做三件事：
    1. 收 OSC：识别 Muse 的眨眼消息与多通道脑电消息（前缀不固定，按后缀匹配）
    2. 清洗：眨眼看 0→1 上升沿（带不应期），脑电做去直流 + 一阶高通
    3. 广播：通过 WebSocket 推给网页，格式与前端约好的 JSON 一致

前端期望的消息格式：
    {"blink": true}                 检测到一次眨眼
    {"blink": false}                眨眼结束（供波形回落）
    {"blink_strength": 0~100}       眨眼强度，可选
    {"eeg": [v1, v2, ...]}         一帧脑电样本（微伏，已去直流）

用法：
    python eeg_receiver.py
    python eeg_receiver.py --osc-port 8000 --ws-port 7000
    python eeg_receiver.py --channels 4 --verbose

依赖：pip install -r requirements.txt
"""
import argparse
import asyncio
import json
import math
import sys
import threading
import time

try:
    from pythonosc.dispatcher import Dispatcher
    from pythonosc.osc_server import ThreadingOSCUDPServer
except ImportError:
    sys.exit("缺少依赖 python-osc，请先执行：pip install -r requirements.txt")

try:
    from websockets.asyncio.server import serve as ws_serve
except ImportError:  # websockets < 13 的老接口
    try:
        from websockets.server import serve as ws_serve
    except ImportError:
        sys.exit("缺少依赖 websockets，请先执行：pip install -r requirements.txt")


# ---------------------------------------------------------------- 配置

DEFAULTS = {
    "osc_host": "127.0.0.1",
    "osc_port": 8000,
    "ws_host": "127.0.0.1",
    "ws_port": 7000,
    "channels": 4,          # Muse 2/S = 4，Muse Athena = 5
    "batch": 4,             # 每帧几个样本（256Hz 下 4 → 约 64 帧/秒，波形够顺不刷爆）
    "blink_refractory": 0.11,   # 眨眼不应期（秒）：0.11s 内重复的上升沿当作同一次
    "hp_cutoff": 0.5,       # 高通截止频率（Hz），去掉慢漂移
    "rate": 256.0,          # Muse 采样率，用于算高通系数
}

QUIET = False


def log(*a):
    if not QUIET:
        print(*a, flush=True)


# ---------------------------------------------------------------- 信号清洗

class HighPass:
    """一阶高通：去直流漂移，保留眨眼这种快变化。

    y[n] = a * (y[n-1] + x[n] - x[n-1])
    一阶的相位失真很小，够用；需要更陡的滚降再换二阶。
    """

    def __init__(self, cutoff_hz, sample_rate):
        self.a = math.exp(-2.0 * math.pi * cutoff_hz / sample_rate)
        self.prev_x = 0.0
        self.prev_y = 0.0

    def __call__(self, x):
        y = self.a * (self.prev_y + x - self.prev_x)
        self.prev_x = x
        self.prev_y = y
        return y


class BlinkDetector:
    """把连续的 blink 数值变成「一次眨眼」事件。

    Muse Direct 的 blink 一般发 0/1；有些配置发连续值。两种都能处理：
    跨过 0.5 的上升沿算一次，之后 refractory 秒内的重复忽略。
    """

    def __init__(self, refractory):
        self.refractory = refractory
        self.last_fire = 0.0
        self.armed = True

    def feed(self, value):
        """返回 (是否新眨眼, 强度 0~100 或 None)。"""
        try:
            v = float(value)
        except (TypeError, ValueError):
            return False, None

        # 低于阈值 → 重新上膛，准备接收下一次上升沿
        if v < 0.5:
            self.armed = True
            return False, None

        if not self.armed:
            return False, None

        now = time.monotonic()
        if now - self.last_fire < self.refractory:
            return False, None

        self.armed = False
        self.last_fire = now
        strength = max(0.0, min(100.0, v * 100.0 if v <= 1.0 else v))
        return True, round(strength, 1)


# ---------------------------------------------------------------- 广播中枢

class Hub:
    """OSC 线程与 asyncio 世界之间的桥。

    OSC 回调在别的线程里跑，不能直接 await，所以只把消息塞进队列，
    由同一个事件循环里的广播任务取出并推给所有客户端。
    某个客户端卡住不能拖累别人，因此每个连接有自己的 send 协程和队列。
    """

    def __init__(self, loop, batch, focus_channel=0):
        self.loop = loop
        self.batch = batch
        self.focus_channel = focus_channel
        self.clients = set()
        self.eeg_buf = []
        self.filters = None       # 按通道数延迟创建
        self.blink = BlinkDetector(DEFAULTS["blink_refractory"])
        self.msgs_sent = 0
        self.blinks_seen = 0
        self.samples_seen = 0

    # -- 由 OSC 线程调用 --
    def submit(self, obj):
        self.loop.call_soon_threadsafe(self._enqueue, obj)

    def _enqueue(self, obj):
        if not self.clients:
            return                     # 没人听就别攒数据，省内存
        payload = json.dumps(obj, separators=(",", ":"))
        for q in list(self.clients):
            if q.qsize() < 200:        # 慢客户端丢新帧，不堵住整个管线
                q.put_nowait(payload)

    # -- 前端消息构造 --
    def on_blink(self, value):
        fired, strength = self.blink.feed(value)
        if fired:
            self.blinks_seen += 1
            self.submit({"blink": True})
            if strength is not None:
                self.submit({"blink_strength": strength})
            # 150ms 后补一个 false，让前端的波形与指示灯回落。
            # 真实 Muse 多数会自己发 0，重复的 false 无害（前端只用来复位）
            self.loop.call_soon_threadsafe(self._schedule_release)
            log("[blink] 检测到眨眼，强度 %.1f" % (strength if strength is not None else -1))
        elif self._is_low(value):
            self.submit({"blink": False})

    @staticmethod
    def _is_low(value):
        try:
            return float(value) < 0.5
        except (TypeError, ValueError):
            return False

    def _schedule_release(self):
        self.loop.call_later(0.15, lambda: self.submit({"blink": False}))

    def on_eeg(self, values):
        vals = [float(v) for v in values]
        if not vals:
            return
        # 通道数对齐：多出来的截掉，缺的补 0，避免前端数组长度忽长忽短
        n = DEFAULTS["channels"]
        if len(vals) < n:
            vals = vals + [0.0] * (n - len(vals))
        elif len(vals) > n:
            vals = vals[:n]

        if self.filters is None:
            self.filters = [HighPass(DEFAULTS["hp_cutoff"], DEFAULTS["rate"]) for _ in range(n)]

        cleaned = [round(f(v), 3) for f, v in zip(self.filters, vals)]
        self.samples_seen += 1

        # 前端只画一条波形，所以只推一个通道（默认第一个）。
        # 把多通道摊平成一维塞进去会让 4 条线交错成一团噪声。
        self.eeg_buf.append(cleaned[self.focus_channel])
        if len(self.eeg_buf) >= self.batch:
            chunk = self.eeg_buf
            self.eeg_buf = []
            self.msgs_sent += 1
            self.submit({"eeg": chunk})

    # -- WebSocket 连接处理 --
    async def handle_client(self, websocket, *args):
        peer = getattr(websocket, "remote_address", None)
        log("[ws] 客户端已连接 %s（当前 %d 个）" % (peer, len(self.clients) + 1))
        q = asyncio.Queue()
        self.clients.add(q)
        try:
            sender = asyncio.create_task(self._sender(websocket, q))
            # 前端目前不发消息，但读一下才能及时感知断开
            async for _ in websocket:
                pass
            sender.cancel()
        except Exception:
            pass
        finally:
            self.clients.discard(q)
            log("[ws] 客户端已断开（剩余 %d 个）" % len(self.clients))

    async def _sender(self, websocket, q):
        try:
            while True:
                payload = await q.get()
                await websocket.send(payload)
        except (asyncio.CancelledError, Exception):
            pass


# ---------------------------------------------------------------- OSC 接入

def build_dispatcher(hub):
    """按地址后缀路由，不关心 Muse Direct 给的 /ABC123/ 前缀是什么。

    python-osc 的 map() 是精确匹配（除非用 * 通配），而 Muse Direct 的 OSC 地址
    前缀是设备/会话标识，每个人都不一样，所以这里统一在 default handler 里
    按后缀分发，而不是硬编码某个前缀。
    """
    d = Dispatcher()

    def route(address, *args):
        a = address.lower()
        if not args:
            return

        if a.endswith("/elements/blink") or a.endswith("/blink"):
            hub.on_blink(args[0])
            return

        if a.endswith("/elements/eeg") or a.endswith("/eeg"):
            # python-osc 会把数组参数展开成多个 args，也可能给一个 list
            if len(args) == 1 and isinstance(args[0], (list, tuple)):
                hub.on_eeg(args[0])
            else:
                hub.on_eeg(args)
            return

        # 其他自定义地址：第一个数字参数当作前端信号值
        if isinstance(args[0], (int, float)):
            hub.submit({"value": round(float(args[0]), 2)})

    # 只用 default handler 做后缀路由：每条 OSC 消息只处理一次。
    # 不要用多组 d.map("*"+suffix) 通配——重叠的通配会让同一条消息被匹配多次，
    # 脑电样本被重复累加（例如 /ABC123/elements/eeg 同时命中 */elements/eeg 和 */*/eeg）。
    d.set_default_handler(route)
    return d


def start_osc_server(host, port, hub):
    dispatcher = build_dispatcher(hub)
    server = ThreadingOSCUDPServer((host, port), dispatcher)
    t = threading.Thread(target=server.serve_forever, name="osc", daemon=True)
    t.start()
    return server


# ---------------------------------------------------------------- 主流程

async def run(args):
    loop = asyncio.get_running_loop()

    global QUIET
    QUIET = not args.verbose

    DEFAULTS["channels"] = args.channels
    DEFAULTS["batch"] = args.batch
    DEFAULTS["blink_refractory"] = args.blink_refractory
    if not 0 <= args.channel < args.channels:
        sys.exit("--channel 超出范围：应在 0..%d 之间" % (args.channels - 1))

    hub = Hub(loop, args.batch, focus_channel=args.channel)
    hub.blink = BlinkDetector(args.blink_refractory)

    try:
        osc = start_osc_server(args.osc_host, args.osc_port, hub)
    except OSError as e:
        sys.exit(
            "无法监听 OSC 端口 %s:%d —— %s\n"
            "端口可能被占用，用 --osc-port 换一个，并在 Muse Direct 里同步改目标端口。"
            % (args.osc_host, args.osc_port, e)
        )

    log("=" * 62)
    log(" 星海航行计划 · 脑电接收器")
    log(" OSC  监听 : %s:%d   ← 把 Muse Direct 的输出指到这里" % (args.osc_host, args.osc_port))
    log(" WS   监听 : %s:%d   ← 网页连这里" % (args.ws_host, args.ws_port))
    log(" 通道数    : %d（Muse 2/S = 4，Muse Athena = 5）" % args.channels)
    log(" 等待数据…按 Ctrl+C 退出")
    log("=" * 62)

    stop = asyncio.Event()

    async def reporter():
        while not stop.is_set():
            await asyncio.sleep(10)
            if hub.blinks_seen or hub.samples_seen:
                log(
                    "[stat] 客户端 %d · 眨眼 %d · 脑电样本 %d · 已发帧 %d"
                    % (len(hub.clients), hub.blinks_seen, hub.samples_seen, hub.msgs_sent)
                )

    try:
        async with ws_serve(hub.handle_client, args.ws_host, args.ws_port):
            await asyncio.gather(reporter(), stop.wait())
    except OSError as e:
        sys.exit(
            "无法监听 WebSocket 端口 %s:%d —— %s\n"
            "用 --ws-port 换一个端口，网页端加 ?port=新端口 即可。"
            % (args.ws_host, args.ws_port, e)
        )
    finally:
        stop.set()
        osc.shutdown()


def parse_args():
    p = argparse.ArgumentParser(
        description="接收 Muse 的 OSC 眨眼/脑电数据，转发为 WebSocket 给网页。"
    )
    p.add_argument("--osc-host", default=DEFAULTS["osc_host"], help="OSC 监听地址（默认 127.0.0.1）")
    p.add_argument("--osc-port", type=int, default=DEFAULTS["osc_port"], help="OSC 监听端口（默认 8000）")
    p.add_argument("--ws-host", default=DEFAULTS["ws_host"], help="WebSocket 监听地址（默认 127.0.0.1）")
    p.add_argument("--ws-port", type=int, default=DEFAULTS["ws_port"], help="WebSocket 监听端口（默认 7000）")
    p.add_argument("--channels", type=int, default=DEFAULTS["channels"], help="脑电通道数（默认 4）")
    p.add_argument("--batch", type=int, default=DEFAULTS["batch"], help="每帧合并的样本数（默认 4）")
    p.add_argument("--channel", type=int, default=0, help="推给网页画波形的通道序号（默认 0）")
    p.add_argument(
        "--blink-refractory",
        type=float,
        default=DEFAULTS["blink_refractory"],
        help="眨眼不应期秒数（默认 0.11）",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="打印每次眨眼")
    return p.parse_args()


def main():
    args = parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\n已停止。", flush=True)


if __name__ == "__main__":
    main()
