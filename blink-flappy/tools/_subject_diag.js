/* 单被试诊断：S10V 的检测-标签时间偏移直方图 */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;
const ROOT = "../EEG-EyeBlinks 5/";
const TARGET = (typeof arguments !== "undefined" && arguments[0]) ? arguments[0] : "EEG-VV/S10V";

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

const csv = read(ROOT + TARGET + "_data.csv");
const parsed = BB.sources.parseEegCsv(csv, TARGET);
const { blinks } = parseLabels(ROOT + TARGET + "_labels.csv");

print("文件 " + TARGET);
print("  识别采样率 fs = " + parsed.fs + " Hz，时长 " + parsed.duration.toFixed(1) + " s，样本 " + parsed.ch0.length);
print("  通道 " + parsed.channels.join(" / "));
print("  标签 " + blinks.length + " 个，首个 " + blinks[0] + " s，末个 " + blinks[blinks.length - 1] + " s");

const det = new BB.BlinkDetector({ fs: parsed.fs, refractoryMs: 400 });
const hits = [];
det.on("blink", (e) => hits.push(e.tPeak / 1000));
for (let i = 0; i < parsed.ch0.length; i++) det.push(parsed.ch0[i], parsed.ch1[i], (i * 1000) / parsed.fs);
print("  检出 " + hits.length + " 个，极性 " + det.polarity + "，翻转过 " + (det.polarityFlippedAt > 0 ? "是" : "否"));

// 每个检测事件找最近的标签，统计偏移
const bins = new Map();
let matched = 0;
for (const h of hits) {
  let best = null, bestE = Infinity;
  for (const t of blinks) {
    const e = h - t;
    if (Math.abs(e) < Math.abs(bestE)) { bestE = e; best = t; }
  }
  if (Math.abs(bestE) <= 2.0) { matched++; }
  {
    const b = Math.round(bestE * 10) / 10;
    bins.set(b, (bins.get(b) || 0) + 1);
  }
}
print("  |偏移| ≤ 2 s 的检测：" + matched + " / " + hits.length);

const keys = Array.from(bins.keys()).sort((a, b) => a - b);
print("  偏移直方图（0.1 s 分箱，仅显示计数 ≥ 2 的箱）：");
for (const k of keys) {
  const c = bins.get(k);
  if (c < 2) continue;
  print("    " + (k >= 0 ? "+" : "") + k.toFixed(1) + " s  " + "#".repeat(Math.min(c, 40)) + " " + c);
}

// 偏度检验：如果整体偏移，最佳单值偏移应该很集中
let bestShift = 0, bestCount = 0;
for (const k of keys) {
  let c = 0;
  for (const h of hits) {
    for (const t of blinks) {
      if (Math.abs(h - t - k) <= 0.25) { c++; break; }
    }
  }
  if (c > bestCount) { bestCount = c; bestShift = k; }
}
print("  最佳整体偏移：" + bestShift.toFixed(1) + " s，命中 " + bestCount + " / " + hits.length);
