/* ============================================================
   selftest.js — 无浏览器的算法自检
   ------------------------------------------------------------
   运行（macOS 自带 jsc）：
     cd blink-flappy
     /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/selftest.js

   检查项：
     1. 模块能否加载（语法/依赖）
     2. 滤波器频响（50 Hz 抑制、通带增益）
     3. 合成信号闭环：检测召回 / 误报 / 延迟
     4. 真实 EEG 数据：与 EEG-EyeBlinks 标签比对（可选，存在才跑）
   ============================================================ */
"use strict";

load("js/util.js");
load("js/filter.js");
load("js/detector.js");
load("js/synth.js");
load("js/sources.js");

const BB = globalThis.BB;
const U = BB.util;

let pass = 0;
let fail = 0;

function ok(cond, name, detail) {
  if (cond) {
    pass++;
    print("  ✓ " + name + (detail ? "  " + detail : ""));
  } else {
    fail++;
    print("  ✗ " + name + (detail ? "  " + detail : ""));
  }
}

function section(t) {
  print("\n" + t);
}

/* ============================================================
   1. 加载检查
   ============================================================ */
section("[1] 模块加载");
ok(!!BB.util, "util.js");
ok(!!BB.filter, "filter.js");
ok(!!BB.BlinkDetector, "detector.js");
ok(!!BB.BlinkSynth, "synth.js");
ok(!!BB.sources, "sources.js");
ok(typeof BB.sources.parseEegCsv === "function", "CSV 解析器可用");

/* ============================================================
   2. 滤波器频响
   ============================================================ */
section("[2] 滤波器频响 (fs=250)");
{
  const fs = 250;
  const chain = new BB.filter.FilterChain(fs, {
    notchHz: 50,
    notchOn: true,
    highpassHz: 0.5,
    lowpassHz: 8,
    order: 2,
  });

  const resp = (f) => {
    let m = 1;
    for (const st of chain.stages) m *= BB.filter.biquadResponse(st, f, fs);
    return m;
  };

  const db = (f) => 20 * Math.log10(Math.max(resp(f), 1e-12));

  const at1 = db(1.0);
  const at3 = db(3.0);
  const at50 = db(50);
  const at20 = db(20);

  ok(Math.abs(at1) < 1.5, "1 Hz 通带增益", at1.toFixed(2) + " dB");
  ok(Math.abs(at3) < 2.0, "3 Hz 通带增益", at3.toFixed(2) + " dB");
  ok(at50 < -40, "50 Hz 陷波抑制", at50.toFixed(1) + " dB");
  ok(at20 < -6, "20 Hz 已被低通压制", at20.toFixed(1) + " dB");
}

/* ============================================================
   3. 合成信号闭环
   ============================================================ */
section("[3] 合成信号闭环（120 s）");
{
  const fs = 250;
  const synth = new BB.BlinkSynth({ fs, meanInterval: 3.0, seed: 7 });
  const det = new BB.BlinkDetector({ fs, refractoryMs: 400 });

  const detected = [];
  det.on("blink", (e) => detected.push(e));
  det.on("onset", (e) => {
    /* onset 事件也记录，用于延迟统计 */
  });

  const truth = [];
  synth.onSpawn = (rec) => truth.push(rec.t0);

  const dur = 120;
  const N = dur * fs;
  for (let i = 0; i < N; i++) {
    const s = synth.step();
    det.push(s.x0, s.x1, (i * 1000) / fs);
  }

  // 匹配：每个检测事件找最近的未匹配真值，窗口 ±450 ms
  const tol = 0.45;
  const used = new Set();
  let tp = 0;
  const lags = [];
  for (const d of detected) {
    const tDet = d.tPeak / 1000;
    let best = -1;
    let bestErr = Infinity;
    for (let k = 0; k < truth.length; k++) {
      if (used.has(k)) continue;
      const err = Math.abs(tDet - truth[k]);
      if (err < bestErr) {
        bestErr = err;
        best = k;
      }
    }
    if (best >= 0 && bestErr <= tol) {
      used.add(best);
      tp++;
      lags.push((tDet - truth[best]) * 1000);
    }
  }
  const fp = detected.length - tp;
  const fn = truth.length - tp;
  const recall = truth.length ? tp / truth.length : 0;
  const precision = detected.length ? tp / detected.length : 0;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  lags.sort((a, b) => a - b);
  const medLag = lags.length ? lags[lags.length >> 1] : NaN;
  const p90 = lags.length ? lags[Math.floor(lags.length * 0.9)] : NaN;

  print(
    "    真值 " + truth.length + "，检测 " + detected.length +
      "，TP " + tp + "，FP " + fp + "，FN " + fn
  );
  print(
    "    recall " + (recall * 100).toFixed(1) + "%  precision " +
      (precision * 100).toFixed(1) + "%  F1 " + (f1 * 100).toFixed(1) + "%"
  );
  print(
    "    峰值-真值延迟 中位 " + (medLag || 0).toFixed(0) + " ms  P90 " + (p90 || 0).toFixed(0) + " ms"
  );

  ok(recall > 0.85, "召回率 > 85%", (recall * 100).toFixed(1) + "%");
  ok(precision > 0.85, "精确率 > 85%", (precision * 100).toFixed(1) + "%");
  ok(
    medLag > -80 && medLag < 260,
    "延迟落在合理区间",
    (medLag || 0).toFixed(0) + " ms"
  );
}

