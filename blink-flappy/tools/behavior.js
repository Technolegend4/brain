/* ============================================================
   behavior.js — 运行时行为自检（无浏览器）
   ------------------------------------------------------------
   运行（macOS 自带 jsc）：
     cd blink-flappy
     /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tools/behavior.js

   覆盖三件 selftest 测不到的事：
     1) CsvSource 暂停后继续，是否接着播而不是回到开头
     2) Game 的物理闭环：起跳、触地、gameover、重开
     3) 难度自适应改的是模块级 PHYS，重开后有没有复原
   以及 gate/hold/direct 三种映射模式与边界输入。
   ============================================================ */
"use strict";

// jsc 没有定时器：不真正触发，测试里手动调用 _tick
if (typeof setInterval === "undefined") {
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  // setTimeout 立即执行回调：第 8 节要 await 分片解析，
  // 若像 setInterval 一样什么都不做，Promise 永远不会 resolve
  globalThis.setTimeout = (fn) => {
    if (typeof fn === "function") fn();
    return 1;
  };
  globalThis.clearTimeout = () => {};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
}
if (typeof performance === "undefined") {
  globalThis.performance = { now: () => Date.now() };
}
globalThis.localStorage = {
  _d: {},
  getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
};
globalThis.devicePixelRatio = 2;
globalThis.AudioContext = undefined;
globalThis.webkitAudioContext = undefined;

// 万能 canvas：吞掉所有 2D 调用
function makeCanvas() {
  const proxy = new Proxy(function () {}, {
    get(t, k) {
      if (k === "canvas") return canvas;
      if (k === "width" || k === "height") return 0;
      return proxy;
    },
    apply() { return proxy; },
    set() { return true; },
  });
  const canvas = { width: 0, height: 0, clientWidth: 480, getContext: () => proxy };
  return canvas;
}

load("js/util.js");
load("js/filter.js");
load("js/detector.js");
load("js/synth.js");
load("js/sources.js");
load("js/game.js");

const BB = globalThis.BB;
let issues = 0;
function report(name, ok, detail) {
  print((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "   " + detail : ""));
  if (!ok) issues++;
}

/* ================= 1. CsvSource 暂停/继续 ================= */
print("\n[1] CsvSource：暂停后继续，播放位置是否保留");
{
  const n = 5000;
  const ch0 = new Float64Array(n);
  const ch1 = new Float64Array(n);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i / 250;
    ch0[i] = Math.sin(i / 5);
    ch1[i] = Math.sin(i / 5);
  }
  const parsed = { ch0, ch1, t, fs: 250, duration: t[n - 1], format: "test", channels: ["A", "B"] };
  const src = new BB.sources.CsvSource(parsed, { speed: 1, loop: true });

  src.start();
  src.pos = 2000;
  src.pause();
  src.resume();
  report("继续后 pos 保持 2000", src.pos === 2000, "实际 pos=" + src.pos);

  // 播到结尾后再启动应从头
  src.stop();
  src.pos = n;
  src.start();
  report("播完后重启回到开头", src.pos === 0, "实际 pos=" + src.pos);
  src.stop();
}

