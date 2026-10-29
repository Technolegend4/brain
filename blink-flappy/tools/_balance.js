"use strict";
/* 游戏平衡性诊断：无渲染，跑物理，记录死亡点 */
const noop = () => {};
globalThis.window = globalThis;
globalThis.document = { getElementById: () => ({ getContext: () => ({}), addEventListener: noop }), createElement: () => ({ classList: { add: noop, remove: noop } }), addEventListener: noop, body: {} };
globalThis.localStorage = { getItem: () => "0", setItem: noop };
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = noop;
globalThis.requestAnimationFrame = noop;
globalThis.AudioContext = null;

load("js/util.js");
load("js/filter.js");
load("js/detector.js");
load("js/synth.js");
load("js/sources.js");
load("js/game.js");

const BB = globalThis.BB;
const W = 480, H = 640;

// 手动构造一个假 canvas
const canvas = { width: 480, height: 640, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) };
const game = new BB.Game(canvas);

game.on("hit", () => {
  const pipes = game.pipes.map((p) => "x=" + p.x.toFixed(0) + " gap=" + p.gapY.toFixed(0)).join(" | ");
  print("  HIT t=" + game.time.toFixed(2) + " y=" + game.bird.y.toFixed(0) +
        " vy=" + game.bird.vy.toFixed(0) + " target=" + (game._targetY || 0).toFixed(0) +
        " score=" + game.score);
  print("      pipes: " + pipes);
});

game.setMode("assist");
game.start();

const STEP = 1 / 120;
let frames = 0;
const DURATION = 60;
let deaths = 0;
let maxScore = 0;

while (game.time < DURATION) {
  game._tick(STEP);
  frames++;
  if (game.state === "over") {
    // 立即重开，统计存活时长
    deaths++;
    maxScore = Math.max(maxScore, game.score);
    game.start();
  }
  if (game.state === "dying") {
    // 推进死亡动画
    game._tick(STEP);
  }
}

print("\n60 秒内死亡 " + deaths + " 次，最高分 " + maxScore);
