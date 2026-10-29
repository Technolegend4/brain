# -*- coding: utf-8 -*-
"""
EEG 眨眼检测程序  blink_detector.py
=====================================================================
功能
    读取 EEG(脑电) 数据文件，自动识别前额电极通道(FP1/FP2 等)，
    检测"眨眼"事件，输出【什么时候眨眼】的时间点列表。

检测规则（按要求）
    * 只判断"是否发生眨眼"，不区分眨眼类型。
    * 一次眨眼报告后，其后 400 ms 内不再重复检测（不应期，REFRACTORY_S）。

检测原理（为什么这样判）
    眨眼是由眼球/眼睑运动产生的强远场电位，会同时出现在左右前额电极上
    （同向、同量级）；而肌电、电极噪声、运动伪迹等常只出现在单个通道，
    或正负极性不一致。因此本程序用"双通道一致性"判据：

        z1, z2  = 两个前额通道带通后除以各自的稳健标准差(MAD 估计)
        score   = min(pol * z1, pol * z2)          # 两个通道都必须达到该幅度

    只有当【两个通道同时朝同一方向、且幅度都超过阈值】时才算眨眼，
    从而天然抑制单通道伪迹（例如本数据集 11.5s 处 FP1 单独 +14σ 的伪迹）。
    眨眼极性 pol 由数据自动判定（见 detect_polarity），无需事先知道
    正/负向上跳是眨眼，适配不同导联与参考方式。

---------------------------------------------------------------------
【接受数据的地方】三种方式，任选其一
    1) 命令行传入文件:      py blink_detector.py 我的脑电数据.csv
    2) 改下方 CONFIG 的    INPUT_FILE = r"我的脑电数据.csv"
    3) 交互式:             直接运行 py blink_detector.py，程序会提示你输入路径

数据格式：见同目录下的 data_template.csv（分号或逗号分隔均可）
    必需：一列时间(秒) + 至少 1 个 EEG 通道(推荐 2 个前额通道，如 FP1/FP2)
    建议：一列采样率(可只写第一行)
---------------------------------------------------------------------
输出
    * 控制台：总眨眼次数 + 每次眨眼时间(秒)
    * 文件  ：blink_results.csv — 序号 / 时间 / 起止 / 时长 / 峰值得分
                       （用 --out 可自定路径）

依赖：numpy(必需)  scipy(推荐)  matplotlib(可选，--plot 画图)
=====================================================================
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys

import numpy as np

try:
    from scipy import signal as sps
    _HAS_SCIPY = True
except Exception:  # pragma: no cover
    _HAS_SCIPY = False


# ====================== CONFIG：接受数据的地方 ======================
INPUT_FILE = "data_template.csv"   # 默认输入(命令行参数会覆盖它)
FRONTAL_CHANNELS = ["FP1", "FP2"]  # 优先用于检测的前额通道名
DEFAULT_FS = 250.0                 # 文件未标注采样率时的默认值 (Hz)
BAND = (0.5, 8.0)                  # 带通频段 (Hz)：留眨眼慢波，去基线漂移与工频
THRESHOLD_K = 3.0                  # 阈值系数：较强通道需超过 k 倍稳健标准差
GATE_S = 2.0                       # 双通道同向"门限"：两通道都必须超过此幅度(稳健标准差)
REFRACTORY_S = 0.4                 # 不应期(秒)：一次眨眼后 400ms 内不再检测【需求】
SMOOTH_S = 0.06                    # 平滑窗(秒)
MIN_WIDTH_S = 0.05                 # 最小事件宽度(秒)，滤单点尖刺
BELOW = -1.0                       # 门限未通过时的得分(低于任何阈值，且便于绘图)
POLARITY = "auto"                  # 眨眼极性: auto | neg | pos | both
CONSISTENCY = True                 # True=要求双通道一致(推荐)；False=只取单通道幅度
# ===================================================================


# ------------------------------------------------------------------ #
#  一、数据读取与预处理
# ------------------------------------------------------------------ #
def is_number(v):
    try:
        float((v or "").strip())
        return True
    except (TypeError, ValueError):
        return False


def is_sample_index(t):
    """判断某列是不是"采样序号 0,1,2,..."（OpenBCI 原始数据的第一列）。"""
    t = np.asarray(t, dtype=float)
    if t.size < 3:
        return False
    d = np.diff(t)
    return bool(d.size and np.all(np.abs(d - 1.0) < 1e-9))


def fs_from_comments(comments):
    """从 `%Sample Rate = 250.0 Hz` 之类的注释行里取采样率。"""
    for c in comments:
        cl = c.lower()
        if "sample rate" in cl or "sampling rate" in cl or "采样率" in c:
            tail = c.split("=")[-1] if "=" in c else c
            m = re.findall(r"[-+]?\d*\.?\d+", tail)
            if m:
                try:
                    v = float(m[0])
                    if v > 0:
                        return v
                except ValueError:
                    pass
    return None


def read_table(path):
    """读表：跳过 `%` / `#` 注释行，自动识别编码、分隔符与有无表头。

    返回 (header, data, comments, has_header)
    * OpenBCI 原始文件（EEG-VR / EEG-VV）前 5 行是 `%` 注释，无表头 →
      自动生成列名 CH0, CH1, ...，并从注释里取采样率。
    * 普通 CSV（EEG-IO）有表头，按表头取列名。
    """
    text = None
    for enc in ("utf-8-sig", "utf-8", "gbk", "latin-1"):
        try:
            with open(path, "r", encoding=enc, newline="") as f:
                text = f.read()
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        raise IOError("无法读取文件：%s" % path)

    comments, body = [], []
    for ln in text.splitlines():
        s = ln.strip()
        if s == "":
            continue
        if s[0] in "%#":
            comments.append(s)
        else:
            body.append(ln)
    if not body:
        raise ValueError("文件为空：%s" % path)

    delim = max((";", ",", "\t"), key=lambda d: body[0].count(d))
    if body[0].count(delim) == 0:
        delim = ","

    rows = [r for r in csv.reader(body, delimiter=delim) if r]
    first = rows[0]
    n_num = sum(1 for c in first if is_number(c))
    has_header = n_num < max(1, len(first) // 2)
    if has_header:
        header = [c.strip() for c in first]
        data = rows[1:]
    else:
        header = ["CH%d" % i for i in range(len(first))]
        data = rows
    return header, data, comments, has_header


def to_float(v):
    v = (v or "").strip().strip('"')
    if v == "":
        return np.nan
    try:
        return float(v)
    except ValueError:
        return np.nan


def find_time_column(header):
    for i, h in enumerate(header):
        hl = h.lower()
        if "time" in hl or "时间" in hl:
            return i
    return 0  # 默认第一列为时间


def pick_eeg_columns(header, mat, has_header=True, max_channels=None):
    """挑出用于检测的 EEG 通道列：去掉时间列/采样率列/常量列；优先前额通道。

    * 有表头且存在 FP 开头的通道 → 只用这些通道。
    * 无表头（OpenBCI 原始文件）→ 取前 max_channels 个有效通道
      （第 0 列是采样序号已排除，第 1、2 列正是 Fp1/Fp2）。
    """
    time_col = find_time_column(header)
    keep = []
    for i, h in enumerate(header):
        if i == time_col:
            continue
        hl = h.lower()
        if "time" in hl or "时间" in h:
            continue
        if ("sampling" in hl and "rate" in hl) or "采样率" in h:
            continue
        keep.append(i)

    # 丢弃常量列（例如饱和或未接电极的通道）
    valid = []
    for i in keep:
        col = mat[:, i]
        col = col[np.isfinite(col)]
        if col.size > 1 and np.nanstd(col) > 0:
            valid.append(i)
    if not valid:
        valid = keep

    # 优先选择配置的前额通道（按名称前缀匹配）
    wanted = [c.strip().upper().replace(" ", "") for c in FRONTAL_CHANNELS]
    frontal = []
    for i in valid:
        name = header[i].strip().upper().replace(" ", "")
        for w in wanted:
            if name.startswith(w[:3]) and name[:2] == "FP":
                frontal.append(i)
                break
    if frontal:
        return frontal
    if not has_header:
        n = max_channels if max_channels else len(FRONTAL_CHANNELS)
        return valid[:n]
    return valid


def bandpass(x, fs, band):
    """带通滤波：优先 Butterworth(零相位)，无 scipy 时用 FFT 兜底。"""
    lo, hi = band
    lo = max(float(lo), 1e-3)
    hi = min(float(hi), fs / 2.0 * 0.99)
    if lo >= hi:
        return x - np.mean(x)
    if _HAS_SCIPY:
        sos = sps.butter(4, [lo, hi], btype="bandpass", fs=fs, output="sos")
        padlen = min(3 * (2 * len(sos) + 1), max(len(x) - 1, 1))
        try:
            return sps.sosfiltfilt(sos, x, padlen=padlen)
        except Exception:
            return sps.sosfilt(sos, x)
    X = np.fft.rfft(x - np.mean(x))
    f = np.fft.rfftfreq(len(x), 1.0 / fs)
    X[(f < lo) | (f > hi)] = 0.0
    return np.fft.irfft(X, len(x))


def moving_average(x, w):
    w = max(1, int(w))
    if w <= 1:
        return np.asarray(x, dtype=float).copy()
    return np.convolve(np.asarray(x, dtype=float), np.ones(w) / w, mode="same")


def robust_std(x):
    """稳健标准差估计：1.4826 * MAD，抗伪迹干扰。"""
    x = np.asarray(x, dtype=float)
    med = np.median(x)
    mad = np.median(np.abs(x - med))
    return med, 1.4826 * mad + 1e-12


def load_and_prepare(path, fs_override=None):
    """读文件 → 统一时间网格 → 返回 (header, t, fs, {通道名: 波形})。

    自动适配两类文件：
      1) 带表头的 CSV（EEG-IO）：`Time (s);FP1;FP2;...;Sampling Rate`
      2) OpenBCI 原始文件（EEG-VR/VV）：前 5 行 `%` 注释，无表头，
         第 0 列是采样序号（自动换算成秒），第 1、2 列是 Fp1/Fp2。
    """
    header, rows, comments, has_header = read_table(path)
    time_col = find_time_column(header)
    ncol = len(header)

    mat = np.full((len(rows), ncol), np.nan)
    for r, row in enumerate(rows):
        for c in range(min(len(row), ncol)):
            mat[r, c] = to_float(row[c])
    if mat.size == 0:
        raise ValueError("文件中没有数据行")

    # ---- 采样率：命令行 > 表头采样率列 > 文件注释 > 由时间列推算 > 默认 ----
    fs = fs_override
    if fs is None:
        for i, h in enumerate(header):
            hl = h.lower()
            if ("sampling" in hl and "rate" in hl) or "采样率" in h:
                col = mat[:, i]
                col = col[np.isfinite(col)]
                if col.size and col[0] > 0:
                    fs = float(col[0])
                break
    if fs is None:
        fs = fs_from_comments(comments)

    # ---- 时间列 ----
    t_raw = mat[:, time_col].astype(float).copy()
    idx = np.arange(len(t_raw))
    good = np.isfinite(t_raw)
    if not good.all():
        if good.sum() < 2:
            t_raw = idx / float(fs or DEFAULT_FS)
        else:
            t_raw = np.interp(idx, idx[good], t_raw[good])

    if is_sample_index(t_raw):
        # OpenBCI：第 0 列是采样序号 → 换算成秒
        if fs is None or not (fs > 0):
            fs = DEFAULT_FS
        t_raw = idx / float(fs)
    elif fs is None or not (fs > 0):
        dt = np.diff(t_raw)
        dt = dt[np.isfinite(dt) & (dt > 0)]
        fs = 1.0 / np.median(dt) if dt.size else DEFAULT_FS
    fs = float(fs)

    # ---- 通道选择 ----
    ch_cols = pick_eeg_columns(header, mat, has_header=has_header)
    if not ch_cols:
        raise ValueError("未找到可用的 EEG 通道")

    # ---- 重采样到均匀网格（原时间戳可能不均匀）----
    t_start, t_end = float(t_raw[0]), float(t_raw[-1])
    n_uni = max(int(round((t_end - t_start) * fs)) + 1, 2)
    t_uni = t_start + np.arange(n_uni) / fs

    chans = {}
    for i in ch_cols:
        col = mat[:, i].astype(float).copy()
        g = np.isfinite(col)
        if not g.all():
            col = np.interp(idx, idx[g], col[g]) if g.sum() >= 2 else np.zeros_like(col)
        name = header[i] or ("CH%d" % i)
        chans[name] = np.interp(t_uni, t_raw, col)

    return header, t_uni, fs, chans


# ------------------------------------------------------------------ #
#  二、检测核心
# ------------------------------------------------------------------ #
def normalize_channels(chans, fs, band=BAND):
    """每通道带通 + 稳健标准化 → {通道名: z 序列}。"""
    z = {}
    for name, sig in chans.items():
        y = bandpass(sig, fs, band)
        _, r = robust_std(y)
        z[name] = (y - np.median(y)) / r
    return z


def _event_regions(score, thr, fs, gap_s=0.15):
    """取 score 超阈值的连续段(允许 gap_s 内的小间断)，返回每段的峰值位置与幅度。"""
    above = score > thr
    idx = np.where(above)[0]
    if idx.size == 0:
        return np.array([], dtype=int), np.array([])
    gap = max(1, int(round(gap_s * fs)))
    groups, cur = [], [idx[0]]
    for i in idx[1:]:
        if i - cur[-1] <= gap:
            cur.append(i)
        else:
            groups.append(cur)
            cur = [i]
    groups.append(cur)
    peaks = np.array([g[int(np.argmax(score[g]))] for g in groups], dtype=int)
    amps = score[peaks]
    return peaks, amps


def _apply_refractory(peaks, amps, fs, refractory_s):
    """不应期去重：同一窗内保留幅度最大者。"""
    if peaks.size == 0:
        return peaks, amps
    order = np.argsort(-amps)
    kept = []
    for o in order:
        if all(abs(peaks[o] - peaks[j]) >= refractory_s * fs for j in kept):
            kept.append(o)
    kept = sorted(kept)
    return peaks[kept], amps[kept]


def detect_polarity(zs, fs, seed_k=2.5, top_n=20):
    """自动判定眨眼极性。

    做法：先按"双通道取较小值"找出最像眨眼的若干强事件（只看两路同时出现的偏转，
    天然排除单侧电极伪迹），再在这些事件上做**幅度加权符号投票**。

    为什么不用"整段能量谁大"：伪迹（大幅正向漂移）会盖过眨眼，
    实测会把 S05/S10 判成正向（真值是负向）。只看最强事件的符号最稳。

    返回 -1(负向) / +1(正向) / 0(无可用事件)。
    """
    if len(zs) < 2:
        return 0
    co = np.minimum(np.abs(zs[0]), np.abs(zs[1]))
    pk, amp = _event_regions(co, seed_k, fs)
    if pk.size == 0:
        return 0
    top = pk[np.argsort(-amp)[:top_n]]
    signed = (zs[0] + zs[1])[top]
    w = np.abs(signed)
    neg = float(w[signed < 0].sum())
    pos = float(w[signed > 0].sum())
    if neg == 0 and pos == 0:
        return 0
    return -1 if neg >= pos else 1


def _gate_score(a, b, gate):
    """双通道"同向门限"判据。

    两通道换算到同向后，**都必须**超过 gate（保证是同一次眨眼、同一方向，
    从而排除只出现在单侧的电极伪迹和反相漂移），且取两者中较强的一方作为得分，
    用于后续与阈值 k 比较（k > gate）。

    这样既不要求两路幅度一样大（接触不良的弱通道不会把真眨眼一起否掉），
    也比"两通道取较小值"（min）宽容得多：min 要求两路都达到阈值，
    实测会漏掉约 5% 的真眨眼。
    """
    ok = (a > gate) & (b > gate)
    return np.where(ok, np.maximum(a, b), BELOW)


def build_score(z, fs, polarity="auto", consistency=CONSISTENCY, gate=GATE_S):
    """构造检测得分 score（单位：稳健标准差）。

    consistency=True  : 同向门限判据 —— 两通道都必须同向超过 gate，
                        取较强通道幅度作为得分，再与阈值 k 比较（推荐）
    consistency=False : score = |z| —— 任一通道幅度够大即可（单通道数据用）

    返回值 (score, polarity_used, note)
    """
    names = list(z.keys())
    zs = [z[n] for n in names]
    w = max(1, int(round(SMOOTH_S * fs)))
    zs = [moving_average(v, w) for v in zs]

    if len(zs) < 2 or not consistency:
        if polarity in (-1, 1):
            score = polarity * zs[0]
        else:
            score = np.abs(zs[0])
        return score, polarity, "单通道模式(未启用一致性)"

    if polarity == "auto":
        pol = detect_polarity(zs, fs)
        if pol == 0:
            score = np.maximum(_gate_score(-zs[0], -zs[1], gate),
                               _gate_score(zs[0], zs[1], gate))
            return score, 0, "自动极性: 未锁定(正负均考虑)"
        score = _gate_score(pol * zs[0], pol * zs[1], gate)
        return score, pol, "自动极性: %s向" % ("负" if pol < 0 else "正")

    if polarity == "both":
        score = np.maximum(_gate_score(-zs[0], -zs[1], gate),
                           _gate_score(zs[0], zs[1], gate))
        return score, 0, "极性: 正负均考虑"
    pol = -1 if str(polarity) == "neg" else 1
    score = _gate_score(pol * zs[0], pol * zs[1], gate)
    return score, pol, "极性: %s向(指定)" % ("负" if pol < 0 else "正")


def find_blinks(score, fs, k=THRESHOLD_K, refractory_s=REFRACTORY_S,
                min_width_s=MIN_WIDTH_S):
    """在检测得分上找眨眼事件。

    返回 dict(peak_idx, onset_idx, offset_idx, score, threshold)
    """
    n = len(score)
    peaks, amps = _event_regions(score, k, fs)
    peaks, amps = _apply_refractory(peaks, amps, fs, refractory_s)

    # 最小宽度过滤：只滤掉孤立的单点尖刺
    if min_width_s > 0 and peaks.size:
        w = max(1, int(round(min_width_s * fs)))
        keep = []
        for p, a in zip(peaks, amps):
            a0, b0 = max(0, p - w), min(n - 1, p + w)
            if int(np.sum(score[a0:b0 + 1] > k)) >= 2:
                keep.append(True)
            else:
                keep.append(False)
        keep = np.array(keep, dtype=bool)
        peaks, amps = peaks[keep], amps[keep]

    # 各事件起止：得分降到阈值一半处
    half = k * 0.5
    onset, offset = [], []
    for p in peaks:
        a = p
        while a - 1 >= 0 and score[a - 1] >= half:
            a -= 1
        b = p
        while b + 1 < n and score[b + 1] >= half:
            b += 1
        onset.append(a)
        offset.append(b)

    return {
        "peak_idx": peaks,
        "onset_idx": np.array(onset, dtype=int) if onset else np.array([], int),
        "offset_idx": np.array(offset, dtype=int) if offset else np.array([], int),
        "score": amps,
        "threshold": float(k),
    }


def detect(chans, fs, k=THRESHOLD_K, refractory_s=REFRACTORY_S,
           polarity=POLARITY, consistency=CONSISTENCY, band=BAND,
           gate=GATE_S):
    """端到端：{通道名: 波形} → (结果 dict, 检测得分, 说明文字)。"""
    z = normalize_channels(chans, fs, band)
    score, pol_used, note = build_score(z, fs, polarity=polarity,
                                        consistency=consistency, gate=gate)
    res = find_blinks(score, fs, k=k, refractory_s=refractory_s)
    res["polarity"] = pol_used
    res["note"] = note
    res["z"] = z
    return res, score, note


# ------------------------------------------------------------------ #
#  三、输出
# ------------------------------------------------------------------ #
def save_results(path, t, res):
    pk = res["peak_idx"]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["blink_index", "blink_time_s", "onset_s", "offset_s",
                    "duration_ms", "peak_score_sd"])
        for i, p in enumerate(pk):
            a = res["onset_idx"][i]
            b = res["offset_idx"][i]
            w.writerow([i + 1,
                        round(float(t[p]), 4),
                        round(float(t[a]), 4),
                        round(float(t[b]), 4),
                        round(float(t[b] - t[a]) * 1000, 1),
                        round(float(res["score"][i]), 2)])


def try_plot(out_path, t, score, res):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        print("[提示] 未安装 matplotlib，跳过绘图。")
        return None
    fig, ax = plt.subplots(figsize=(16, 5))
    for name, zs in res.get("z", {}).items():
        ax.plot(t, zs, lw=0.6, color="0.75", label="%s (z)" % name)
    ax.plot(t, score, lw=1.0, color="tab:blue", label="score = min(polarity * z_ch)")
    ax.axhline(res["threshold"], color="tab:red", ls="--", lw=0.8,
               label="threshold k=%.1f SD" % res["threshold"])
    pk = res["peak_idx"]
    if len(pk):
        ax.plot(t[pk], score[pk], "rv", ms=7, label="detected blink (%d)" % len(pk))
    ax.set_xlabel("time (s)")
    ax.set_ylabel("robust z (SD)")
    ax.set_title("EEG blink detection  (n=%d, k=%.1f, refractory=%.0f ms)"
                 % (len(pk), res["threshold"], REFRACTORY_S * 1000))
    ax.legend(loc="upper right", fontsize=8)
    plt.tight_layout()
    plt.savefig(out_path, dpi=110)
    plt.close()
    return out_path


# ------------------------------------------------------------------ #
#  四、数据模板
# ------------------------------------------------------------------ #
def write_template(path, fs=250.0, duration=6.0, blink_times=(1.5, 3.0, 4.5)):
    """生成标准数据模板：分号分隔，S00 同款表头，内含 3 次合成眨眼。"""
    n = int(round(fs * duration))
    t = np.arange(n) / fs
    rng = np.random.default_rng(0)

    def make(base, blink_amp):
        x = base + 300.0 * np.sin(2 * np.pi * 0.2 * t) + rng.normal(0, 30, n)
        for bt in blink_times:
            s = int((bt - 0.20) * fs)
            e = int((bt + 0.20) * fs)
            if s < 0 or e >= n:
                continue
            seg = np.arange(s, e)
            g = np.exp(-0.5 * ((seg - 0.5 * (s + e)) / (0.10 * fs)) ** 2)
            x[s:e] -= blink_amp * g          # 眨眼 = 负向偏转
        return x

    fp1 = make(8000.0, 2500.0)
    fp2 = make(-8000.0, 1600.0)

    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Time (s)", "FP1", "FP2", "Sampling Rate"])
        for i in range(n):
            w.writerow(["%.10e" % t[i],
                        "%.10e" % fp1[i],
                        "%.10e" % fp2[i],
                        "%d" % fs if i == 0 else ""])


# ------------------------------------------------------------------ #
#  五、主程序
# ------------------------------------------------------------------ #
def main(argv=None):
    ap = argparse.ArgumentParser(
        description="EEG 眨眼检测：输入脑电数据，输出每次眨眼的时间(400ms 不应期)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("input", nargs="?", default=None,
                    help="EEG 数据文件路径(CSV)。不填则用 CONFIG 的 INPUT_FILE。")
    ap.add_argument("--fs", type=float, default=None, help="采样率(Hz)，覆盖文件标注")
    ap.add_argument("--k", type=float, default=THRESHOLD_K,
                    help="阈值系数，越大越严格")
    ap.add_argument("--gate", type=float, default=GATE_S,
                    help="双通道同向门限系数，两通道都需超过它")
    ap.add_argument("--refractory", type=float, default=REFRACTORY_S,
                    help="不应期(秒)")
    ap.add_argument("--polarity", default=POLARITY,
                    choices=["auto", "neg", "pos", "both"], help="眨眼极性")
    ap.add_argument("--no-consistency", action="store_true",
                    help="关闭双通道一致性要求(单通道数据自动关闭)")
    ap.add_argument("--band", default="%.1f,%.1f" % BAND,
                    help="带通频段 Hz，形如 0.5,8.0")
    ap.add_argument("--out", default=None, help="结果 CSV 输出路径")
    ap.add_argument("--plot", action="store_true", help="输出波形标记图 PNG")
    ap.add_argument("--make-template", nargs="?", const="data_template.csv",
                    default=None, metavar="PATH", help="生成数据模板后退出")
    args = ap.parse_args(argv)

    if args.make_template:
        write_template(args.make_template)
        print("已生成数据模板：%s" % os.path.abspath(args.make_template))
        return 0

    # ---------- 接受数据 ----------
    path = args.input or INPUT_FILE
    if not os.path.isfile(path):
        try:
            user_in = input("请输入 EEG 数据文件路径(CSV，可直接把文件拖进来): ")
        except EOFError:
            user_in = ""
        user_in = user_in.strip().strip('"').strip("'")
        if user_in:
            path = user_in
    if not os.path.isfile(path):
        print("[错误] 找不到数据文件：%s" % path)
        print("用法：py blink_detector.py <你的脑电数据.csv>")
        print("也可修改脚本顶部 INPUT_FILE，或用 py blink_detector.py --make-template 生成模板。")
        return 2

    try:
        lo, hi = [float(v) for v in args.band.split(",")[:2]]
        band = (lo, hi)
    except Exception:
        band = BAND

    print("=" * 64)
    print("EEG 眨眼检测")
    print("=" * 64)
    print("数据文件：%s" % os.path.abspath(path))

    header, t, fs, chans = load_and_prepare(path, args.fs)
    dur = float(t[-1] - t[0]) if len(t) else 0.0
    print("采样率  ：%g Hz      时长：%.2f s      样本：%d" % (fs, dur, len(t)))
    print("检测通道：%s" % ", ".join(chans.keys()))
    print("带通    ：%.2f - %.2f Hz      不应期：%.0f ms" % (band[0], band[1],
                                                              args.refractory * 1000))

    res, score, note = detect(chans, fs, k=args.k, refractory_s=args.refractory,
                              polarity=args.polarity,
                              consistency=not args.no_consistency, band=band,
                              gate=args.gate)

    print("判据    ：两通道同向 > %.1f SD 后取较强通道幅度  (%s)" % (args.gate, note))
    print("阈值    ：%.2f SD" % res["threshold"])
    print("-" * 64)

    pk = res["peak_idx"]
    if len(pk) == 0:
        print("未检测到眨眼。（可降低 --k，例如 --k 2.5）")
    else:
        print("共检测到 %d 次眨眼：" % len(pk))
        print("  %-4s %-12s %-12s %-12s %-10s" %
              ("序号", "眨眼时间(s)", "开始(s)", "结束(s)", "时长(ms)"))
        for i, p in enumerate(pk):
            a, b = res["onset_idx"][i], res["offset_idx"][i]
            print("  %-4d %-12.3f %-12.3f %-12.3f %-10.1f" %
                  (i + 1, t[p], t[a], t[b], (t[b] - t[a]) * 1000))
    print("-" * 64)

    out_csv = args.out or os.path.join(os.getcwd(), "blink_results.csv")
    save_results(out_csv, t, res)
    print("结果已保存：%s" % os.path.abspath(out_csv))

    if args.plot:
        out_png = os.path.splitext(out_csv)[0] + "_plot.png"
        out_png = try_plot(out_png, t, score, res)
        if out_png:
            print("波形图已保存：%s" % os.path.abspath(out_png))
    return 0


if __name__ == "__main__":
    sys.exit(main())
