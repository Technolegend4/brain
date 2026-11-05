# Scheduled Flappy Bird · 定时起跳实验版

一个零依赖、纯静态网页的实验集合：把「定时起跳」的玩法与 Muse EEG 实时脑机接口流水线放进同一个仓库，方便对照实验。

## 项目结构

```
.
├── index.html                       # 定时起跳 Flappy Bird 实验版（独立可玩）
└── brain-main/                      # Muse EEG 实时流水线
    ├── index.html
    ├── scheduled_flappy_bird.html
    ├── README.md                    # 流水线原始说明
    ├── outputs/muse-eeg-pipeline.html  # 单文件可运行版
    └── muse-eeg-pipeline/
        ├── build.ps1
        ├── src/                     # 滤波 / 去伪迹 / 特征 / 分类 / UI 模块
        └── tools/                   # 自检 & 冒烟脚本
```

## 本地运行

整个仓库是纯静态资源，**双击 `index.html` 即可在浏览器打开**，无需任何构建或服务器。

如果浏览器对本地文件有限制（例如 fetch `file://` 报错），可以临时起一个静态服务：

```powershell
cd scheduled-flappy-bird
python -m http.server 8080
# 然后访问 http://localhost:8080/
```

## 技术栈

- 原生 HTML + CSS + JavaScript（无构建系统、无第三方运行时依赖）
- Muse EEG 流水线使用 RBJ 双二阶滤波 / FastICA / Welch PSD / LDA-SVM-MLP，全部手写

## 许可

仅作实验用途，请在仓库根目录添加 LICENSE 文件后再公开发布。
