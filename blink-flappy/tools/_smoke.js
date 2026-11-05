/* ============================================================
   _smoke.js — 无浏览器端到端冒烟测试
   ------------------------------------------------------------
   用最小 DOM/Canvas 桩件加载真实前端代码，跑 5 秒合成信号，
   验证：装配无异常 / 样本流动 / 检测触发 / 游戏状态推进。
   ============================================================ */
"use strict";

/* ---------------- DOM 桩件 ---------------- */
const noop = () => {};

const ctxStub = new Proxy(
  {},
  {
    get(t, p) {
      if (p === "createLinearGradient" || p === "createRadialGradient") {
        return () => ({ addColorStop: noop });
      }
      if (p === "measureText") return () => ({ width: 42 });
      if (p === "getImageData") return () => ({ data: [] });
      if (p === "canvas") return { width: 480, height: 640 };
      if (p in t) return t[p];
      return noop;
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  }
);

function makeEl(id) {
  const el = {
    id,
    tagName: "DIV",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    style: {},
    childNodes: [],
    offsetWidth: 20,
    clientWidth: 720,
    width: 480,
    height: 640,
    files: [],
    className: "",
    classList: {
      add: noop,
      remove: noop,
      toggle: noop,
      contains: () => false,
    },
    addEventListener: noop,
    removeEventListener: noop,
    appendChild(c) {
      this.childNodes.push(c);
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
    },
    getContext: () => ctxStub,
    measureText: () => ({ width: 42 }),
    scrollTop: 0,
    scrollHeight: 0,
    setAttribute: noop,
    getAttribute: () => null,
  };
  if (id === "game" || id === "wave") {
    el.tagName = "CANVAS";
  }
  if (id === "thr") el.value = "3.5";
  if (id === "refr") el.value = "400";
  if (id === "simInterval") el.value = "3.2";
  if (id === "serialFs") el.value = "250";
  if (id === "autoThr") el.value = "1";
  if (id === "modeSel") el.value = "assist";
  if (id === "sourceSel") el.value = "sim";
  if (id === "wsUrl") el.value = "ws://127.0.0.1:8765";
  return el;
}

const elements = new Map();
const documentStub = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  },
  createElement(tag) {
    return makeEl("_" + tag);
  },
  addEventListener: noop,
  body: makeEl("body"),
};

/* ---------------- 全局环境 ---------------- */
globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.localStorage = {
  _d: {},
  getItem(k) {
    return k in this._d ? this._d[k] : null;
  },
  setItem(k, v) {
    this._d[k] = String(v);
  },
  removeItem(k) {
    delete this._d[k];
  },
};
globalThis.devicePixelRatio = 2;
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.AudioContext = null;

// setInterval 缺失，用 setTimeout 递归实现
if (typeof setInterval !== "function") {
  globalThis.setInterval = (fn, ms) => {
    let stop = false;
    const loop = () => {
      if (stop) return;
      fn();
      setTimeout(loop, ms);
    };
    setTimeout(loop, ms);
    return { _stop: () => (stop = true) };
  };
  globalThis.clearInterval = (h) => {
    if (h && h._stop) h._stop();
  };
}

let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => {
  rafQueue.push(fn);
  return rafQueue.length;
};
globalThis.cancelAnimationFrame = noop;

/* ---------------- 加载真实代码 ---------------- */
load("js/util.js");
load("js/filter.js");
load("js/detector.js");
load("js/synth.js");
load("js/sources.js");
load("js/game.js");
load("js/main.js");

const BB = globalThis.BB;
const app = globalThis.BB_APP;

let pass = 0;
let fail = 0;
function ok(c, name, detail) {
  if (c) {
    pass++;
    print("  ✓ " + name + (detail ? "  " + detail : ""));
  } else {
    fail++;
    print("  ✗ " + name + (detail ? "  " + detail : ""));
  }
}

print("[装配]");
ok(!!app, "main.js 装配完成");
ok(!!app.game, "Game 已创建");
ok(!!app.det, "Detector 已创建");

const game = app.game;
const det = app.det;

/* ---------------- 驱动帧 ---------------- */
let vt = 0; // 虚拟时间(ms)
function frame(dtMs) {
  vt += dtMs;
  const q = rafQueue;
  rafQueue = [];
  for (const fn of q) {
    try {
      fn(vt);
    } catch (e) {
      print("  帧异常: " + e.message);
    }
  }
}

print("\n[闭环保活 20 s 虚拟时间]");

// 手动搭一条与 main.js 等效的链路
const synth = new BB.BlinkSynth({ fs: 250, meanInterval: 2.6 });
const det2 = new BB.BlinkDetector({ fs: 250, threshold: 3.5, refractoryMs: 400 });
let applied = 0;
let lagSum = 0;
let onsetCount = 0;
let pushIdx = 0;
let batchN = 1;
det2.on("onset", (e) => {
  onsetCount++;
  const lag = (batchN - 1 - pushIdx) / 250;
  if (game.state === "running") {
    game.onBlink(Math.max(0, game.time - lag), e.score);
    applied++;
    lagSum += lag * 1000;
  }
});

game.start();

const FS = 250;
const STEP = 4; // 每帧 4 个样本 ≈ 16 ms
const total = 20 * FS;
let samples = 0;
try {
  while (samples < total) {
    batchN = STEP;
    const x0 = new Float64Array(STEP);
    const x1 = new Float64Array(STEP);
    for (let i = 0; i < STEP; i++) {
      const s = synth.step();
      x0[i] = s.x0;
      x1[i] = s.x1;
    }
    for (let i = 0; i < STEP; i++) {
      pushIdx = i;
      det2.push(x0[i], x1[i], (samples + i) * 1000 / FS);
    }
    samples += STEP;
    frame((STEP / FS) * 1000);
  }
} catch (e) {
  print("  闭环异常: " + e.message + "\n" + e.stack);
}

ok(det2.nSamples > 4000, "检测器收到样本", det2.nSamples + " 个");
ok(synth.spawned.length > 3, "合成器产生了眨眼", synth.spawned.length + " 次");
ok(det2.nBlinks > 0, "检测到眨眼事件", det2.nBlinks + " 次");
ok(onsetCount > 0, "产生 onset 事件", onsetCount + " 次");
ok(applied > 0, "眨眼驱动了游戏", applied + " 次");
ok(game.pipes.length > 0, "管道已生成", game.pipes.length + " 根");
ok(game.time > 8, "游戏时间推进", game.time.toFixed(2) + " s");
ok(det2.polarity !== 0, "极性自动判定", "polarity=" + det2.polarity);
ok(game.state === "running" || game.state === "over", "游戏处于活动状态", game.state);

print("\n[状态]");
print(
  "    samples=" + det2.nSamples + "  blinks=" + det2.nBlinks +
  "  onsets=" + onsetCount + "  applied=" + applied +
  "  score=" + game.score + "  time=" + game.time.toFixed(2) +
  "  state=" + game.state + "  pipes=" + game.pipes.length
);

print("\n" + "=".repeat(52));
print("  通过 " + pass + " / " + (pass + fail) + (fail ? "  ✗ 有失败项" : "  ✓ 全部通过"));
print("=".repeat(52));

if (fail) throw new Error("冒烟测试未通过");
