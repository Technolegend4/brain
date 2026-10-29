/* 参数网格：在 12 名被试上扫描阈值/最长持续时间/回滞 */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;
const ROOT = "../EEG-EyeBlinks 5/";

const SETS = [
  ["EEG-IO", ["S00", "S03", "S07", "S12", "S15", "S18"]],
  ["EEG-VR", ["S00R", "S03R", "S07R", "S10R"]],
  ["EEG-VV", ["S00V", "S03V", "S07V", "S10V"]],
];

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

function evaluate(truth, detected) {
  const used = new Set(); let tp = 0;
  for (const t of detected) {
    let best = -1, be = Infinity;
    for (let k = 0; k < truth.length; k++) {
      if (used.has(k)) continue;
      const e = t - truth[k];
      if (e < -0.45 || e > 0.3) continue;
      if (Math.abs(e) < be) { be = Math.abs(e); best = k; }
    }
    if (best >= 0) { used.add(best); tp++; }
  }
  return { tp, fp: detected.length - tp, fn: truth.length - tp };
}

// 预载数据
const cache = [];
for (const [sub, ids] of SETS) {
  for (const sid of ids) {
    const csv = read(ROOT + sub + "/" + sid + "_data.csv");
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    cache.push({ sub, sid, parsed, blinks, corrupt });
  }
}
print("已载入 " + cache.length + " 名被试\n");

function run(label, opts) {
  let tp = 0, fp = 0, fn = 0, det = 0, truth = 0;
  for (const c of cache) {
    const det0 = new BB.BlinkDetector(Object.assign({ fs: c.parsed.fs }, opts));
    const hits = [];
    det0.on("blink", (e) => hits.push(e.tPeak / 1000));
    for (let i = 0; i < c.parsed.ch0.length; i++) det0.push(c.parsed.ch0[i], c.parsed.ch1[i], i * 1000 / c.parsed.fs);
    const clean = hits.filter((t) => !c.corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2));
    const r = evaluate(c.blinks, clean);
    tp += r.tp; fp += r.fp; fn += r.fn; det += clean.length; truth += c.blinks.length;
  }
  const R = tp / truth, P = tp / det, F1 = (2 * R * P) / (R + P);
  print(
    label +
    "  R " + (R * 100).toFixed(1) + "%  P " + (P * 100).toFixed(1) +
    "%  F1 " + (F1 * 100).toFixed(1) + "%  (tp " + tp + " fp " + fp + " fn " + fn + ")"
  );
}

run("k=3.0 maxDur700 hy0.45 ", { threshold: 3.0, refractoryMs: 400, maxDurMs: 700, hysteresis: 0.45 });
run("k=4.0 maxDur700 hy0.45 ", { threshold: 4.0, refractoryMs: 400, maxDurMs: 700, hysteresis: 0.45 });
run("k=5.0 maxDur700 hy0.45 ", { threshold: 5.0, refractoryMs: 400, maxDurMs: 700, hysteresis: 0.45 });
run("k=4.0 maxDur400 hy0.45 ", { threshold: 4.0, refractoryMs: 400, maxDurMs: 400, hysteresis: 0.45 });
run("k=3.5 maxDur450 hy0.30 ", { threshold: 3.5, refractoryMs: 450, maxDurMs: 450, hysteresis: 0.30 });
run("k=4.0 maxDur450 hy0.25 ", { threshold: 4.0, refractoryMs: 450, maxDurMs: 450, hysteresis: 0.25 });
run("k=4.5 maxDur450 hy0.25 ", { threshold: 4.5, refractoryMs: 450, maxDurMs: 450, hysteresis: 0.25 });
run("k=5.0 maxDur400 hy0.25 ", { threshold: 5.0, refractoryMs: 450, maxDurMs: 400, hysteresis: 0.25 });
run("k=6.0 maxDur400 hy0.25 ", { threshold: 6.0, refractoryMs: 450, maxDurMs: 400, hysteresis: 0.25 });
