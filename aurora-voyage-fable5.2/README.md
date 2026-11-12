# 星海航行计划 Aurora Voyage

## 项目简介

星海航行计划（Aurora Voyage）是一个用脑电头环眨眼信号控制太空飞船躲避柱子的网页游戏。

- 硬件：Muse 脑电头环（Muse 2 / S / Athena 均可）
- 玩法：眨眼一次，飞船向上推进一次，避开迎面而来的柱子
- 站点：星海主题四页网站（首页 / 浏览 / 实验室 / 反馈）

## 系统架构

```
眨眼
  ↓
Muse Direct（蓝牙采集，输出 OSC）
  ↓  OSC → 127.0.0.1:8000
eeg_receiver.py（检测眨眼 0→1 上升沿，并清洗脑电波形）
  ↓  WebSocket 广播（127.0.0.1:7000）
网页外壳（Aurora_Voyage.html 接收并转发给游戏）
  ↓
flap() 飞船推进
```

链路说明：

1. Muse Direct 采集到眨眼动作后，通过蓝牙读取并转成 OSC 消息。
2. OSC 消息发送到本机 `127.0.0.1:8000`，由 `eeg_receiver.py` 接收。
3. 接收器对眨眼信号做 0 → 1 上升沿检测（带不应期，避免一次眨眼触发多次），对脑电做去直流 + 高通清洗。
4. 接收器通过 WebSocket（默认 7000 端口）把眨眼事件与脑电波形广播出去。
5. 网页外壳收到消息后转发给游戏逻辑，调用 `flap()` 让飞船推进。

## 快速开始

### 1. 安装 Python 依赖

需要 Python 3.10+。

```bash
pip install -r requirements.txt
```

### 2. 启动接收器

- **Windows**：双击 `start_receiver.bat`（首次运行会自动装依赖）
- **macOS / Linux**：`./start_receiver.sh`（首次运行会建 `.venv` 虚拟环境）

窗口保持开启，不要关闭。

### 3. 连接头环

在 Muse Direct 中连接头环，把 OSC 输出目标设为 `127.0.0.1:8000`，然后开始发送。

> 接收器按 OSC 地址的**后缀**匹配（`/elements/blink`、`/elements/eeg`），
> 不关心 Muse Direct 给的前缀是什么，所以不用改设备 ID。

### 4. 打开网页

- 双击 `Aurora_Voyage.html`（单文件版，直接分发用）
- 进入「实验室」页，点击「连接 Python」
- 用鼠标点击画面开始游戏，之后用眨眼控制飞船推进

### 5. 自测（无需头环）

如果你还没有头环，可以先用内置的链路自测脚本验证整套系统是否连通。

1. 先启动接收器（见第 2 步，保持窗口开启）。
2. 另开一个终端，在项目目录运行：

```bash
python test_link.py
```

它会模拟发送一次眨眼和 0.5 秒的脑电数据，验证「OSC → 接收器 → WebSocket → 客户端」是否连通。

预期输出：

```
[TEST] WebSocket connected to ws://127.0.0.1:7000
[TEST] Blink signal : PASS (rise=True, fall=True)
[TEST] EEG data     : PASS (27 batches, 108 samples, sample=[...])
[TEST] Result       : PASS
```

看到 `Result : PASS` 就说明接收器与网页之间的数据链路正常，可以接真头环了。

## 命令行参数

`eeg_receiver.py` 支持以下参数（也可通过 `start_receiver.bat` / `start_receiver.sh` 追加）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--osc-host` | `127.0.0.1` | OSC 监听地址 |
| `--osc-port` | `8000` | OSC 监听端口（Muse Direct 输出目标） |
| `--ws-host` | `127.0.0.1` | WebSocket 监听地址 |
| `--ws-port` | `7000` | WebSocket 监听端口（网页连接目标） |
| `--channels` | `4` | 脑电通道数（Muse 2/S = 4，Athena = 5） |
| `--channel` | `0` | 推给网页画波形的通道序号 |
| `--batch` | `4` | 每帧合并的样本数 |
| `--blink-refractory` | `0.11` | 眨眼不应期（秒），防止一次眨眼触发多次 |
| `-v` / `--verbose` | 关 | 打印每次眨眼 |

示例：

```bash
# Muse Athena（5 通道）+ 端口被占用时换端口
python eeg_receiver.py --channels 5 --ws-port 7001
```

网页端对应加 `?port=7001` 即可连到新端口。

## 常见问题

**端口被占用？** 接收器支持换端口：

```bash
python eeg_receiver.py --osc-port 8001 --ws-port 7001
```

网页端加 `?port=7001` 即可连到新 WebSocket 端口（如 `Aurora_Voyage.html?port=7001`）。

**Muse Athena 通道数不同？** Athena 是 5 通道，用 `--channels 5`：

```bash
python eeg_receiver.py --channels 5
```

**只想推某个通道的波形？** 用 `--channel N`（默认 0）。

**眨眼没反应？** 确认：
1. 接收器窗口显示「等待数据…」
2. Muse Direct 的 OSC 目标端口与接收器一致（默认 8000）
3. 网页「实验室」页已点「连接 Python」，状态显示「已连接」

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `Aurora_Voyage.html` | 单文件交付版（由 `build_merged.py` 生成，可直接分发）。 |
| `eeg_receiver.py` | 脑电接收器：接收 OSC 眨眼/脑电，做上升沿检测与波形清洗，WebSocket 广播。 |
| `src/` | 四个页面的源文件（`home` / `explore` / `connect` / `lab`）+ 共享导航脚本 `nav.js`。改代码在这里改。 |
| `build_merged.py` | 把 `src/` 四页打包成单文件 `Aurora_Voyage.html`。 |
| `test_link.py` | 链路自测脚本：模拟 OSC 数据，验证接收器到 WebSocket 客户端是否连通。 |
| `start_receiver.bat` / `start_receiver.sh` | 一键启动脚本（Windows / macOS-Linux）。 |
| `requirements.txt` | Python 依赖（`python-osc`、`websockets`）。 |
| `.gitignore` | 排除缓存与个人生理数据（`__pycache__/`、`*.pyc`、`*.csv`、`*.edf`、`.venv/` 等）。 |

## 修改后如何重新生成单文件版

```bash
python build_merged.py
```

## 注意事项

- Windows 环境需 Python 3.10+。
- 数据文件（`.csv` / `.edf`）含个人生理数据，已通过 `.gitignore` 排除，请勿提交。
- 四个源页面在 `src/` 里也可以单独双击打开调试；只有打包成 `Aurora_Voyage.html` 后才是单文件版。
