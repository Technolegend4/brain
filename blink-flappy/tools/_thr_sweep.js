/* 阈值扫描：找 recall/precision 的平衡点（分数据集） */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;
const ROOT = "../EEG-EyeBlinks 5/";
const SUBSETS = ["EEG-IO", "EEG-VR", "EEG-VV"];
const SUBJECTS = {
  "EEG-IO": Array.from({ length: 20 }, (_, i) => "S" + String(i).padStart(2, "0")),
  "EEG-VR": Array.from({ length: 13 }, (_, i) => "S" + String(i).padStart(2, "0") + "R"),
  "EEG-VV": Array.from({ length: 13 }, (_, i) => "S" + String(i).padStart(2, "0") + "V"),
};
const THRESHOLDS = [3.0, 3.2, 3.4, 3.6, 3.8];

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

function evaluate(truth, detected, earlyTol, lateTol) {
  const used = new Set();
  let tp = 0;
  for (const t of detected) {
    let best = -1, bestErr = Infinity;
    for (let k = 0; k < truth.length; k++) {
      if (used.has(k)) continue;
      const e = t - truth[k];
      if (e < -earlyTol || e > lateTol) continue;
      if (Math.abs(e) < bestErr) { bestErr = Math.abs(e); best = k; }
    }
    if (best >= 0) { used.add(best); tp++; }
  }
  return { tp, fp: detected.length - tp, fn: truth.length - tp };
}

// 先把数据全部读进来，避免重复 IO
const DATA = {};
for (const sub of SUBSETS) {
  DATA[sub] = [];
  for (const sid of SUBJECTS[sub]) {
    let csv, lab;
    try {
      csv = read(ROOT + sub + "/" + sid + "_data.csv");
      lab = read(ROOT + sub + "/" + sid + "_labels.csv");
    } catch (e) { continue; }
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    DATA[sub].push({ sid, parsed, blinks, corrupt });
  }
}

print("阈值   " + SUBSETS.map((s) => s.padEnd(22)).join("") + "总计");
for (const th of THRESHOLDS) {
  const cells = [];
  let gtp = 0, gdet = 0, gtruth = 0;
  for (const sub of SUBSETS) {
    let tp = 0, det = 0, truth = 0;
    for (const d of DATA[sub]) {
      const det_ = new BB.BlinkDetector({ fs: d.parsed.fs, threshold: th, refractoryMs: 400 });
      const hits = [];
      det_.on("blink", (e) => hits.push(e.tPeak / 1000));
      for (let i = 0; i < d.parsed.ch0.length; i++) {
        det_.push(d.parsed.ch0[i], d.parsed.ch1[i], (i * 1000) / d.parsed.fs);
      }
      const tMax = d.blinks.length ? Math.max.apply(null, d.blinks) : Infinity;
      const clean = hits.filter(
        (t) => t <= tMax + 2 && !d.corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2)
      );
      const r = evaluate(d.blinks, clean, 0.45, 0.3);
      tp += r.tp; det += clean.length; truth += d.blinks.length;
    }
    const R = truth ? tp / truth : 0;
    const P = det ? tp / det : 0;
    const F1 = R + P ? (2 * R * P) / (R + P) : 0;
    cells.push((R * 100).toFixed(0) + "/" + (P * 100).toFixed(0) + " F1 " + (F1 * 100).toFixed(0));
    gtp += tp; gdet += det; gtruth += truth;
  }
  const R = gtruth ? gtp / gtruth : 0;
  const P = gdet ? gtp / gdet : 0;
  const F1 = R + P ? (2 * R * P) / (R + P) : 0;
  print(
    th.toFixed(1).padEnd(7) +
    cells.map((c) => c.padEnd(22)).join("") +
    "F1 " + (F1 * 100).toFixed(1)
  );
}
