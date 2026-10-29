# Brain — Muse EEG 实时脑机接口流水线

从 muse-js 的原始 `eegReadings` 一路走到分类结果与反馈输出的完整实现。
**全部算法为原生 JavaScript 手写，零第三方依赖**，单个 HTML 文件即可运行。

仓库里还有第二个项目 **[Blink Bird](#blink-bird眨眼驱动的-flappy-bird)**：把真实采集的脑电数据喂进去，
眨眼就能让小鸟振翅，下方同步画出多通道波形与眨眼标记。

```
muse-js 原始包(4 通道 × 12 样本)
   → 带通 + 陷波 → 去伪迹(回归 + FastICA) → FFT 频带特征
   → 分类器(LDA / SVM / MLP) → 反馈(界面 + HTTP POST)
```

## 快速开始

直接双击打开 **[`outputs/muse-eeg-pipeline.html`](outputs/muse-eeg-pipeline.html)**，无需服务器、无需安装任何依赖。

1. 点 **▶ 开始采集** —— 左上 6 个流程步骤会随数据流动依次点亮
2. 点 **🎯 校准** —— 自动采集 4 秒睁眼 + 4 秒闭眼并训练分类器
3. 观察 **分类输出** —— 闭眼时判为「闭眼 / α 增强」
4. 点 **👁 注入眨眼** 看去伪迹效果，点 **⚡ 注入工频** 看陷波效果

> 想看算法对比：关掉「陷波」，PSD 上会立刻竖起 50 Hz 尖峰；关掉「ICA / 回归」，眨眼时波形会出现巨大低频摆动。

## 算法实现

| 模块 | 内容 |
|---|---|
| **滤波** | RBJ 双二阶 + Transposed DF-II 流式处理，Butterworth 带通 2/4/6/8 阶，50/100 Hz 谐波陷波（Q 可调） |
| **去伪迹** | 一级：AF7/AF8 作 EOG 代理的多元回归扣除；二级：FastICA（tanh 不动点）+ 峰度/低频占比/眼电相关三重判据剔除成分 |
| **特征** | Welch PSD；δ/θ/α/β/γ 频带功率、相对功率、α/β 比、谱熵、Hjorth 参数；向量 5 / 20 / 29 维可选 |
| **分类** | z-score 标准化 → 自适应 PCA 降维 → LDA（正则化闭式解）/ Pegasos SVM / MLP，带留一法交叉验证 |
| **信号源** | 内置模拟器（1/f 噪声 + α 颤动 + 工频 + 双指数眨眼模板），也支持粘贴真实 muse-js 包或实时接入设备 |

## 接入真实 Muse 设备

页面已内置设备入口，逐电极攒齐 4 通道后自动推进流水线：

```js
import { MuseClient } from 'muse-js';
const client = new MuseClient();
await client.connect();
await client.start();
client.eegReadings.subscribe(function (reading) {
  // electrode: 0=TP9 1=AF7 2=AF8 3=TP10，与页面通道顺序一致
  window.EEG.feedPacket(reading);      // 也可用 feedPackets([...]) 批量喂入
});
```

`feedPacket` 兼容字段别名：通道取 `eegChannel` / `channel` / `electrode`，样本取 `samples` / `values` / `data`。

离线回放则更简单：把 `eegReadings` 序列 JSON 化后粘贴到页面左侧「粘贴真实 muse-js 包」，点开始采集即可。

## 目录结构

```
outputs/                      构建产物（可直接运行 / 分享）
├── muse-eeg-pipeline.html    单文件应用，自包含无外部依赖
└── muse-eeg-pipeline.md      完整说明文档（算法细节、参数、验证数据）

muse-eeg-pipeline/            源码工程
├── build.ps1                 合并 src → 单个 HTML
├── src/
│   ├── index.html            UI 结构与样式
│   └── js/                   按流水线阶段拆分的 6 个模块
├── tools/
│   ├── selfcheck.js          算法数值自检（14 项）
│   └── smoke-ui.js           端到端 DOM 冒烟测试（48 项）

blink-flappy/                 眨眼驱动的 Flappy Bird（另见下文）
├── index.html                工作台：上方游戏 + 下方三通道波形
├── js/                       检测器、游戏、信号源、装配层
├── tools/                    自检、行为回归、DOM 冒烟、离线评估
├── README.md                 使用说明与算法细节
└── NOTICE.md                 第三方素材许可说明
```

## 重新构建与验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File muse-eeg-pipeline\build.ps1
node muse-eeg-pipeline\tools\selfcheck.js
node muse-eeg-pipeline\tools\smoke-ui.js
```

## 验证结果

**算法自检 14/14 通过**

| 项目 | 实测 |
|---|---|
| 50 Hz 工频衰减 | 61.2 dB |
| 眨眼去除（回归 → ICA） | 42.6 µV → 10.9 µV → 7.1 µV |
| 闭眼 vs 睁眼 α 相对功率 | 47% vs 18% |
| LDA / SVM / MLP 留一法准确率 | 98% / 95% / 95% |
| 500 次在线推理耗时 | 12 ms |

**页面端到端冒烟 48/48 通过** —— 覆盖实时采集、分析窗口、ICA 表格、一键校准（LDA 训练 94% / LOO 94%）、模型热切换、开关联动、HTTP 反馈、JSON 回放、真实设备接入、状态重置。

## Blink Bird：眨眼驱动的 Flappy Bird

`blink-flappy/` 是一个独立的小应用：**把真实脑电数据输进去，眨眼就让小鸟振翅**。

- **数据**：EEG-EyeBlinks 公开数据集（EEG-IO / EEG-VR / EEG-VV 三组，Fp1/Fp2，250 Hz）
- **检测**：0.5–8 Hz 带通 → 双阈值状态机（迟滞 + 不应期）→ onset 双闸门
- **同步**：眨眼事件带强度分（3–10 σ），强度直接映射成振翅升力
- **可视化**：FP1 / FP2 / 检测分数三条通道，眨眼画成贯穿竖线 + `BLINK` 标记，线宽和色相跟随强度
- **回放**：1×–8× 调速、进度条、眨眼计数；载入 CSV 后自动连接、自动开局，撞管道 1.5 秒自动重开

全数据集（46 被试 / 2035 次眨眼）离线评估：

| 子集 | 被试 | 召回 | 精确 | F1 |
|---|---|---|---|---|
| EEG-IO | 20 | 0.864 | 0.888 | 0.876 |
| EEG-VR | 13 | 0.928 | 0.913 | 0.920 |
| EEG-VV | 13 | 0.864 | 0.849 | 0.856 |
| **合计** | **46** | **0.885** | **0.881** | **0.883** |

直接双击 `blink-flappy/index.html` 即可运行，无需安装依赖；没有硬件时选「合成 EEG」，按空格注入眨眼。

第三方素材与许可见 [`blink-flappy/NOTICE.md`](blink-flappy/NOTICE.md)（游戏玩法参考 `nhooyr/flappybird`，NC 许可，本项目代码为原创）。

## 能力边界

这是一个**状态解码**演示系统，输出为二分类（睁眼 / 闭眼）。它**不是**脑电语义解码器——
4 通道消费级干电极的信息带宽，不足以支撑把脑电「翻译」成文字或语言，这与调参无关。
在合理预期内可稳定解码的目标是：睁眼/闭眼、眨眼事件、肌肉活动、专注度/困倦倾向等状态量。

详见 [`outputs/muse-eeg-pipeline.md`](outputs/muse-eeg-pipeline.md) 第 7 节「已知限制」。
