/* 全量评估：EEG-EyeBlinks 三个子集，非对称匹配窗口 */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;

const SUBSETS = ["EEG-IO", "EEG-VR", "EEG-VV"];
const ROOT = "../EEG-EyeBlinks 5/";

function listDir(path) {
  // jsc 没有 readdir，用固定名单
  return null;
}

// 被试名单
const SUBJECTS = {
  "EEG-IO": Array.from({ length: 20 }, (_, i) => "S" + String(i).padStart(2, "0")),
  "EEG-VR": Array.from({ length: 13 }, (_, i) => "S" + String(i).padStart(2, "0") + "R"),
  "EEG-VV": Array.from({ length: 13 }, (_, i) => "S" + String(i).padStart(2, "0") + "V"),
};

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
  let tp = 0; const errs = [];
  for (const t of detected) {
    let best = -1, bestErr = Infinity;
    for (let k = 0; k < truth.length; k++) {
      if (used.has(k)) continue;
      const e = t - truth[k];
      if (e < -earlyTol || e > lateTol) continue;
      if (Math.abs(e) < bestErr) { bestErr = Math.abs(e); best = k; }
    }
    if (best >= 0) { used.add(best); tp++; errs.push(t - truth[best]); }
  }
  return {
    tp, fp: detected.length - tp, fn: truth.length - tp,
    recall: truth.length ? tp / truth.length : 0,
    precision: detected.length ? tp / detected.length : 0,
    errs,
  };
}

const totals = { tp: 0, fp: 0, fn: 0, n: 0, truth: 0, det: 0 };
const perSubset = {};

for (const sub of SUBSETS) {
  const acc = { tp: 0, fp: 0, fn: 0, truth: 0, det: 0, n: 0, errs: [] };
  for (const sid of SUBJECTS[sub]) {
    let csv, lab;
    try {
      csv = read(ROOT + sub + "/" + sid + "_data.csv");
      lab = read(ROOT + sub + "/" + sid + "_labels.csv");
    } catch (e) { continue; }
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    const det = new BB.BlinkDetector({ fs: parsed.fs });
    const hits = [];
    det.on("blink", (e) => hits.push(e.tPeak / 1000));
    for (let i = 0; i < parsed.ch0.length; i++) det.push(parsed.ch0[i], parsed.ch1[i], i * 1000 / parsed.fs);
    // 标签只覆盖每个文件的前 ~200 s，数据却有 300~430 s。
    // 标签范围之外的检测无法判定对错，必须排除，否则会被算成误检。
    const tMax = blinks.length ? Math.max.apply(null, blinks) : Infinity;
    const clean = hits.filter(
      (t) => t <= tMax + 2 && !corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2)
    );
    const r = evaluate(blinks, clean, 0.45, 0.30);
    acc.tp += r.tp; acc.fp += r.fp; acc.fn += r.fn;
    acc.truth += blinks.length; acc.det += clean.length; acc.n++;
    acc.errs.push(...r.errs);
    print(
      "  " + sub + "/" + sid + "  真值 " + blinks.length + " 检测 " + clean.length +
      "  R " + (r.recall * 100).toFixed(0) + "%  P " + (r.precision * 100).toFixed(0) + "%"
    );
  }
  acc.errs.sort((a, b) => a - b);
  const R = acc.truth ? acc.tp / acc.truth : 0;
  const P = acc.det ? acc.tp / acc.det : 0;
  const F1 = R + P ? (2 * R * P) / (R + P) : 0;
  const med = acc.errs.length ? acc.errs[acc.errs.length >> 1] * 1000 : NaN;
  print(
    "=> " + sub + " 合计 真值 " + acc.truth + " 检测 " + acc.det +
    "  R " + (R * 100).toFixed(1) + "%  P " + (P * 100).toFixed(1) + "%  F1 " + (F1 * 100).toFixed(1) +
    "%  误差中位 " + (med || 0).toFixed(0) + " ms（负=检测更早）\n"
  );
  perSubset[sub] = { R, P, F1, med, truth: acc.truth, det: acc.det };
  totals.tp += acc.tp; totals.fp += acc.fp; totals.fn += acc.fn;
  totals.truth += acc.truth; totals.det += acc.det; totals.n += acc.n;
}

const R = totals.truth ? totals.tp / totals.truth : 0;
const P = totals.det ? totals.tp / totals.det : 0;
print("=".repeat(60));
print(
  "总计 " + totals.n + " 名被试，真值 " + totals.truth + " 次，检测 " + totals.det +
  "  R " + (R * 100).toFixed(1) + "%  P " + (P * 100).toFixed(1) +
  "%  F1 " + (((2 * R * P) / (R + P)) * 100).toFixed(1) + "%"
);
print("=".repeat(60));
