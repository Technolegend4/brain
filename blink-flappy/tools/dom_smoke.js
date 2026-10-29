/* ============================================================
   dom_smoke.js — 真实运行时冒烟测试
   用 DOM / canvas / 音频 / 定时器桩加载真正的 main.js，
   走完「初始化 → 载入示例 CSV → 连接 → 推进 → 注入眨眼」全链路。
   目的是在没有浏览器 console 的情况下，证明页面真的能跑起来。
   ============================================================ */
"use strict";

const ROOT = "/Users/zhangzhengzhuo/Desktop/脑机项目/";

/* ---------------- 虚拟时钟 ---------------- */
let vnow = 0;
let tid = 1;
const timers = [];
const rafQ = [];

function vSetTimeout(fn, ms) {
  const id = tid++;
  timers.push({ id, at: vnow + (ms || 0), step: 0, fn });
  return id;
}
function vSetInterval(fn, ms) {
  const id = tid++;
  timers.push({ id, at: vnow + ms, step: Math.max(1, ms), fn });
  return id;
}
function vClear(id) {
  for (let i = timers.length - 1; i >= 0; i--) if (timers[i].id === id) timers.splice(i, 1);
}
function vRaf(fn) { rafQ.push(fn); return rafQ.length; }

async function advance(ms, dt) {
  dt = dt || 16;
  const end = vnow + ms;
  let guard = 0;
  while (vnow < end) {
    if (++guard > 200000) throw new Error("虚拟时钟步数超限");
    vnow += dt;
    for (let i = timers.length - 1; i >= 0; i--) {
      const t = timers[i];
      if (t.at <= vnow) {
        if (t.step > 0) t.at += t.step; else timers.splice(i, 1);
        t.fn();
      }
    }
    const q = rafQ.splice(0, rafQ.length);
    for (let i = 0; i < q.length; i++) q[i](vnow);
    await null; // 让微任务（Promise 链）推进
  }
}

/* ---------------- DOM 桩 ---------------- */
const ctxCalls = { n: 0 };

function makeCtx() {
  const store = { lineWidth: 1, globalAlpha: 1, font: "", width: 10 };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      return function () { ctxCalls.n++; return { addColorStop() {}, width: 10 }; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const elCache = new Map();

function makeEl(id) {
  if (elCache.has(id)) return elCache.get(id);
  const el = {
    id: id, value: "", textContent: "", innerHTML: "", className: "", checked: false,
    disabled: false, offsetWidth: 100, width: 800, height: 300, scrollTop: 0, scrollHeight: 0,
    style: {}, dataset: {}, _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    removeEventListener() {},
    fire(t, ev) {
      const list = this._h[t] || [];
      const e = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, ev || {});
      let last = null;
      for (const fn of list) last = fn(e);
      return last;
    },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    childNodes: [], firstChild: null, parentNode: null,
    appendChild(c) { this.childNodes.push(c); c.parentNode = this; this.firstChild = this.childNodes[0]; return c; },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      this.firstChild = this.childNodes[0] || null;
      return c;
    },
    remove() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return makeEl(id + "_qs"); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 }; },
    getContext() { return makeCtx(); },
    focus() {}, blur() {}, click() { this.fire("click"); },
    scrollTo() {}, cloneNode() { return makeEl(id + "_clone"); },
    toDataURL() { return "data:,"; },
  };
  elCache.set(id, el);
  return el;
}

const documentStub = {
  getElementById(id) { return makeEl(id); },
  createElement(tag) { return makeEl("el_" + tag + "_" + tid++); },
  querySelector(sel) { return makeEl("qs_" + sel); },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  body: makeEl("body"),
  documentElement: makeEl("html"),
  readyState: "complete",
};

/* ---------------- 音频 / 存储 / 网络桩 ---------------- */
class FakeAC {
  constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() {
    return {
      type: "", frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
      connect(x) { return x; }, start() {}, stop() {},
    };
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
      connect(x) { return x; },
    };
  }
  get sampleRate() { return 44100; }
  createBiquadFilter() {
    return { type: "", frequency: { value: 0, setValueAtTime() {} }, Q: { value: 0 }, gain: { value: 0 }, connect(x) { return x; } };
  }
  createBuffer(ch, len) { return { getChannelData() { return new Float32Array(len || 4410); } }; }
  createBufferSource() { return { buffer: null, connect(x) { return x; }, start() {}, stop() {} }; }
}

const winHandlers = {};
globalThis.addEventListener = (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn); };
globalThis.removeEventListener = () => {};
globalThis.fireWindow = (t, ev) => {
  const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, ev || {});
  for (const fn of winHandlers[t] || []) fn(e);
};
globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.performance = { now: () => vnow };
globalThis.requestAnimationFrame = vRaf;
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = vSetTimeout;
globalThis.setInterval = vSetInterval;
globalThis.clearTimeout = vClear;
globalThis.clearInterval = vClear;
globalThis.AudioContext = FakeAC;
globalThis.webkitAudioContext = FakeAC;
globalThis.devicePixelRatio = 2;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.navigator = { userAgent: "jsc", serial: undefined };
globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.WebSocket = function () { throw new Error("测试中不建 WebSocket"); };
globalThis.fetch = function (url) {
  let p = url;
  try { p = decodeURIComponent(url); } catch (e) {}
  if (p.indexOf("../") === 0) p = p.slice(3);
  const full = ROOT + p;
  return Promise.resolve({
    ok: true,
    status: 200,
    text() { return Promise.resolve(read(full)); },
  });
};

