/* 诊断：VR/VV 的误检到底是"假阳性"还是"没标注的真眨眼" */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;
const ROOT = "../EEG-EyeBlinks 5/";
const SUBSETS = { "EEG-VR": "R", "EEG-VV": "V" };

function parseLabels(path) {
  const lines = read(path).split("\n");
  const blinks = []; const corrupt = [];
  let inBlink = false; let nCorrupt = 0;
  const m = lines[0].trim().match(/corrupt\s*,\s*(\d+)/i);
  if (m) nCorrupt = parseInt(m[1], 10);
  for (let k = 1; k <= nCorrupt; k++) {
    const p = lines[k].trim().split(",");
    if (p.length >= 2) corrupt.push([parseFloat(p[0]), parseFloat(p[1])]);
  }
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    if (/^blinks/i.test(line)) { inBlink = true; continue; }
    if (!inBlink) continue;
    const v = parseFloat(line.split(",")[0]);
    if (Number.isFinite(v)) blinks.push(v);
  }
  return { blinks, corrupt };
}

function median(a) {
  if (!a.length) return NaN;
  const b = a.slice().sort((x, y) => x - y);
  return b[b.length >> 1];
}

const agg = {};
for (const sub of Object.keys(SUBSETS)) {
  const tpS = [], fpS = [];
  let tp = 0, fp = 0, truth = 0;
  for (let k = 0; k < 13; k++) {
    const sid = "S" + String(k).padStart(2, "0") + SUBSETS[sub];
    let csv, lab;
    try { csv = read(ROOT + sub + "/" + sid + "_data.csv"); lab = read(ROOT + sub + "/" + sid + "_labels.csv"); }
    catch (e) { continue; }
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    const det = new BB.BlinkDetector({ fs: parsed.fs, threshold: 3.0, refractoryMs: 400 });
    const hits = [];
    det.on("blink", (e) => hits.push({ t: e.tPeak / 1000, s: e.score }));
    for (let i = 0; i < parsed.ch0.length; i++) det.push(parsed.ch0[i], parsed.ch1[i], (i * 1000) / parsed.fs);

    const tMax = blinks.length ? Math.max.apply(null, blinks) : Infinity;
    const clean = hits.filter(
      (h) => h.t <= tMax + 2 && !corrupt.some(([a, b]) => h.t >= a - 0.2 && h.t <= b + 0.2)
    );
    truth += blinks.length;
    for (const h of clean) {
      const near = blinks.some((t) => Math.abs(h.t - t) <= 0.45);
      if (near) { tp++; tpS.push(h.s); } else { fp++; fpS.push(h.s); }
    }
  }
  agg[sub] = { tp, fp, truth, tpS, fpS };
  print(
    sub + "  真值 " + truth + "  TP " + tp + "  FP " + fp +
    "  |  强度中位 TP " + median(tpS).toFixed(1) + "  FP " + median(fpS).toFixed(1) +
    "  |  FP 强度 ≥ TP 中位的比例 " +
    ((fpS.filter((s) => s >= median(tpS)).length / Math.max(1, fpS.length)) * 100).toFixed(0) + "%"
  );
}
print("");
print("如果 FP 强度与 TP 相当，说明它们是数据里真实但未标注的眨眼，而不是噪声误检。");
