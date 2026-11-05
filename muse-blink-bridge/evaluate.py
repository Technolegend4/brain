# -*- coding: utf-8 -*-
"""
眨眼检测精度评估脚本  evaluate.py
=====================================================================
用 EEG-EyeBlinks 数据集的官方标签评估 blink_detector.py 的精度。

标签格式（见 EEG-EyeBlinks/*/README.md 与 read_data.py 的 decode_stim）
    corrupt, <n>     n = 损坏区间个数
    <start>, <end>   损坏区间起止(秒)，end = -1 表示直到数据结尾
    blinks           标记眨眼列表开始
    <time>, <code>   眨眼中点(秒) 与类型(0=自发 1=刺激诱发 2=轻微)

指标
    TP 命中 / FN 漏检 / FP 误检
    落在"损坏区间"内的检出不计为误检（记为 corr），因为该段数据本身不可用
    recall = TP/(TP+FN)          precision = TP/(TP+FP)

用法
    py evaluate.py <数据根目录或单个data文件> [--tol 0.3] [--k 3.0]
                   [--polarity auto] [--csv 输出.csv] [--md 报告.md]
=====================================================================
"""

from __future__ import annotations

import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import blink_detector as bd


# ------------------------------------------------------------------ #
#  标签解析（对应官方 read_data.py 的 decode_stim）
# ------------------------------------------------------------------ #
def parse_labels(path, t_end=None):
    """返回 (corrupt_intervals, blinks)。blinks 为 [(time, code), ...]。"""
    corrupt, blinks = [], []
    n_corrupt = 0
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        for row in csv.reader(f):
            if not row:
                continue
            key = row[0].strip()
            # "blinks" 标记行：损坏区间列表到此结束，把计数清零，避免其后的
            # 眨眼数据行(同样是"两个数字"的格式)被误当成损坏区间
            if key.lower().startswith("blink"):
                n_corrupt = 0
                continue
            if key.lower().startswith("corrupt"):
                n_corrupt = int(float(row[1])) if len(row) > 1 and row[1].strip() else 0
            elif n_corrupt > 0:
                try:
                    a, b = float(row[0]), float(row[1])
                except (ValueError, IndexError):
                    n_corrupt = 0
                    if len(row) >= 2 and row[1].strip():
                        blinks.append((float(row[0]), int(float(row[1]))))
                    continue
                if b == -1:
                    b = t_end if t_end is not None else float("inf")
                corrupt.append((a, b))
                n_corrupt -= 1
            else:
                if len(row) >= 2 and row[1].strip():
                    blinks.append((float(row[0]), int(float(row[1]))))
    return corrupt, np.array(blinks, dtype=float) if blinks else np.zeros((0, 2))


def in_corrupt(t, intervals):
    for a, b in intervals:
        if a <= t <= b:
            return True
    return False


# ------------------------------------------------------------------ #
#  匹配
# ------------------------------------------------------------------ #
def match(dets, gts, tol):
    """贪心最近邻匹配。返回 (matched_gt_idx 集合, 每个检出是否命中)。"""
    if len(dets) == 0 or len(gts) == 0:
        return set(), np.zeros(len(dets), dtype=bool)
    pairs = sorted((abs(float(d) - float(g)), i, j)
                   for i, d in enumerate(dets) for j, g in enumerate(gts))
    used_gt, is_tp = set(), np.zeros(len(dets), dtype=bool)
    for dist, i, j in pairs:
        if dist > tol:
            break
        if is_tp[i] or j in used_gt:
            continue
        is_tp[i] = True
        used_gt.add(j)
    return used_gt, is_tp