/* ---------------- 加载应用 ---------------- */
load(ROOT + "blink-flappy/js/util.js");
load(ROOT + "blink-flappy/js/filter.js");
load(ROOT + "blink-flappy/js/detector.js");
load(ROOT + "blink-flappy/js/synth.js");
load(ROOT + "blink-flappy/js/sources.js");
load(ROOT + "blink-flappy/js/game.js");
load(ROOT + "blink-flappy/js/main.js");

/* ---------------- 断言工具 ---------------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; print("  ✓ " + name); }
  else { fail++; print("  ✗ " + name + (extra ? "  [" + extra + "]" : "")); }
}

(async function run() {
  // 按 index.html 的真实默认值初始化滑块
  makeEl("thr").value = "3.4";
  makeEl("refr").value = "300";
  makeEl("boost").value = "1.10";
  makeEl("playSpeed").value = "1";
  makeEl("simInterval").value = "1.6";
  makeEl("serialFs").value = "250";
  makeEl("sourceSel").value = "sim";

  const app = globalThis.BB_APP;
  print("A. 初始化");
  ok("BB_APP 已暴露", !!app, typeof app);
  if (!app) { print("初始化失败，后续跳过"); throw new Error("no app"); }
  ok("检测器已创建", !!app.det);
  ok("游戏已创建", !!app.game);
  ok("初始未连接", app.S.connected === false);

  print("B. 载入示例 CSV");
  const btnDemo = makeEl("btnDemoCsv");
  btnDemo.fire("click");
  await advance(1500);
  const parsed = app.S.csvParsed;
  ok("CSV 解析完成", !!parsed, parsed ? "" : "csvParsed 为空");
  if (parsed) {
    ok("采样率识别为 250 Hz", Math.abs(parsed.fs - 250) < 1, "fs=" + parsed.fs);
    ok("时长 > 50 s", parsed.duration > 50, "duration=" + parsed.duration.toFixed(1));
    ok("两个通道有数据", parsed.ch0.length === parsed.ch1.length && parsed.ch0.length > 1000,
       "n=" + parsed.ch0.length);
    ok("界面显示文件信息", makeEl("vCsvInfo").textContent.indexOf("Hz") > 0,
       makeEl("vCsvInfo").textContent);
  }

  print("C. 连接并开始（CSV 源）");
  makeEl("thr").value = "3.4";
  makeEl("refr").value = "300";
  makeEl("boost").value = "1.10";
  const p = makeEl("btnConnect").fire("click");
  await advance(400);
  if (p && typeof p.then === "function") { await p; await advance(200); }
  ok("状态变为已连接", app.S.connected === true);
  ok("信号源已建立", !!app.S.source);
  ok("采样率同步到界面状态", app.S.fs > 0, "fs=" + app.S.fs);

  print("D. 推进 12 秒，检测器应产出事件");
  const before = app.S.samples;
  // blinksApplied 每局开始会归零，改用事件计数统计整段
  let appliedTotal = 0;
  app.game.on("blinkApplied", () => appliedTotal++);
  await advance(12000, 20);
  ok("样本在流动", app.S.samples > before, before + " → " + app.S.samples);
  ok("检测到眨眼事件", app.S.events.length > 0, "事件 " + app.S.events.length + " 个");
  ok("眨眼真正驱动了小鸟跳跃", appliedTotal > 0, "跳跃 " + appliedTotal + " 次");
  ok("回放进度条在走", parseFloat(makeEl("playBar").style.width) > 0,
     makeEl("playBar").style.width);
  ok("眨眼计数已更新", parseInt(makeEl("vBlinkCount").textContent, 10) > 0,
     makeEl("vBlinkCount").textContent);
  ok("波形缓冲有数据", app.S.wave.z0.size > 0, "size=" + app.S.wave.z0.size);
  ok("canvas 有绘制调用", ctxCalls.n > 0, "调用 " + ctxCalls.n + " 次");
  ok("游戏已开始计时", app.game.time > 0, "t=" + app.game.time.toFixed(2));
  ok("分数/存活状态合理", app.game.state !== undefined || app.game.alive !== undefined,
     "state=" + app.game.state + " alive=" + app.game.alive);

  print("E. 手动注入眨眼（按钮 + 空格）");
  // 推进 12 秒无人操作时鸟可能已经撞死，先开局再验证注入
  app.game.start();
  await advance(100);
  const appliedBefore = app.game.blinksApplied || 0;
  makeEl("btnSimBlink").fire("click");
  await advance(300);
  const appliedAfterClick = app.game.blinksApplied || 0;
  ok("点击「注入眨眼」产生跳跃", appliedAfterClick > appliedBefore,
     appliedBefore + " → " + appliedAfterClick);

  app.game.start();
  await advance(100);
  const beforeSpace = app.game.blinksApplied || 0;
  fireWindow("keydown", { code: "Space", key: " " });
  await advance(300);
  ok("空格键也能注入眨眼跳跃", (app.game.blinksApplied || 0) > beforeSpace,
     beforeSpace + " → " + (app.game.blinksApplied || 0));

  // 空格在未连接时不应该乱跳，而是给提示。
  // 注意必须真的断开：只改 S.connected 的话 CSV 里的真实眨眼仍会触发跳跃。
  app.disconnect();
  await advance(200);
  const nowApplied = app.game.blinksApplied || 0;
  fireWindow("keydown", { code: "Space", key: " " });
  await advance(300);
  ok("断开连接后空格不跳（只提示）", (app.game.blinksApplied || 0) === nowApplied,
     nowApplied + " → " + (app.game.blinksApplied || 0));

  // 重新接上 CSV，后面的暂停/继续才有信号可停
  makeEl("sourceSel").value = "csv";
  const pRe = makeEl("btnConnect").fire("click");
  await advance(400);
  if (pRe && typeof pRe.then === "function") { await pRe; await advance(200); }
  ok("断开后可重新连接", app.S.connected === true);

  print("F. 暂停 / 继续 / 断开");
  makeEl("btnPause").fire("click");
  await advance(100);
  ok("暂停后 S.paused = true", app.S.paused === true);
  const samplesAtPause = app.S.samples;
  await advance(2000, 20);
  ok("暂停后样本不再增长", app.S.samples === samplesAtPause,
     samplesAtPause + " → " + app.S.samples);

  makeEl("btnPause").fire("click");
  await advance(600);
  ok("继续后恢复流动", app.S.samples > samplesAtPause);

  makeEl("btnStop").fire("click");
  await advance(200);
  ok("断开后 connected = false", app.S.connected === false);
  ok("断开后按钮状态复原", makeEl("btnConnect").disabled === false);
  ok("断开后暂停按钮文案复原", makeEl("btnPause").textContent === "暂停",
     makeEl("btnPause").textContent);

  print("G. 参数滑块");
  makeEl("thr").value = "5.5";
  makeEl("thr").fire("input");
  ok("阈值滑块写入检测器", Math.abs(app.det.threshold - 5.5) < 1e-6, String(app.det.threshold));
  ok("阈值标签同步", makeEl("vThr").textContent.indexOf("5.5") === 0, makeEl("vThr").textContent);

  makeEl("boost").value = "1.45";
  makeEl("boost").fire("input");
  ok("灵敏度滑块写入 onsetBoost", Math.abs(app.det.o.onsetBoost - 1.45) < 1e-6,
     String(app.det.o.onsetBoost));
  ok("灵敏度标签同步", makeEl("vBoost").textContent === "1.45", makeEl("vBoost").textContent);

  makeEl("refr").value = "500";
  makeEl("refr").fire("input");
  ok("不应期滑块写入", app.det.o.refractoryMs === 500, String(app.det.o.refractoryMs));

  print("H. 合成 EEG 源（无硬件路径）");
  // 上一段把阈值调到 5.5 会挡掉合成眨眼，这里恢复默认
  makeEl("thr").value = "3.4";
  makeEl("refr").value = "300";
  makeEl("sourceSel").value = "sim";
  makeEl("simInterval").value = "1.6";
  const pSim = makeEl("btnConnect").fire("click");
  await advance(300);
  if (pSim && typeof pSim.then === "function") { await pSim; await advance(200); }
  ok("合成源连接成功", app.S.connected === true);
  ok("信号源类型为 sim", app.S.source && app.S.source.kind === "sim",
     app.S.source ? app.S.source.kind : "null");

  app.game.start();
  const simAppliedBefore = app.game.blinksApplied || 0;
  const evBefore = app.S.events.length;
  // 合成源的眨眼间隔是随机的，给足 20 s（meanInterval=1.6 s）以保证断言确定
  await advance(20000, 20);
  ok("合成源自动产生眨眼事件", app.S.events.length > evBefore || (app.game.blinksApplied || 0) > simAppliedBefore,
     "事件 " + evBefore + " → " + app.S.events.length + "，跳跃 " + simAppliedBefore + " → " + (app.game.blinksApplied || 0));
  ok("游戏在推进", app.game.time > 0, "t=" + app.game.time.toFixed(2));

  makeEl("btnStop").fire("click");
  await advance(100);
  ok("合成源可正常断开", app.S.connected === false);

  print("I. 清空日志");
  const logEl = makeEl("log");
  logEl.textContent = "xxx";
  makeEl("btnClearLog").fire("click");
  ok("清空按钮生效", logEl.textContent === "", JSON.stringify(logEl.textContent));

  print("");
  print("结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail > 0) throw new Error("有 " + fail + " 项失败");
})().catch((e) => { print("中止：" + (e && e.message ? e.message : e)); });
