/* 诊断：漏检（FN）的眨眼到底有多"弱" —— 是真没信号，还是被阈值卡住 */
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

function median(arr) { const b = arr.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; }
function quant(arr, q) { const b = arr.slice().sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) * q)] : NaN; }

const buckets = {};
for (const sub of Object.keys(SUBSETS)) {
  const tpPeak = [], fnPeak = [];
  let perSubject = [];
  for (const sid of SUBSETS[sub]) {
    let csv;
    try { csv = read(ROOT + sub + "/" + sid + "_data.csv"); read(ROOT + sub + "/" + sid + "_labels.csv"); }
    catch (e) { continue; }
    const parsed = BB.sources.parseEegCsv(csv, sid);
    const { blinks, corrupt } = parseLabels(ROOT + sub + "/" + sid + "_labels.csv");
    const fs = parsed.fs;

    const det = new BB.BlinkDetector({ fs, refractoryMs: 400 });
    // 记录每个样本的合成分数，便于回看真值附近的峰值
    const scoreAt = new Float32Array(parsed.ch0.length);
    for (let i = 0; i < parsed.ch0.length; i++) {
      const s = det.push(parsed.ch0[i], parsed.ch1[i], (i * 1000) / fs);
      scoreAt[i] = typeof s === "number" ? s : 0;
    }
    // 用峰值时刻判定命中：真值附近 ±0.45 s 内有检测事件
    const hits = det.eventTimes.map((t) => t / 1000);
    const used = new Set();
    let miss = 0;
    for (const t of blinks) {
      if (corrupt.some(([a, b]) => t >= a - 0.2 && t <= b + 0.2)) continue;
      const idx = Math.round(t * fs);
      let peak = 0;
      for (let k = Math.max(0, idx - Math.round(0.45 * fs)); k < Math.min(scoreAt.length, idx + Math.round(0.45 * fs)); k++) {
        if (Math.abs(scoreAt[k]) > Math.abs(peak)) peak = scoreAt[k];
      }
      let best = -1, bestE = Infinity;
      for (let j = 0; j < hits.length; j++) {
        if (used.has(j)) continue;
        const e = Math.abs(hits[j] - t);
        if (e < 0.45 && e < bestE) { bestE = e; best = j; }
      }
      if (best >= 0) { used.add(best); tpPeak.push(Math.abs(peak)); }
      else { fnPeak.push(Math.abs(peak)); miss++; }
    }
    perSubject.push({ sid, miss, total: blinks.length });
  }
  buckets[sub] = { tpPeak, fnPeak, perSubject };
}

print("子集     TP峰值中位  FN峰值中位  FN P25/P75   FN中<2.0  FN中2~3.4  FN中>3.4");
for (const sub of Object.keys(buckets)) {
  const { tpPeak, fnPeak } = buckets[sub];
  const low = fnPeak.filter((v) => v < 2.0).length;
  const mid = fnPeak.filter((v) => v >= 2.0 && v < 3.4).length;
  const high = fnPeak.filter((v) => v >= 3.4).length;
  print(
    sub.padEnd(8) +
    median(tpPeak).toFixed(1).padEnd(12) +
    median(fnPeak).toFixed(1).padEnd(12) +
    (quant(fnPeak, 0.25).toFixed(1) + " / " + quant(fnPeak, 0.75).toFixed(1)).padEnd(12) +
    String(low).padEnd(10) + String(mid).padEnd(11) + String(high)
  );
}

print("");
print("漏检最多的被试：");
for (const sub of Object.keys(buckets)) {
  const list = buckets[sub].perSubject.slice().sort((a, b) => b.miss - a.miss).slice(0, 3);
  print("  " + sub + "  " + list.map((x) => x.sid + " 漏" + x.miss + "/" + x.total).join("  "));
}
