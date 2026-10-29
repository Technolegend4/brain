/* VV 全被试概览：极性、信号强度、两通道相关性 */
"use strict";
load("js/util.js"); load("js/filter.js"); load("js/detector.js"); load("js/synth.js"); load("js/sources.js");
const BB = globalThis.BB;
const ROOT = "../EEG-EyeBlinks 5/";

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

function std(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
  return Math.sqrt(v / a.length);
}

function corr(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db || 1e-12);
}

function p999(a) {
  const s = Float64Array.from(a);
  s.sort();
  return s[Math.floor(s.length * 0.999)];
}

print("被试    样本    通道        标准差(c0/c1)   相关    99.9分位  极性  检出  标签  区内匹配");
for (let k = 0; k < 13; k++) {
  const sid = "S" + String(k).padStart(2, "0") + "V";
  let csv;
  try { csv = read(ROOT + "EEG-VV/" + sid + "_data.csv"); } catch (e) { continue; }
  const blinks = parseLabels(ROOT + "EEG-VV/" + sid + "_labels.csv");
  const parsed = BB.sources.parseEegCsv(csv, sid);
  const fs = parsed.fs;

  const det = new BB.BlinkDetector({ fs, refractoryMs: 400 });
  const hits = [];
  det.on("blink", (e) => hits.push(e.tPeak / 1000));
  for (let i = 0; i < parsed.ch0.length; i++) det.push(parsed.ch0[i], parsed.ch1[i], (i * 1000) / fs);

  const tMax = blinks.length ? Math.max.apply(null, blinks) : 0;
  let matched = 0;
  const used = new Set();
  for (const h of hits) {
    if (h > tMax + 2) continue;
    for (let j = 0; j < blinks.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(h - blinks[j]) <= 0.45) { used.add(j); matched++; break; }
    }
  }

  print(
    sid.padEnd(8) + String(parsed.ch0.length).padEnd(8) +
    (parsed.channels.join("/")).padEnd(12) +
    (std(parsed.ch0).toFixed(0) + "/" + std(parsed.ch1).toFixed(0)).padEnd(15) +
    corr(parsed.ch0, parsed.ch1).toFixed(3).padEnd(8) +
    String(Math.round(p999(parsed.ch0))).padEnd(10) +
    String(det.polarity).padEnd(6) +
    String(hits.length).padEnd(6) +
    String(blinks.length).padEnd(6) +
    matched + " (" + Math.round((matched / Math.max(1, blinks.length)) * 100) + "%)"
  );
}
