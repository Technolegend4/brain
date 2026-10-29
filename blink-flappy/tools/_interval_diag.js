/* 诊断 1：眨眼间隔分布（不应期会不会吞掉连眨）
   诊断 2：扫不应期长度，看召回/精确如何变 */
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

function pct(a, b) { return b ? ((a / b) * 100).toFixed(0) + "%" : "—"; }
function median(arr) { const b = arr.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; }

/* ---------- 1. 间隔分布 ---------- */
print("子集      眨眼数  <0.25s   0.25~0.4s   ≥0.4s   中位间隔");
for (const sub of Object.keys(SUBSETS)) {
  const gaps = [];
  for (const sid of SUBSETS[sub]) {
    let lab;
    try { lab = read(ROOT + sub + "/" + sid + "_labels.csv"); } catch (e) { continue; }
    const { blinks } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    for (let i = 1; i < blinks.length; i++) gaps.push(blinks[i] - blinks[i - 1]);
  }
  const a = gaps.filter((g) => g < 0.25).length;
  const b = gaps.filter((g) => g >= 0.25 && g < 0.4).length;
  const c = gaps.filter((g) => g >= 0.4).length;
  print(
    sub.padEnd(10) + String(gaps.length + 1).padEnd(8) +
    pct(a, gaps.length).padEnd(9) + pct(b, gaps.length).padEnd(11) + pct(c, gaps.length).padEnd(8) +
    median(gaps).toFixed(2) + " s"
  );
}

/* ---------- 2. 扫不应期 ---------- */
const DATA = {};
for (const sub of Object.keys(SUBSETS)) {
  DATA[sub] = [];
  for (const sid of SUBSETS[sub]) {
    let csv;
    try { csv = read(ROOT + sub + "/" + sid + "_data.csv"); read(ROOT + sub + "/" + sid + "_labels.csv"); }
    catch (e) { continue; }
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    DATA[sub].push({ parsed, blinks, corrupt });
  }
}

print("");
print("不应期    EEG-IO R/P/F1        EEG-VR R/P/F1        EEG-VV R/P/F1        总计F1");
for (const refr of [250, 300, 350, 400]) {
  const cells = [];
  let gtp = 0, gdet = 0, gtruth = 0;
  for (const sub of Object.keys(SUBSETS)) {
    let tp = 0, det = 0, truth = 0;
    for (const d of DATA[sub]) {
      const detector = new BB.BlinkDetector({ fs: d.parsed.fs, refractoryMs: refr });
      const hits = [];
      detector.on("blink", (e) => hits.push(e.tPeak / 1000));
      for (let i = 0; i < d.parsed.ch0.length; i++) {
        detector.push(d.parsed.ch0[i], d.parsed.ch1[i], (i * 1000) / d.parsed.fs);
      }
      const tMax = d.blinks.length ? Math.max.apply(null, d.blinks) : Infinity;
      const clean = hits.filter(
        (t) => t <= tMax + 2 && !d.corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2)
      );
      const r = evaluate(d.blinks, clean, 0.45, 0.3);
      tp += r.tp; det += clean.length; truth += d.blinks.length;
    }
    const R = truth ? tp / truth : 0, P = det ? tp / det : 0;
    cells.push(((R * 100).toFixed(0) + "/" + (P * 100).toFixed(0) + "/" + (((2 * R * P) / (R + P)) * 100).toFixed(0)));
    gtp += tp; gdet += det; gtruth += truth;
  }
  const R = gtp / gtruth, P = gtp / gdet;
  print(
    (refr + " ms").padEnd(9) + cells.map((c) => c.padEnd(20)).join("") +
    ((2 * R * P) / (R + P) * 100).toFixed(1)
  );
}
