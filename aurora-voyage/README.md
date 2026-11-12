# 星海航行计划 Aurora Voyage

## 项目简介

星海航行计划（Aurora Voyage）是一个用脑电头环眨眼信号控制太空飞船躲避柱子的网页游戏。

- 硬件：Muse Athena 脑电头环
- 玩法：眨眼一次，飞船向上推进一次，避开迎面而来的柱子
- 站点：星海主题四页网站（首页 / 浏览 / 实验室 / 反馈），通过单 HTML 文件交付

## 系统架构

```
眨眼
  ↓
Muse Direct（蓝牙采集，输出 OSC）
  ↓  OSC → 127.0.0.1:8000
eeg_receiver.py（检测眨眼 0→1 上升沿，并清洗脑电波形）
  ↓  WebSocket 广播（7000 / 8765）
网页外壳（Aurora_Voyage.html 接收并转发给游戏）
  ↓
flap() 飞船推进
```

链路说明：

1. Muse Athena 采集到眨眼动作后，由 Muse Direct 通过蓝牙读取并转成 OSC 消息。
2. OSC 消息发送到本机 `127.0.0.1:8000`，由 `eeg_receiver.py` 接收。
3. 接收器对眨眼信号做 0 → 1 上升沿检测（避免一次眨眼触发多次），同时对原始脑电做直流偏移去除与高通清洗。
4. 接收器通过 WebSocket（7000 / 8765 端口）把眨眼事件与脑电波形广播出去。
5. 网页外壳 `Aurora_Voyage.html` 收到消息后转发给游戏逻辑，调用 `flap()` 让飞船推进。

## 运行步骤

1. 安装依赖：

   ```bash
   pip install -r requirements.txt
   ```

2. 双击 `start_receiver.bat` 启动接收器（保持窗口开启，不要关闭）。

3. 在 Muse Direct 中连接头环，将 OSC 输出目标设为 `127.0.0.1:8000`，然后开始发送。

4. 双击 `Aurora_Voyage.html`，进入「实验室」页，点击「连接 Python」。

5. 用鼠标点击画面开始游戏，之后用眨眼控制飞船推进。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `Aurora_Voyage.html` | 单文件交付的星海主题网站，包含首页、浏览、实验室、反馈四页及眨眼控制游戏。 |
| `eeg_receiver.py` | 脑电接收器：接收 OSC 眨眼/脑电数据，做上升沿检测与波形清洗，并通过 WebSocket 广播给网页。 |
| `start_receiver.bat` | Windows 启动脚本，用本机 Python 运行 `eeg_receiver.py`（若本机 Python 安装路径不同，需修改脚本内的解释器路径）。 |
| `build_merged.py` | 维护脚本，把四页原始页面合并并注入导航拦截，重新生成单文件版 `Aurora_Voyage.html`。 |
| `test_link.py` | 链路自测脚本，模拟发送 OSC 眨眼与脑电数据，验证接收器到 WebSocket 客户端是否连通。 |
| `requirements.txt` | Python 依赖清单（`python-osc`、`websockets`）。 |
| `.gitignore` | 排除缓存与个人生理数据文件（`__pycache__/`、`*.pyc`、`*.csv`、`*.edf`、`Blink_Experiment_01/`）。 |

## 注意事项

- Windows 环境需 Python 3.10+。
- 数据文件（`.csv` / `.edf`）因含个人生理数据，未上传至本仓库。
