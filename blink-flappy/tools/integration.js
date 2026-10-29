/* ============================================================
   integration.js — 分层集成自检（无浏览器）
   ------------------------------------------------------------
   运行（macOS 自带 jsc）：
     cd blink-flappy
     /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/integration.js

   为什么单独有这个文件
     tools/selftest.js 是把整段信号一次性喂给检测器，验证的是算法；
     但真实的页面是每 10 ms 一批（约 2~3 个样本）喂数。
     如果时间戳按"批内序号"从 0 重新计时，检测器的 warmup 永远不结束，
     结果是一次眨眼都检测不到 —— 这类 bug 只有分层喂数才暴露。
     本文件就是锁住这一层的。
   ============================================================ */
"use strict";

load("js/util.js");
load("js/filter.js");
load("js/detector.js");
load("js/synth.js");
load("js/sources.js");

const BB = globalThis.BB;
const FS = 250;
const BATCH = 25; // 10 ms @ 250 Hz，与 SimSource 的批量一致

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) {
    pass++;
    print("  ✓ " + name + (detail ? "  " + detail : ""));
  } else {
    fail++;
    print("  ✗ " + name + (detail ? "  " + detail : ""));
  }
}

print("\n[1] 生成 120 s 合成信号");
const synth = new BB.BlinkSynth({ fs: FS, meanInterval: 3.2, seed: 20261029 });
const total = FS * 120;
const x0 = new Float64Array(total);
const x1 = new Float64Array(total);
for (let i = 0; i < total; i++) {
  const s = synth.step();
  x0[i] = s.x0;
  x1[i] = s.x1;
}
ok(true, "样本数 " + total);

/* ------------------------------------------------------------
   模拟 main.js 的 onRaw：按批推入，时间戳必须全局单调
   ------------------------------------------------------------ */
function run(mode) {
  const det = new BB.BlinkDetector({ fs: FS, threshold: 2.8, refractoryMs: 400 });
  const seen = [];
  det.on("blink", (e) => seen.push(e.tPeak));

  let samples = 0;
  for (let pos = 0; pos + BATCH <= total; pos += BATCH) {
    const baseMs = (samples * 1000) / FS;
    for (let i = 0; i < BATCH; i++) {
      const tMs = mode === "batch" ? (i * 1000) / FS : baseMs + (i * 1000) / FS;
      det.push(x0[pos + i], x1[pos + i], tMs);
    }
    samples += BATCH;
  }
  return { detected: seen.length, warmed: det.warmedUp, seen };
}

print("\n[2] 批内时间戳（错误做法：每批从 0 计时）");
const bad = run("batch");
ok(bad.warmed === false, "warmup 未结束（说明时间轴没有前进）");
ok(bad.detected === 0, "检测到 0 次眨眼（复现集成 bug）", "det=" + bad.detected);

print("\n[3] 全局单调时间戳（main.js 的现行实现）");
const good = run("global");
ok(good.warmed === true, "warmup 正常结束");
ok(good.detected >= 20, "检测到足够多的眨眼", "det=" + good.detected);

print("\n[4] 事件时间必须单调递增");
const days = good.seen.every((v, i) => i === 0 || v >= good.seen[i - 1]);
ok(days, "事件时间单调");

print("\n[5] 时间戳连续性（相邻样本间隔 4 ms）");
{
  const det = new BB.BlinkDetector({ fs: FS, threshold: 2.8 });
  let samples = 0;
  let maxGap = 0;
  let prev = null;
  for (let pos = 0; pos + BATCH <= 2500; pos += BATCH) {
    const baseMs = (samples * 1000) / FS;
    for (let i = 0; i < BATCH; i++) {
      const tMs = baseMs + (i * 1000) / FS;
      if (prev !== null) maxGap = Math.max(maxGap, tMs - prev);
      prev = tMs;
      det.push(x0[pos + i], x1[pos + i], tMs);
    }
    samples += BATCH;
  }
  ok(Math.abs(maxGap - 4) < 1e-6, "最大相邻间隔 4 ms", maxGap.toFixed(3) + " ms");
}

print("\n====================================================");
print("  通过 " + pass + " / " + (pass + fail) + (fail === 0 ? "  ✓ 全部通过" : "  ✗ 有失败项"));
print("====================================================");
if (fail > 0) throw new Error("集成自检未通过");
