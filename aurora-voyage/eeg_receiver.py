
import time
import json
import asyncio
import threading

from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import BlockingOSCUDPServer
from websockets.asyncio.server import serve


# ==============================
# 全局变量
# ==============================

previous_blink = 0
last_trigger_time = 0
last_blink_on = 0.0   # 最后一次"有眨眼"的时刻，用于兜底复位（防止漏掉 0 值后永久卡死）
blink_suppress = False  # 卡死保护：信号长时间为 1 时暂停触发，直到收到真实的 0 才重新武装

clients = set()
event_loop = None

# 原始脑电缓冲（由 OSC 线程填充，WS 线程定期批量发送）
eeg_buffer = []

# 高通滤波的动态基线（去除电极直流偏移，实测 Muse 基线约数百微伏）
eeg_baseline = None
EMA_ALPHA = 0.05  # 更强的高通（时间常数约 0.08 秒），慢速漂移不再被画成大波

# 已见过的 OSC 地址（用于首次识别 Muse Athena 的设备前缀）
seen_addresses = set()


# ==============================
# WebSocket：向游戏广播消息
# ==============================

async def broadcast(message, quiet=False):
    if not clients:
        if not quiet:
            print("检测到眨眼，但游戏尚未连接")
        return

    payload = json.dumps(message)

    disconnected = set()

    for client in list(clients):
        try:
            await client.send(payload)
        except Exception:
            disconnected.add(client)

    clients.difference_update(disconnected)


async def send_blink():
    # 发送眨眼信号
    await broadcast({"blink": True})

    # 保持高信号 0.18 秒
    await asyncio.sleep(0.18)

    # 发送低信号，重置游戏检测状态
    await broadcast({"blink": False})


# ==============================
# WebSocket：处理游戏连接
# ==============================

async def websocket_handler(websocket):
    clients.add(websocket)
    print("游戏已连接！")

    try:
        await websocket.wait_closed()

    finally:
        clients.discard(websocket)
        print("游戏已断开连接")


async def websocket_server():
    async with serve(
        websocket_handler,
        "127.0.0.1",
        7000
    ):
        print("WebSocket 已启动：7000")
        await asyncio.Future()


async def eeg_flusher():
    # 每 40ms 把攒下的脑电样本打包发给游戏
    while True:
        await asyncio.sleep(0.04)

        if not eeg_buffer:
            continue

        batch = eeg_buffer.copy()
        eeg_buffer.clear()

        await broadcast({"eeg": batch}, quiet=True)


async def websocket_main():
    # 同时监听 7000（新架构：跳跃指令）和 8765（旧版兼容端口），两个端口广播相同内容
    async with serve(websocket_handler, "127.0.0.1", 7000), \
               serve(websocket_handler, "127.0.0.1", 8765):
        print("WebSocket 已启动：7000（跳跃指令）+ 8765（旧版兼容）")
        flusher = asyncio.ensure_future(eeg_flusher())
        try:
            await asyncio.Future()
        finally:
            flusher.cancel()


def start_websocket():
    global event_loop

    event_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(event_loop)

    event_loop.run_until_complete(websocket_main())


# ==============================
# OSC：接收 Muse 脑电数据
# ==============================

def note_address(address):
    # 首次见到的地址打印出来，方便确认 Athena 的设备前缀
    if address not in seen_addresses:
        seen_addresses.add(address)
        print("发现数据通道:", address)


def eeg_handler(address, *args):
    global previous_blink, last_trigger_time, eeg_baseline, last_blink_on, blink_suppress

    note_address(address)

    # 原始脑电：兼容两种格式
    #   Muse Direct 实测（Athena/Muse S）：/5372/eeg
    #   部分工具：/5372/elements/eeg
    # 一条消息 = 一个采样点（多个通道的电压值，单位微伏）
    if address.endswith("/eeg"):
        if args:
            try:
                # 优先取两个前额通道（AF7/AF8）的平均值，眨眼伪迹最明显
                if len(args) >= 3:
                    v = (float(args[1]) + float(args[2])) / 2.0
                else:
                    v = float(args[0])
                # 高通：减去缓慢跟踪的基线，去掉直流偏移，眨眼等快变化保留
                if eeg_baseline is None:
                    eeg_baseline = v
                eeg_baseline += EMA_ALPHA * (v - eeg_baseline)
                eeg_buffer.append(round(v - eeg_baseline, 1))
            except (TypeError, ValueError):
                pass
        return

    # 眨眼标志：任意设备前缀的 /elements/blink
    if not address.endswith("/elements/blink"):
        return

    if not args:
        return

    # 眨眼值可能是 0/1，也可能是 0~1 的强度浮点：>=0.5 都算"有眨眼"
    try:
        blink_val = float(args[0])
    except (TypeError, ValueError):
        blink_val = 0.0
    blink = 1 if blink_val >= 0.5 else 0
    now = time.monotonic()

    # 严格上升沿判定：只有信号从 0 变成 1 的那一瞬间才算一次眨眼。
    # （旧版的「高电平超 0.6 秒就重新触发」会在信号被噪声抬高时反复触发，导致没眨眼也跳）
    # 卡死兜底：信号持续为 1 超过 1.5 秒（漏掉了归零消息），暂停触发并等待信号归零，
    # 既不会永久卡死，也不会在信号仍为高时把下一条消息误判成新的上升沿。
    if blink == 1 and previous_blink == 1 and now - last_blink_on > 1.5:
        if not blink_suppress:
            print("眨眼信号长时间保持高电平，暂停触发，等待信号归零")
        blink_suppress = True

    if blink_suppress:
        if blink == 0:
            blink_suppress = False  # 收到真实归零，重新武装
        previous_blink = blink
        if blink == 1:
            last_blink_on = now
        return

    rising = (blink == 1) and (previous_blink == 0)

    if rising:
        # 两次触发至少间隔 0.5 秒
        if now - last_trigger_time >= 0.5:

            print("检测到一次眨眼！发送跳跃指令！")

            # 把发送任务交给 WebSocket 线程
            if event_loop is not None:
                asyncio.run_coroutine_threadsafe(
                    send_blink(),
                    event_loop
                )

            last_trigger_time = now

    if blink == 1:
        last_blink_on = now
    previous_blink = blink


# ==============================
# 主程序
# ==============================

if __name__ == "__main__":

    # 启动 WebSocket 服务线程
    ws_thread = threading.Thread(
        target=start_websocket,
        daemon=True
    )

    ws_thread.start()

    # 配置 OSC 接收
    dispatcher = Dispatcher()
    dispatcher.set_default_handler(eeg_handler)

    server = BlockingOSCUDPServer(
        ("127.0.0.1", 8000),
        dispatcher
    )

    print("正在监听 Muse（OSC 端口 8000，脑电数据），等待眨眼与脑电数据……")
    print("眨眼指令将通过 WebSocket 7000（主）与 8765（兼容）端口发送给游戏。")

    try:
        server.serve_forever()

    except KeyboardInterrupt:
        print("\n程序已停止")
        server.server_close()