/* ================= 2. Game 纯逻辑闭环 ================= */
print("\n[2] Game：起跳 → 落地 → gameover → 重开");
{
  const g = new BB.Game(makeCanvas());
  const events = [];
  for (const ev of ["start", "score", "hit", "gameover", "blinkApplied"]) {
    g.on(ev, (p) => events.push({ ev, p }));
  }

  g.start();
  report("start 后 running", g.state === "running");
  report("start 后 time=0", g.time === 0);

  let guard = 0;
  while (g.time < 1.2 && guard++ < 2000) {
    g._tick(1 / 120);
    if (g.state !== "running") break;
  }
  report("1.2 s 内未坠地（自动振翅有效）", g.state === "running",
    "state=" + g.state + " y=" + g.bird.y.toFixed(1));

  const before = g.bird.vy;
  g.onBlink(g.time - 0.09, 4.0, { lagSamples: 22 });
  report("眨眼产生向上速度", g.bird.vy < before, "vy=" + g.bird.vy.toFixed(1));
  report("眨眼计入 blinksApplied", g.blinksApplied >= 1, "n=" + g.blinksApplied);

  g.bird.y = 640;
  guard = 0;
  while (g.state === "running" && guard++ < 100) g._tick(1 / 120);
  report("触地进入 dying/over", g.state !== "running", "state=" + g.state);

  guard = 0;
  while (g.state !== "over" && guard++ < 400) g._tick(1 / 120);
  report("死亡动画结束进入 over", g.state === "over");
  report("触发 gameover", events.some((e) => e.ev === "gameover"));
  report("gameover 带分数/最高", events.filter((e) => e.ev === "gameover").every((e) => typeof e.p.score === "number"));

  g.start();
  report("重开后分数/时间归零", g.score === 0 && g.time === 0);
  report("重开后管道清空", g.pipes.length === 0);
  g.destroy();
}

/* ================= 3. 难度参数跨局残留 ================= */
print("\n[3] 难度自适应：重开后是否复原");
{
  const P = BB.GAME_CONST.PHYS;
  const D = BB.GAME_CONST.PHYS_DEFAULT;
  const g = new BB.Game(makeCanvas());
  g.start();
  g.setDifficultyFromRate(60); // 拉满：紧间隙 + 快管道
  const tightGap = P.gap;
  const tightSpeed = P.pipeSpeed;
  report("高眨眼率确实收紧了难度", tightGap < D.gap && tightSpeed > D.pipeSpeed,
    "gap=" + tightGap.toFixed(1) + " speed=" + tightSpeed.toFixed(1));

  g.start(); // 重开
  report("重开后 gap 复原", Math.abs(P.gap - D.gap) < 1e-9, "gap=" + P.gap.toFixed(1));
  report("重开后 pipeSpeed 复原", Math.abs(P.pipeSpeed - D.pipeSpeed) < 1e-9, "speed=" + P.pipeSpeed.toFixed(1));
  g.destroy();
}

/* ================= 4. 模式与 hold/gate ================= */
print("\n[4] 四种映射模式");
{
  const g = new BB.Game(makeCanvas());
  g.start();

  g.setMode("gate");
  const gateBefore = g._autopilotOn;
  g.onBlink(g.time, 3, {});
  report("gate：眨眼切换自动驾驶", g._autopilotOn !== gateBefore);

  g.setMode("hold");
  g.onBlink(g.time, 3, {});
  report("hold：进入升力窗口", g._holdActive === true);
  for (let i = 0; i < 80; i++) g._tick(1 / 120);
  report("hold：窗口结束后关闭", g._holdActive === false);

  g.setMode("direct");
  const y0 = g.bird.y;
  g.onBlink(g.time, 3, {});
  report("direct：眨眼立即起跳", g.bird.vy < 0, "vy=" + g.bird.vy.toFixed(1));

  g.setMode("nonexistent");
  report("非法模式被忽略", g.mode === "direct", "mode=" + g.mode);
  g.destroy();
}

/* ================= 5. 边界：空数据 / NaN ================= */
print("\n[5] 边界输入");
{
  const det = new BB.BlinkDetector({ fs: 250 });
  let threw = null;
  try {
    det.push(NaN, NaN, 0);
    for (let i = 1; i < 400; i++) det.push(NaN, NaN, i * 4);
  } catch (e) {
    threw = e;
  }
  report("全 NaN 输入不抛异常", threw === null, threw ? String(threw) : "ok");
  report("全 NaN 不产生眨眼", det.nBlinks === 0, "n=" + det.nBlinks);

  const g = new BB.Game(makeCanvas());
  g.start();
  g.bird.y = -50;
  g._tick(1 / 120);
  report("鸟顶到天花板被夹住", g.bird.y >= BB.GAME_CONST.BIRD_R, "y=" + g.bird.y.toFixed(1));
  g.destroy();
}