def evaluate_pair(data_path, label_path, k, tol, polarity, band=None,
                  consistency=True, refractory=0.4, gate=None, verbose=False):
    header, t, fs, chans = bd.load_and_prepare(data_path)
    corrupt, blinks = parse_labels(label_path, t_end=float(t[-1]))
    gts = blinks[:, 0] if blinks.size else np.zeros(0)

    res, score, note = bd.detect(chans, fs, k=k, refractory_s=refractory,
                                 polarity=polarity, consistency=consistency,
                                 band=band or bd.BAND,
                                 gate=bd.GATE_S if gate is None else gate)
    dets = t[res["peak_idx"]]

    matched_gt, is_tp = match(dets, gts, tol)
    tp = int(is_tp.sum())
    fp = int((~is_tp).sum())
    fn = len(gts) - len(matched_gt)
    # 落在损坏区间内的非命中检出不算误检
    corr = int(sum(1 for d, ok in zip(dets, is_tp)
                   if (not ok) and in_corrupt(float(d), corrupt)))
    fp_eff = fp - corr

    errs = []
    for i, d in enumerate(dets):
        if is_tp[i]:
            j = int(np.argmin(np.abs(gts - d)))
            errs.append(abs(float(d) - gts[j]))

    rec = tp / len(gts) if len(gts) else float("nan")
    prec = tp / (tp + fp_eff) if (tp + fp_eff) else float("nan")
    if rec == rec and prec == prec and (prec + rec) > 0:
        f1 = 2 * prec * rec / (prec + rec)
    else:
        f1 = float("nan")
    return {
        "file": os.path.basename(data_path),
        "n_gt": len(gts),
        "n_det": len(dets),
        "tp": tp, "fn": fn, "fp": fp, "fp_eff": fp_eff, "corrupt_det": corr,
        "recall": rec, "precision": prec, "f1": f1,
        "median_err": float(np.median(errs)) if errs else float("nan"),
        "polarity": note,
        "fs": fs, "dur": float(t[-1] - t[0]),
    }


# ------------------------------------------------------------------ #
#  批量
# ------------------------------------------------------------------ #
def collect_pairs(roots):
    pairs = []
    for root in roots:
        if os.path.isfile(root):
            lab = root.replace("_data", "_labels")
            if "_labels" in root:
                lab = root
                root = root.replace("_labels", "_data")
            if lab == root:
                print("跳过非 *_data.csv / *_labels.csv 文件：%s" % root)
                continue
            if os.path.isfile(root) and os.path.isfile(lab):
                pairs.append((root, lab))
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in sorted(files):
                if fn.endswith("_data.csv"):
                    lab = os.path.join(dirpath, fn.replace("_data", "_labels"))
                    if os.path.isfile(lab):
                        pairs.append((os.path.join(dirpath, fn), lab))
    return sorted(pairs)


