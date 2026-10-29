/* 诊断：onset 与 blink 两类事件的检出率/误报率对比
   游戏用 onset 触发（延迟最低），但 onset 不做回落确认，误报会直接变成"乱跳"。 */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;
const ROOT = "../EEG-EyeBlinks 5/";
const SUBSETS = {
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
  let tp = 0; const errors = [];
  for (const t of detected) {
    let best = -1, bestErr = Infinity;
    for (let k = 0; k < truth.length; k++) {
      if (used.has(k)) continue;
      const e = t - truth[k];
      if (e < -earlyTol || e > lateTol) continue;
      if (Math.abs(e) < bestErr) { bestErr = Math.abs(e); best = k; }
    }
    if (best >= 0) { used.add(best); tp++; errors.push(t - truth[best]); }
  }
  return { tp, fp: detected.length - tp, fn: truth.length - tp, errors };
}

function median(a) {
  if (!a.length) return NaN;
  const b = a.slice().sort((x, y) => x - y);
  return b[b.length >> 1];
}

const CONFIRMS = [1.0, 1.1, 1.2, 1.35];
const rows = [];

for (const CF of CONFIRMS) {
for (const sub of Object.keys(SUBSETS)) {
  let oTp = 0, oDet = 0, bTp = 0, bDet = 0, truth = 0;
  const oErr = [];
  for (const sid of SUBSETS[sub]) {
    let csv;
    try {
      csv = read(ROOT + sub + "/" + sid + "_data.csv");
      read(ROOT + sub + "/" + sid + "_labels.csv");
    } catch (e) { continue; }
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    const tMax = blinks.length ? Math.max.apply(null, blinks) : Infinity;

    const det = new BB.BlinkDetector({ fs: parsed.fs, refractoryMs: 400, onsetConfirm: 3, onsetBoost: CF });
    const ons = []; const blks = [];
    det.on("onset", (e) => ons.push(e.t / 1000));
    det.on("blink", (e) => blks.push(e.tPeak / 1000));
    for (let i = 0; i < parsed.ch0.length; i++) {
      det.push(parsed.ch0[i], parsed.ch1[i], (i * 1000) / parsed.fs);
    }

    const cleanOn = ons.filter((t) => t <= tMax + 2 && !corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2));
    const cleanBl = blks.filter((t) => t <= tMax + 2 && !corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2));

    const rOn = evaluate(blinks, cleanOn, 0.45, 0.3);
    const rBl = evaluate(blinks, cleanBl, 0.45, 0.3);
    oTp += rOn.tp; oDet += cleanOn.length;
    bTp += rBl.tp; bDet += cleanBl.length;
    truth += blinks.length;
    for (const e of rOn.errors) oErr.push(e * 1000);
  }
  const mk = (tp, det) => {
    const R = truth ? tp / truth : 0;
    const P = det ? tp / det : 0;
    return { R, P, F1: R + P ? (2 * R * P) / (R + P) : 0 };
  };
  rows.push({ sub, truth, on: mk(oTp, oDet), bl: mk(bTp, bDet), oErr, CF });
}
}

print("门槛    子集     onset R/P/F1        onset 误差中位/P90");
for (const r of rows) {
  const f = (x) => (x * 100).toFixed(0);
  const err = r.oErr.slice().sort((a, b) => a - b);
  const p90 = err.length ? err[Math.floor(err.length * 0.9)] : NaN;
  print(
    ("boost " + r.CF.toFixed(2)).padEnd(11) +
    r.sub.padEnd(8) +
    (f(r.on.R) + "/" + f(r.on.P) + "/" + f(r.on.F1)).padEnd(20) +
    median(r.oErr).toFixed(0) + " / " + p90.toFixed(0) + " ms"
  );
}
