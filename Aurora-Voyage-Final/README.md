# 星海航行计划 Aurora_Voyage · 统一最新版

## 项目简介

星海航行计划（Aurora Voyage）是一个用脑电头环眨眼信号控制太空飞船躲避陨石的网页游戏。

- 硬件：Muse 脑电头环（Muse 2 / S / Athena 均可）
- 玩法：眨眼一次，飞船向上推进一次，避开迎面而来的陨石
- 站点：星海主题四页网站（首页 / 浏览 / 实验室 / 反馈）

## 本次整合（2026-11-19）

统一合并 Aurora-Voyage-Scoring、Aurora-Voyage-Scoring-blink 和 Aurora-Voyage-Meteor：

- 初始 30 分；每组障碍首次碰撞扣 10 分，安全通过加 10 分，同组不重复扣分。
- 仅得分归零时结束；碰到上下边界只限位，不扣分、不结束；重开恢复初始分数和速度。
- 飞行速度随有效游戏时间逐渐增加，暂停期间不增加。
- 保留真实眨眼事件的波形尖峰和金色闪光、脑电连接及皮肤设置。
- 单颗与双颗陨石交替，双颗横向错开，保留通行带；绘制和碰撞共用几何。
- 新计分使用独立最高分存储键，避免与旧版单颗计分混用。

所有源码在 `src/`，唯一交付入口为本目录的 `Aurora_Voyage.html`。

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

### 0. 一键启动（推荐）

Windows 用户直接双击 `一键启动.bat`，它会自动帮你：

- 启动脑电接收器（独立窗口）
- 用默认浏览器打开游戏网页 `Aurora_Voyage.html`

首次运行会自动安装依赖，请等接收器窗口显示「等待数据...」后，再执行下面的第 3、4 步即可。

### 1. 安装 Python 依赖

需要 Python 3.10+。

```bash
pip install -r requirements.txt
```

### 2. 启动接收器。

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

## 多局纪录

结算显示本局过程中的最高分，独立保存跨局历史最高分（实时保存）、已完成局数及最近 20 局最高分，结算只显示放大的本局最高分和历史最高纪录，不展示局数与各局列表。超过历史最高分会显示金色提示和庆祝彩纸；初始赠送的 30 分不触发庆祝。纪录保存在当前浏览器本地，清理浏览器数据会清除纪录。

无已完成对局时历史纪录为“None”，首局结束后才建立纪录；首局不触发破纪录庆祝，后续严格超过已有纪录才庆祝。旧版无对局记录的默认分数不会沿用为纪录。

新版使用独立 V2 纪录存储，不导入旧版默认 100 分或旧版对局；首次打开显示 BEST None，首局结束后开始保存新版纪录。


## 最终整合版（2026-11-23）

基于 Technolegend4/brain 的 e986f6c 版本，采用根目录统一整合版，移植 ljz15133665372-glitch 在旧 aurora-voyage/Aurora_Voyage.html 中新增的 Astral Drift 音乐。

- 每局 30 分起步，安全通过加 10 分，同组首次碰撞扣 10 分，归零结束，随有效游戏时间加速。
- 保留陨石、真实眨眼波形闪光、皮肤、脑电连接和 V2 最高分纪录。
- 开始游戏时播放 Web Audio 合成音乐，无需下载音频。点击“音乐开/音乐关”或按 M 切换。
- 暂停、结束、切换页面或隐藏浏览器标签时停止音乐，继续游戏时恢复。首次请点击开始按钮以解锁浏览器音频。
- 双击 Aurora_Voyage.html 可先用点击或空格试玩。使用头环时通过一键启动.bat 启动接收器。
- 音乐已写入 src/lab.html，通过 python build_merged.py 可重新生成完整单文件入口。

验证结果：单文件及源码入口、音乐播放与静音、暂停恢复、导航停播、通过加分、同组碰撞只扣一次、归零结束和重开均通过浏览器检查。模拟 OSC→WebSocket 的眨眼与 EEG 链路自测通过。真实 Muse 头环尚未实机验证。