def main(argv=None):
    ap = argparse.ArgumentParser(description="眨眼检测精度评估")
    ap.add_argument("roots", nargs="*", default=["EEG-EyeBlinks"],
                    help="数据根目录或 *_data.csv 文件")
    ap.add_argument("--tol", type=float, default=0.3, help="匹配容差(秒)")
    ap.add_argument("--k", type=float, default=bd.THRESHOLD_K)
    ap.add_argument("--refractory", type=float, default=bd.REFRACTORY_S)
    ap.add_argument("--gate", type=float, default=bd.GATE_S)
    ap.add_argument("--polarity", default="auto")
    ap.add_argument("--no-consistency", action="store_true")
    ap.add_argument("--band", default=None)
    ap.add_argument("--csv", default=None, help="逐文件结果输出 CSV")
    ap.add_argument("--md", default=None, help="Markdown 报告输出路径")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    band = None
    if args.band:
        lo, hi = [float(v) for v in args.band.split(",")[:2]]
        band = (lo, hi)

    pairs = collect_pairs(args.roots)
    if not pairs:
        print("未找到 *_data.csv / *_labels.csv 配对")
        return 2

    print("评估参数：k=%.2f  gate=%.2f  tol=%.2fs  极性=%s  通道一致性=%s  带通=%s"
          % (args.k, args.gate, args.tol, args.polarity, not args.no_consistency,
             band or bd.BAND))
    print("=" * 96)
    hdr = ("%-16s %5s %5s %5s %5s %5s %5s %5s  %6s %6s %6s  %6s"
           % ("file", "GT", "det", "TP", "FN", "FP", "inCorr", "FPeff",
              "rec", "prec", "F1", "err(s)"))
    print(hdr)
    print("-" * 104)

    rows = []
    for data_path, label_path in pairs:
        try:
            r = evaluate_pair(data_path, label_path, args.k, args.tol,
                              args.polarity, band=band,
                              consistency=not args.no_consistency,
                              refractory=args.refractory, gate=args.gate)
        except Exception as e:
            print("%-16s  [ERROR] %s" % (os.path.basename(data_path), e))
            continue
        rows.append(r)
        print("%-16s %5d %5d %5d %5d %5d %5d %5d  %6.3f %6.3f %6.3f  %6.3f"
              % (r["file"], r["n_gt"], r["n_det"], r["tp"], r["fn"], r["fp"],
                 r["corrupt_det"], r["fp_eff"], r["recall"], r["precision"],
                 r["f1"], r["median_err"]))

    if not rows:
        return 1

    tp = sum(r["tp"] for r in rows)
    fn = sum(r["fn"] for r in rows)
    fp = sum(r["fp_eff"] for r in rows)
    corr = sum(r["corrupt_det"] for r in rows)
    ngt = sum(r["n_gt"] for r in rows)
    ndet = sum(r["n_det"] for r in rows)
    rec = tp / ngt if ngt else float("nan")
    prec = tp / (tp + fp) if (tp + fp) else float("nan")
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else float("nan")
    errs = [r["median_err"] for r in rows if r["median_err"] == r["median_err"]]

    print("-" * 96)
    print("汇总：文件=%d  GT眨眼=%d  检出=%d  TP=%d  FN=%d  FP=%d(另%d在损坏区间内)"
          % (len(rows), ngt, ndet, tp, fn, fp, corr))
    print("      recall=%.4f  precision=%.4f  F1=%.4f  各文件中位误差=%.3f s"
          % (rec, prec, f1, float(np.mean(errs)) if errs else float("nan")))
    print("=" * 96)

    if args.csv:
        with open(args.csv, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow({k: (round(v, 4) if isinstance(v, float) else v)
                            for k, v in r.items()})
        print("逐文件结果已保存：%s" % os.path.abspath(args.csv))

    if args.md:
        with open(args.md, "w", encoding="utf-8") as f:
            f.write("# 眨眼检测精度评估\n\n")
            f.write("参数：k=%.2f，同向门限 gate=%.2f，匹配容差=%.2fs，极性=%s，带通=%s\n\n"
                    % (args.k, args.gate, args.tol, args.polarity, band or bd.BAND))
            f.write("**汇总**：GT 眨眼 %d，检出 %d，TP %d，FN %d，FP %d"
                    "（另有 %d 个检出落在标注损坏区间内）\n\n"
                    % (ngt, ndet, tp, fn, fp, corr))
            f.write("recall = %.4f，precision = %.4f，F1 = %.4f\n\n"
                    % (rec, prec, f1))
            f.write("| 文件 | GT | 检出 | TP | FN | FP | 落在损坏区间 | 有效FP | recall | precision | F1 | 中位误差(s) |\n")
            f.write("|---|---|---|---|---|---|---|---|---|---|---|---|\n")
            for r in rows:
                f.write("| %s | %d | %d | %d | %d | %d | %d | %d | %.3f | %.3f | %.3f | %.3f |\n"
                        % (r["file"], r["n_gt"], r["n_det"], r["tp"], r["fn"],
                           r["fp"], r["corrupt_det"], r["fp_eff"],
                           r["recall"], r["precision"], r["f1"],
                           r["median_err"]))
        print("报告已保存：%s" % os.path.abspath(args.md))
    return 0


if __name__ == "__main__":
    sys.exit(main())
