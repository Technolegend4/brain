# NOTICE · 产权与合规说明

本项目「眨眼小鸟 / Blink Bird」是一个**独立实现**的浏览器游戏：用前额 EEG/EOG 中的眨眼伪迹驱动小鸟振翅。
本文说明代码来源、第三方参考的许可状态，以及二次分发/商用前必须确认的事项。

---

## 1. 本项目的原创部分

以下内容均为本项目原创，未复制任何第三方仓库的代码或素材：

| 部分 | 文件 | 说明 |
|---|---|---|
| 游戏引擎 | `js/game.js` | 物理、管道生成、碰撞、粒子、角色绘制、WebAudio 音效，全部手写 |
| 实时检测 | `js/detector.js` | 因果滤波 + 滑动稳健基线 + 双通道同向合成 + 双阈值状态机 |
| 滤波器 | `js/filter.js` | RBJ 双二阶（biquad）级联，陷波/带通/低通 |
| 数据源 | `js/sources.js` | 合成 EEG、CSV 回放、Web Serial(OpenBCI)、WebSocket 四种 |
| 界面 | `index.html` / `css/style.css` | 原创布局、配色、图标（内联 SVG） |
| 桥接器 | `tools/bridge.py` | EEG → 眨眼事件 → WebSocket 推送 |

角色形象为原创的黄色圆鸟（内联 SVG 与 Canvas 绘制），**不是**任何现有游戏角色的复刻。

---

## 2. 玩法与名称的边界

- **玩法机制不受著作权保护。**「重力下落 + 点击/按键振翅 + 穿越管道」属于通用游戏设计思想，任何人都可以实现，不构成侵权。
- **名称与角色形象受保护。**「Flappy Bird」的名称、原版小鸟/管道美术、音效归其权利人所有。
  因此本项目：
  - 产品名使用「眨眼小鸟 / Blink Bird」，不使用「Flappy Bird」作为名称或商标；
  - 不使用原版任何图片、精灵图、音效文件；
  - 界面中仅以「玩法致敬」的方式提及，不暗示与官方存在关联、赞助或背书。

---

## 3. 参考过的第三方项目（逐个核对）

### 3.1 `nhooyr/flappybird`

- 地址：https://github.com/nhooyr/flappybird
- 许可证：**NC v1 License**（非标准开源许可）
- 关键条款（原文摘要）：
  - 仅授权**个人娱乐与教育用途**；
  - 任何整体或部分复制**必须保留该许可声明**并署名原作者；
  - **明确禁止商业用途**；商用需单独联系作者获取商业许可。
- 本项目如何处理：
  - **未复制其任何代码或素材**（本项目游戏逻辑、渲染、音效均独立编写）；
  - 仅参考了「振翅/管道」这一通用玩法，属于思想层面，不落入其许可范围；
  - 若你日后希望直接复用它的代码，则必须遵守 NC v1：保留署名 + 不得商用。

### 3.2 `Technolegend4/brain`

- 地址：https://github.com/Technolegend4/brain
- 许可证：**仓库中没有 LICENSE 文件**（GitHub API 返回 `license: null`）
- 法律含义：无许可声明 = 默认**保留所有权利**（All Rights Reserved）。严格来说，未经作者书面许可，他人不得复制、修改、分发。
- 仓库内容：`blink-detector/`（Python 眨眼检测）、`muse-eeg-pipeline/`（Muse EEG 流水线）。
- 本项目如何处理：
  - 本项目的 `blink-detector/` 与之同源，`js/detector.js` 是其**思路的 JavaScript 重写**（因果化改造，非逐行翻译）；
  - **若该仓库属于你本人**，则不受此限，可自由使用；
  - **若不属于你**，商用或公开分发前必须取得作者授权，或将该部分替换为独立实现。

### 3.3 `ljz15133665372-glitch/scheduled-flappy-bird`

- 地址：https://github.com/ljz15133665372-glitch/scheduled-flappy-bird
- 在线演示：https://ljz15133665372-glitch.github.io/scheduled-flappy-bird/
- 许可证：**仓库中没有 LICENSE 文件**（`license: null`），同样默认保留所有权利。
- 观察：该仓库内包含 `brain-main/` 目录，内容与 3.2 的 `Technolegend4/brain` 高度一致（疑似 fork / 二次上传），另有 `scheduled_flappy_bird.html`。
- 本项目如何处理：**未复制其任何代码或素材**，仅把它作为「定时跳跃」玩法的参考。

### 3.4 数据集 `EEG-EyeBlinks`

- 出处：Mohit Agarwal, Raghupathy Sivakumar, *BLINK: A Fully Automated Unsupervised Algorithm for Eye-Blink Detection in EEG Signals*, Allerton 2019.
- 授权：数据集声明「freely available for research use」，**仅限研究用途**，使用时须引用上述论文。
- 本项目如何处理：仅在 `--demo` / 自检中读取本地 CSV 做算法验证，不再分发数据文件本身。

---

## 4. 结论与建议

| 使用场景 | 是否可行 | 前置条件 |
|---|---|---|
| 个人学习、课堂演示、科研实验 | ✅ 可行 | 保留本 NOTICE 与数据集引用 |
| 公开发布代码（GitHub 等） | ⚠️ 需确认 | 确认 3.2 的 `brain` 仓库归属；若为他人作品需授权或替换实现 |
| 商用 / 收费 / 商业产品内置 | ❌ 当前不可 | 必须移除任何受 NC v1 影响的成分，并取得 3.2、3.3 作者授权 |
| 直接复用 `nhooyr/flappybird` 代码 | ❌ 商用不可 | 个人/教育用途可用，但须保留其许可声明与署名 |

---

## 5. 免责声明

本项目按「现状」提供，不附带任何明示或暗示担保。使用本项目造成的任何直接或间接损失，作者不承担责任。
若你是上述任一仓库的权利人并认为本项目存在不当使用，请通过仓库 Issue 联系，我们会在核实后立即处理。
