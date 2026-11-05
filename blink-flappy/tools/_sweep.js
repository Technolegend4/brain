/* 参数扫描：找出更适合真实数据的阈值与不应期 */
"use strict";
load("js/util.js");
load("js/filter.js");
load("js/detector.js");
load("js/synth.js");
load("js/sources.js");
const BB = globalThis.BB;

function parseLabels(path) {
  const lines = read(path).split("\n");
  const blinks = [];
  const corrupt = [];
  let inBlink = false;
  let nCorrupt = 0;
  let i = 0;
  // 第一行 corrupt, n
  const first = lines[0].trim();
  const m = first.match(/corrupt\s*,\s*(\d+)/i);
  if (m) nCorrupt = parseInt(m[1], 10);
  for (let k = 1; k <= nCorrupt; k++) {
    const parts = lines[k].trim().split(",");
    if (parts.length >= 2) corrupt.push([parseFloat(parts[0]), parseFloat(parts[1])]);
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^blinks/i.test(line)) { inBlink = true; continue; }
    if (!inBlink) continue;
    const v = parseFloat(line.split(",")[0]);
    if (Number.isFinite(v)) blinks.push(v);
  }
  return { blinks, corrupt };
}

function evaluate(truth, detected, tol) {
  const used = new Set();
  let tp = 0;
  const errs = [];
  for (const t of detected) {
    let best = -1, bestErr = Infinity;
    for (let k = 0; k < truth.length; k++) {
      if (used.has(k)) continue;
      const e = Math.abs(t - truth[k]);
      if (e < bestErr) { bestErr = e; best = k; }
    }
    if (best >= 0 && bestErr <= tol) { used.add(best); tp++; errs.push(t - truth[best]); }
  }
  const fp = detected.length - tp;
  const fn = truth.length - tp;
  return { tp, fp, fn, recall: truth.length ? tp / truth.length : 0, precision: detected.length ? tp / detected.length : 0, errs };
}

// ---- 真实数据 ----
const csv = read("../EEG-EyeBlinks 5/EEG-IO/S00_data.csv");
const parsed = BB.sources.parseEegCsv(csv, "S00_data.csv");
const { blinks, corrupt } = parseLabels("../EEG-EyeBlinks 5/EEG-IO/S00_labels.csv");
print("S00: " + parsed.ch0.length + " 点, " + parsed.duration.toFixed(1) + "s, 真值 " + blinks.length + ", corrupt " + JSON.stringify(corrupt));

function run(k, refr, order) {
  const det = new BB.BlinkDetector({ fs: parsed.fs, threshold: k, refractoryMs: refr, order: order || 2 });
  const hits = [];
  const ons = [];
  det.on("onset", (e) => ons.push(e.t));
  det.on("blink", (e) => hits.push(e.tPeak / 1000));
  for (let i = 0; i < parsed.ch0.length; i++) {
    det.push(parsed.ch0[i], parsed.ch1[i], i * 1000 / parsed.fs);
  }
  // 排除 corrupt 区间内的检测
  const filtered = hits.filter((t) => !corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2));
  const r = evaluate(blinks, filtered, 0.4);
  print(
    "k=" + k.toFixed(1) + " refr=" + refr + " order=" + (order || 2) +
    "  检测 " + hits.length + " (剔除corrupt后 " + filtered.length + ")" +
    "  TP " + r.tp + " FP " + r.fp + " FN " + r.fn +
    "  R " + (r.recall * 100).toFixed(1) + "% P " + (r.precision * 100).toFixed(1) + "%"
  );
}

for (const k of [2.4, 2.8, 3.2, 3.6, 4.0, 4.5]) run(k, 400, 2);
for (const k of [3.2, 3.6]) run(k, 400, 4);

// ---- 合成 ----
print("\n合成 120s:");
for (const k of [2.4, 2.8, 3.2, 3.6]) {
  const synth = new BB.BlinkSynth({ fs: 250, meanInterval: 3.0, seed: 7 });
  const det = new BB.BlinkDetector({ fs: 250, threshold: k, refractoryMs: 400 });
  const truth = [];
  synth.onSpawn = (r) => truth.push(r.t0);
  const detT = [];
  det.on("blink", (e) => detT.push(e.tPeak / 1000));
  for (let i = 0; i < 120 * 250; i++) {
    const s = synth.step();
    det.push(s.x0, s.x1, i * 1000 / 250);
  }
  const r = evaluate(truth, detT, 0.45);
  print("k=" + k.toFixed(1) + "  TP " + r.tp + " FP " + r.fp + " FN " + r.fn +
    "  R " + (r.recall * 100).toFixed(1) + "% P " + (r.precision * 100).toFixed(1) + "%");
}