/* ============================================================
   4. 真实 EEG 数据（可选）
   ============================================================ */
section("[4] 真实数据比对");
{
  const dataPath = "../EEG-EyeBlinks 5/EEG-IO/S00_data.csv";
  const labelPath = "../EEG-EyeBlinks 5/EEG-IO/S00_labels.csv";

  let has = false;
  try {
    // jsc 提供 read()；文件不存在会抛错
    read(labelPath);
    has = true;
  } catch (e) {
    has = false;
  }

  if (!has) {
    print("    （未找到 EEG-EyeBlinks 数据，跳过）");
  } else {
    const text = read(dataPath);
    const parsed = BB.sources.parseEegCsv(text, "S00_data.csv");
    print(
      "    " + parsed.format + " · " + parsed.fs.toFixed(1) + " Hz · " +
        parsed.ch0.length + " 点 · " + parsed.duration.toFixed(1) + " s"
    );

    // 解析标签：跳过 corrupt 段，取 blinks 之后每行第一个字段
    const truth = [];
    const lines = read(labelPath).split("\n");
    let inBlink = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^blinks/i.test(line)) {
        inBlink = true;
        continue;
      }
      if (!inBlink) continue;
      const v = parseFloat(line.split(",")[0]);
      if (Number.isFinite(v)) truth.push(v);
    }

    const det = new BB.BlinkDetector({ fs: parsed.fs, refractoryMs: 400 });
    const detected = [];
    det.on("blink", (e) => detected.push(e.tPeak / 1000));

    const n = parsed.ch0.length;
    for (let i = 0; i < n; i++) {
      det.push(parsed.ch0[i], parsed.ch1[i], (i * 1000) / parsed.fs);
    }

    const tol = 0.4;
    const used = new Set();
    let tp = 0;
    for (const t of detected) {
      let best = -1;
      let bestErr = Infinity;
      for (let k = 0; k < truth.length; k++) {
        if (used.has(k)) continue;
        const err = Math.abs(t - truth[k]);
        if (err < bestErr) {
          bestErr = err;
          best = k;
        }
      }
      if (best >= 0 && bestErr <= tol) {
        used.add(best);
        tp++;
      }
    }
    const recall = truth.length ? tp / truth.length : 0;
    const precision = detected.length ? tp / detected.length : 0;

    print(
      "    真值 " + truth.length + "，检测 " + detected.length + "，TP " + tp +
        "  →  recall " + (recall * 100).toFixed(1) +
        "%  precision " + (precision * 100).toFixed(1) + "%"
    );
    ok(recall > 0.7, "真实数据召回 > 70%", (recall * 100).toFixed(1) + "%");
    ok(precision > 0.7, "真实数据精确 > 70%", (precision * 100).toFixed(1) + "%");
  }
}

/* ============================================================
   汇总
   ============================================================ */
print("\n" + "=".repeat(52));
print("  通过 " + pass + " / " + (pass + fail) + (fail ? "  ✗ 有失败项" : "  ✓ 全部通过"));
print("=".repeat(52));

if (fail) throw new Error("自检未通过");