/* ============ 6. CSV 解析与极性自纠 ============ */
function makeCsv(header, rows) {
  return [header].concat(rows).join("\n");
}

(async () => {
  /* ---- 6.1 时间列不在第 0 列 ---- */
  print("\n[6] 时间列位置自动识别");
  {
    const rows = [];
    for (let i = 0; i < 500; i++) {
      rows.push(
        ["S01", (i / 250).toFixed(4), Math.sin(i / 7) * 100 + 2000, Math.cos(i / 7) * 100 - 3000, "250"].join(";")
      );
    }
    const p = BB.sources.parseEegCsv(makeCsv("Subject;Time (s);Fp1;Fp2;Sampling Rate", rows), "t1.csv");
    report("通道取到 Fp1 / Fp2", p.channels[0] === "Fp1" && p.channels[1] === "Fp2", p.channels.join(" / "));
    report("采样率 250", Math.abs(p.fs - 250) < 1e-6, p.fs.toFixed(1));
    report("时长约 2 s", Math.abs(p.duration - 499 / 250) < 0.01, p.duration.toFixed(3));
    report("信号没被 Subject 文本列污染", p.ch0.some((v) => Math.abs(v) > 500), "首值 " + p.ch0[0].toFixed(1));
  }

  /* ---- 6.2 无表头 OpenBCI ---- */
  print("\n[7] OpenBCI 无表头（时间列在第 0 列）");
  {
    const rows = [];
    for (let i = 0; i < 500; i++) {
      rows.push([i, (i % 13) * 10, Math.sin(i / 5) * 50, Math.cos(i / 5) * 50].join(","));
    }
    const text = ["%OpenBCI Raw EEG Data", "%Sample Rate = 250.0 Hz", "%"].concat(rows).join("\n");
    const p = BB.sources.parseEegCsv(text, "t2.csv");
    report("识别为 OpenBCI 格式", /OpenBCI/.test(p.format), p.format);
    report("采样率来自注释 250", Math.abs(p.fs - 250) < 1e-6, p.fs.toFixed(1));
    report("跳过序号列", p.channels.length === 2, p.channels.join(" / "));
  }

  /* ---- 6.3 分片解析 == 同步解析 ---- */
  print("\n[8] 分片解析与同步解析结果一致");
  {
    const lines = [];
    for (let i = 0; i < 12000; i++) {
      lines.push([(i / 250).toFixed(4), Math.sin(i / 9) * 120, Math.cos(i / 11) * 120].join(","));
    }
    const text = makeCsv("Time (s),Fp1,Fp2", lines);
    const sync = BB.sources.parseEegCsv(text, "big.csv");
    const steps = [];
    const asy = await BB.sources.parseEegCsvAsync(text, "big.csv", (r) => steps.push(r));

    report("样本数一致", sync.ch0.length === asy.ch0.length, sync.ch0.length + " / " + asy.ch0.length);
    report("采样率一致", Math.abs(sync.fs - asy.fs) < 1e-9, String(asy.fs));
    let maxDiff = 0;
    for (let i = 0; i < sync.ch0.length; i++) maxDiff = Math.max(maxDiff, Math.abs(sync.ch0[i] - asy.ch0[i]));
    report("逐点数值一致", maxDiff === 0, "maxDiff=" + maxDiff);
    report("进度回调被多次调用（确实分片）", steps.length >= 3, "次数 " + steps.length);
    report("进度单调不减", steps.every((v, i) => i === 0 || v >= steps[i - 1]));
    report("最终进度为 1", Math.abs(steps[steps.length - 1] - 1) < 1e-9, steps[steps.length - 1].toFixed(2));
  }

  /* ---- 6.4 极性自纠 ---- */
  print("\n[9] 极性判反后自动翻转");
  {
    const fs = 250;
    const n = 45 * fs;
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = rnd() * 6;
      b[i] = rnd() * 6;
    }
    const truth = [];
    for (let k = 1; k * 3 * fs + 60 < n; k++) {
      const c = Math.round(k * 3 * fs);
      truth.push(c / fs);
      for (let j = 0; j < 50; j++) {
        const g = Math.exp(-((j - 20) * (j - 20)) / 128) * -260;
        a[c + j] += g;
        b[c + j] += g;
      }
    }

    const det = new BB.BlinkDetector({ fs, warmupMs: 800 });
    let flips = 0;
    det.on("polarityFlip", () => flips++);

    for (let i = 0; i < n; i++) {
      det.push(a[i], b[i], (i * 1000) / fs);
      if (i === 2 * fs) {
        det.polarity = 1; // 模拟判反
        det.polarityVotes = { pos: 0, neg: 0 };
        det.warmedUp = true;
      }
    }

    report("极性被翻转", det.polarity === -1, "polarity=" + det.polarity);
    report("翻转只发生一次", flips === 1, "flips=" + flips);
    const afterFlip = det.eventTimes.filter((t) => t > det.polarityFlippedAt).length;
    report("翻转后能检出眨眼", afterFlip >= 5, "翻转后 " + afterFlip + " 次 / 真值 " + truth.length);
  }

  /* ---- 10. onset 确认窗与强度门槛 ---- */
  print("\n[10] onset 确认窗与强度门槛");
  {
    const fs = 250;
    const n = 20 * fs;
    let seed = 777;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    const mkNoise = () => {
      const a = new Float64Array(n);
      const b = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        a[i] = rnd() * 6;
        b[i] = rnd() * 6;
      }
      return [a, b];
    };
    const run = (a, b, opts) => {
      const det = new BB.BlinkDetector(Object.assign({ fs, warmupMs: 800 }, opts));
      let ons = 0;
      det.on("onset", () => ons++);
      for (let i = 0; i < n; i++) det.push(a[i], b[i], (i * 1000) / fs);
      return { ons, blinks: det.nBlinks };
    };
    const c = 10 * fs;
    const pulse = (a, b, amp) => {
      for (let j = 0; j < 50; j++) {
        const g = Math.exp(-((j - 20) * (j - 20)) / 128) * amp;
        a[c + j] += g;
        b[c + j] += g;
      }
    };

    // 真眨眼：200 ms 脉冲
    let [a, b] = mkNoise();
    pulse(a, b, 260);
    let r = run(a, b, {});
    report("真实眨眼能触发 onset", r.ons >= 1, "onset=" + r.ons);

    // 确认窗长 = 延迟代价，必须如实报告在 lag 字段里（毫秒）
    const lagsFor = (confirm) => {
      const [x, y] = mkNoise();
      pulse(x, y, 260);
      const d = new BB.BlinkDetector({ fs, warmupMs: 800, onsetConfirm: confirm });
      const got = [];
      d.on("onset", (e) => got.push(e.lag));
      for (let i = 0; i < n; i++) d.push(x[i], y[i], (i * 1000) / fs);
      return got[0];
    };
    const lag1 = lagsFor(1);
    const lag12 = lagsFor(12);
    report("onsetConfirm=1 → lag 0 ms", lag1 === 0, "lag=" + lag1);
    report("onsetConfirm=12 → lag 48 ms", Math.abs(lag12 - 48) < 1e-6, "lag=" + lag12);
    report("确认窗越短延迟越低", lag1 < lag12);

    // 弱事件 + 高强度门槛
    [a, b] = mkNoise();
    pulse(a, b, 25);
    r = run(a, b, { onsetBoost: 3.0 });
    report("弱事件被强度门槛挡掉（不触发游戏）", r.ons === 0, "onset=" + r.ons);
    report("但 blink 统计仍然记录", r.blinks >= 1, "blinks=" + r.blinks);
  }

  print("\n问题数：" + issues);
  if (issues > 0) throw new Error("行为检查未通过");
})();
