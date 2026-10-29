"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;

function parseLabels(path) {
  const lines = read(path).split("\n");
  const blinks = []; let inBlink = false;
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    if (/^blinks/i.test(line)) { inBlink = true; continue; }
    if (!inBlink) continue;
    const v = parseFloat(line.split(",")[0]);
    if (Number.isFinite(v)) blinks.push(v);
  }
  return blinks;
}

for (const sid of ["S00", "S05", "S13"]) {
  const csv = read("../EEG-EyeBlinks 5/EEG-IO/" + sid + "_data.csv");
  const parsed = BB.sources.parseEegCsv(csv, sid);
  const truth = parseLabels("../EEG-EyeBlinks 5/EEG-IO/" + sid + "_labels.csv");
  const det = new BB.BlinkDetector({ fs: parsed.fs, threshold: 3.0, refractoryMs: 400 });
  const hits = [];
  det.on("blink", (e) => hits.push({ t: e.tPeak / 1000, s: e.score, dur: e.durMs, pol: e.polarity }));
  for (let i = 0; i < parsed.ch0.length; i++) det.push(parsed.ch0[i], parsed.ch1[i], i * 1000 / parsed.fs);

  print("\n=== " + sid + " 真值 " + truth.length + " 检测 " + hits.length + " 极性 " + det.polarity + " σ=" + det.stat[0].sigma.toFixed(1));
  print("truth: " + truth.map((v) => v.toFixed(2)).join(" "));
  print("det  : " + hits.map((h) => h.t.toFixed(2) + "(" + h.s.toFixed(0) + ")").join(" "));
  // 每个真值最近的检测误差
  const errs = truth.map((v) => {
    let best = null, be = Infinity;
    for (const h of hits) { const e = Math.abs(h.t - v); if (e < be) { be = e; best = h; } }
    return { v, t: best ? best.t : null, e: be, s: best ? best.s : null };
  });
  print("误差: " + errs.map((x) => (x.t === null ? "MISS" : (x.e * 1000).toFixed(0) + "ms/" + x.s.toFixed(0))).join("  "));
}
