# Aurora Voyage 修改说明（CHANGELOG）

> 本次改造的核心目标：让项目「任何人拿到就能跑」。
> 补全缺失文件、去掉别人机器的硬编码路径、修复会导致游戏崩溃或数据异常的 bug、让文档对齐实际用法。

---

## 一、新增文件

| 文件 | 说明 |
| --- | --- |
| `eeg_receiver.py` | 补上缺失的脑电接收器：接收 Muse 的 OSC 眨眼/脑电 → 眨眼上升沿检测 + 波形清洗 → WebSocket 广播给网页。 |
| `src/nav.js` | 共享导航脚本：页面在单文件外壳的 iframe 里时向父窗口发消息切页，单独打开时走默认链接跳转。 |
| `src/home.html` | 从合并版还原出的「首页」源文件。 |
| `src/explore.html` | 从合并版还原出的「沉浸浏览」源文件。 |
| `src/connect.html` | 从合并版还原出的「关于与反馈」源文件。 |
| `src/lab.html` | 从合并版还原出的「脑波实验室（眨眼游戏）」源文件。 |
| `start_receiver.sh` | macOS / Linux 一键启动脚本（首次运行自动建 `.venv` 并装依赖）。 |

---

## 二、重写 / 大幅修改

### `build_merged.py`
- 原来读硬编码的 `C:\Users\ljz15\Desktop` 源文件路径 → 改为读项目内 `src/` 目录。
- 改用 `argparse`，支持 `--out`、`--src` 参数。
- 每页自动内联 `nav.js`，生成单文件版。
- 外壳只接受来自实验室 iframe 的消息（校验 `e.source`），并清理心跳定时器。

### `start_receiver.bat`
- 去掉硬编码的 `C:\Users\ljz15\AppData\...\python.exe` → 改为 `py -3`（回退 `python`）。
- 首次运行自动安装依赖。

### `README.md`
- 全面重写：补全「自测」章节、新增「命令行参数」表、FAQ、文件说明、注意事项。

### `test_link.py`
- 改为英文 ASCII 输出 + UTF-8 编码，消除 Windows PowerShell 下的中文乱码。

### `Aurora_Voyage.html`
- 由新构建脚本重新生成的单文件交付产物。

---

## 三、Bug 修复

### `src/lab.html`

| 问题 | 修复 |
| --- | --- |
| `addPipe()` 在窗口很矮时可能生成负高度管道，导致开局即撞墙 | 加边界兜底，保证管道开口始终在可视范围内 |
| 管道宽度在绘制、碰撞、计分处各写一个数字（64 / 73 / 68），改一处漏一处 | 统一为 `PIPE_W` 常量 |
| `sizeGame()` 引用 `bird`/`pipes` 触发 TDZ（暂时性死区）异常，导致整个游戏脚本中断 | 把 `bird`/`pipes` 声明提前到 `sizeGame()` 之前 |
| 游玩中调整窗口尺寸时，飞船/管道坐标与新尺寸脱节，表现为「一拉窗口就死」 | 按比例搬移飞船与管道坐标 |
| iframe 未布局时量不到尺寸（canvas 停在默认 300×150） | 加 `ResizeObserver` + 启动后短轮询兜底 |
| 背景星空用 `window.innerWidth/innerHeight`，在 iframe 里为 0 | 改为量 `.pane-game` 的可见尺寸 |
| 眨眼在两种信号模式下行为不一致（真实信号能开局，`onBlink` 不能） | 统一：`onBlink` 现在也能开局/重开（结束画面加 600ms 保护期） |
| WebSocket 端口写死 7000 | 改为可配置：网页加 `?port=` / `?ws=`，接收器加 `--ws-port` |
| `localStorage` 无前缀，同域下其他项目会互相覆盖 | 统一加 `av:` 前缀（封装为 `LS`） |

### `src/connect.html`

| 问题 | 修复 |
| --- | --- |
| 漂流瓶的 `mood`/`date` 直接拼进 HTML，存在 XSS 风险 | 加 HTML 转义 |
| `localStorage` 直接调用 | 改走 `LS` 前缀封装 |

### `src/home.html`

| 问题 | 修复 |
| --- | --- |
| 首页入口跳转只发 `parent.postMessage`，单独打开时失效 | 兼容两种环境：iframe 里发消息、单独打开用 `location.href` |

### `eeg_receiver.py`

| 问题 | 修复 |
| --- | --- |
| 重叠通配规则导致同一条 OSC 消息被匹配多次，脑电样本被重复累加 4 倍 | 改为单一路由（`set_default_handler`），每条消息只处理一次 |
| 多通道脑电摊平成一维推给前端，画出来是一团噪声 | 只推单个通道（默认第 0 通道） |
| 眨眼释放、非数字参数处理不健壮 | 重构释放逻辑 + 容错 |

---

## 四、配置更新

| 文件 | 改动 |
| --- | --- |
| `requirements.txt` | `websockets>=10.0` → `websockets>=13.0`（使用了 13+ 才有的 `asyncio.server` 接口） |
| `.gitignore` | 新增 `.venv/` |

---

## 五、测试结果

接收器端到端链路自测（`python test_link.py`）：

```
[TEST] WebSocket connected to ws://127.0.0.1:7000
[TEST] Blink signal : PASS (rise=True, fall=True)
[TEST] EEG data     : PASS (27 batches, 108 samples, sample=[0.0, 11.54, 21.117, 27.222])
[TEST] Result       : PASS
```

- 眨眼上升沿/下降沿检测：PASS
- 脑电清洗与广播：PASS（108 个真实正弦波样本）
- 构建脚本：正常生成单文件版
- 所有 JS / Python 语法校验：通过

---

## 六、待你最终确认

游戏**动画**（飞船下落、管道移动、星空流动）依赖 `requestAnimationFrame`，
在部分嵌入式浏览器预览环境里 rAF 会被暂停，因此动画需在真实浏览器中确认：

双击打开 `Aurora_Voyage.html`，进入「实验室」页，点「测试一次眨眼」→ 飞船应跳一下；
点「开始游戏」→ 飞船下落，点画面/空格/眨眼让它往上飞。

---

## 七、后续使用提醒

- **改代码**：编辑 `src/` 里的源文件，改完运行 `python build_merged.py` 重新生成单文件版。
- **换端口**：接收器 `--ws-port 7001`，网页 `?port=7001`。
- **Muse Athena**：接收器 `--channels 5`。
