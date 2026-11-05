/* ============================================================
   game.js — 眨眼小鸟（Blink Bird）
   ------------------------------------------------------------
   原创实现，未复制任何第三方游戏代码或美术资源。
   玩法内核（重力/振翅/管道）属于通用游戏机制，
   角色形象、配色、音效、界面均为本项目自绘/合成。

   主要设计：
     * 固定步长物理（120 Hz），帧率无关
     * 眨眼事件的时间戳回溯补偿（rollback），消除检测延迟带来的手感损失
     * 难度随实测眨眼率自适应，保证不同眨眼频率的人都能玩
   ============================================================ */
(function (root) {
  "use strict";

  const BB = (root.BB = root.BB || {});
  const U = BB.util;

  const W = 480;
  const H = 640;
  const FLOOR_H = 58;
  const FLOOR_Y = H - FLOOR_H;
  const BIRD_X = 132;
  const BIRD_R = 15;

  const PHYS = {
    gravity: 1650,
    jumpV: -540,
    maxFall: 900,
    pipeSpeed: 190,
    pipeW: 74,
    gap: 172,
    pipeSpacing: 208, // 水平间距（px）
    minGap: 150,
    maxGap: 230,
    step: 1 / 120,
    ceiling: 6,
  };
  // 难度自适应用的是全局 PHYS，必须在开局时复原，否则上一局的紧节奏会带到下一局
  const PHYS_DEFAULT = { gap: PHYS.gap, pipeSpeed: PHYS.pipeSpeed };

  const MODES = {
    assist: "辅助振翅 + 眨眼加成",
    direct: "一次眨眼 = 一次跳",
    hold: "闭眼上升 / 睁眼下落",
    gate: "眨眼开关节拍",
  };

  /* ============================================================
     音效（WebAudio 合成，无外部音频文件）
     ============================================================ */
  class Sfx {
    constructor() {
      this.ctx = null;
      this.on = true;
    }

    _ensure() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    }

    _blip({ freq = 440, to = null, dur = 0.09, type = "sine", gain = 0.09, delay = 0 }) {
      if (!this.on) return;
      const ctx = this._ensure();
      if (!ctx) return;
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    _noise({ dur = 0.18, gain = 0.14, cutoff = 900 }) {
      if (!this.on) return;
      const ctx = this._ensure();
      if (!ctx) return;
      const n = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoff;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(lp).connect(g).connect(ctx.destination);
      src.start();
    }

    flap() {
      this._blip({ freq: 300, to: 620, dur: 0.075, type: "triangle", gain: 0.055 });
    }
    score() {
      this._blip({ freq: 784, dur: 0.07, type: "sine", gain: 0.07 });
      this._blip({ freq: 1046, dur: 0.1, type: "sine", gain: 0.06, delay: 0.07 });
    }
    hit() {
      this._noise({ dur: 0.22, gain: 0.16, cutoff: 700 });
      this._blip({ freq: 160, to: 70, dur: 0.25, type: "sawtooth", gain: 0.07 });
    }
    die() {
      this._blip({ freq: 520, to: 90, dur: 0.55, type: "square", gain: 0.05 });
    }
    unlock() {
      this._blip({ freq: 660, dur: 0.06, type: "sine", gain: 0.04 });
    }
  }

  /* ============================================================
     Game
     ============================================================ */
  class Game extends U.Emitter {
    constructor(canvas) {
      super();
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.sfx = new Sfx();

      this.mode = "assist";
      this.assist = true;

      this.state = "ready"; // ready | running | dying | over
      this.time = 0;
      this.score = 0;
      this.best = Number(localStorage.getItem("blinkbird.best") || 0);
      this.blinks = 0;
      this.blinksApplied = 0;
      this.hits = 0;
      this.blinkRate = 0;

      this.bird = { y: H * 0.44, vy: 0, rot: 0, wing: 0 };
      this.pipes = [];
      this.particles = [];
      this.spawnX = W + 120;

      this._acc = 0;
      this._last = 0;
      this._history = [];
      this._targetY = H * 0.52;
      this._blinkBoostUntil = 0;
      this._autopilotOn = false;
      this._shake = 0;
      this._flash = 0;
      this._deathTimer = 0;
      this._lastJumpAt = -9;
      this._minJumpGap = 0.09;
      this._holdActive = false;
      this._holdEndAt = 0;

      this._dpr = Math.min(root.devicePixelRatio || 1, 2);
      this.resize();

      this._raf = null;
      this._loop = this._loop.bind(this);
      this._raf = requestAnimationFrame(this._loop);
    }

    resize() {
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      this._dpr = dpr;
      this.cv.width = Math.round(W * dpr);
      this.cv.height = Math.round(H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* ---------------- 生命周期 ---------------- */

    reset() {
      this.state = "ready";
      this.time = 0;
      this.score = 0;
      this.blinks = 0;
      this.blinksApplied = 0;
      this.hits = 0;
      // 复原难度：自适应改的是模块级 PHYS，不复原会跨局累积
      PHYS.gap = PHYS_DEFAULT.gap;
      PHYS.pipeSpeed = PHYS_DEFAULT.pipeSpeed;
      this.blinkRate = 0;
      this.bird = { y: H * 0.44, vy: 0, rot: 0, wing: 0 };
      this.pipes = [];
      this.particles = [];
      this.spawnX = W + 220;
      this._acc = 0;
      this._history.length = 0;
      this._targetY = H * 0.52;
      this._blinkBoostUntil = 0;
      this._autopilotOn = false;
      this._shake = 0;
      this._flash = 0;
      this._deathTimer = 0;
      this._lastJumpAt = -9;
      this._holdActive = false;
      this.emit("reset", {});
    }

    start() {
      this.reset();
      this.state = "running";
      this.sfx.unlock();
      this.emit("start", {});
    }

    pause() {
      if (this.state === "running") {
        this.state = "paused";
        this.emit("pause", {});
      }
    }

    resume() {
      if (this.state === "paused") {
        this.state = "running";
        this._last = performance.now();
        this.emit("resume", {});
      }
    }

    setMode(m) {
      if (!MODES[m]) return;
      this.mode = m;
      this._autopilotOn = false;
      this.emit("mode", { mode: m });
    }

    setDifficultyFromRate(ratePerMin) {
      this.blinkRate = ratePerMin;
      // 眨眼越慢，间隙越大、管道越慢；快的人给更紧的挑战
      const r = U.clamp(ratePerMin, 0, 60);
      const t = U.clamp(r / 40, 0, 1);
      PHYS.gap = U.lerp(206, 152, t);
      PHYS.pipeSpeed = U.lerp(158, 218, t);
    }

    /* ---------------- 眨眼事件入口 ---------------- */

    /**
     * 由检测器触发。tEvent 为事件在游戏时间轴上的时刻（秒）。
     * 若事件比当前时刻早，会回溯补算，保证手感。
     */
    onBlink(tEvent, score, opts = {}) {
      if (this.state !== "running") return;
      this.blinks++;
      const lag = this.time - tEvent;

      // 眨眼越有力，升力越大（±20%）。这是"脑机"手感的核心：
      // 同一个动作有强弱之分，比"二值键盘"更有身体感。
      const strength = U.clamp(0.8 + ((score || 5) - 4) * 0.05, 0.8, 1.2);

      if (this.mode === "direct" || this.mode === "assist") {
        if (this.mode === "assist") {
          // 眨眼 = 主动拉高 + 1 秒内目标高度上移（越有力，抬得越久）
          this._blinkBoostUntil = this.time + 1.0 * strength;
        }
        // 玩家输入必须响应：自动振翅刚起跳过也照样给一次升力，
        // 否则 assist 模式下约 1/3 的眨眼会被 _minJumpGap 吞掉，手感是"没反应"
        this._jumpAt(tEvent, lag, true, strength);
      } else if (this.mode === "hold") {
        this._holdActive = true;
        // 升力窗口也随强度伸缩
        this._holdEndAt = this.time + 0.22 + 0.1 * strength;
      } else if (this.mode === "gate") {
        this._autopilotOn = !this._autopilotOn;
        this.emit("gate", { on: this._autopilotOn });
      }

      this.emit("blinkApplied", { lag, score, mode: this.mode });
    }

    onBlinkEnd() {
      this._holdActive = false;
    }

    /**
     * 起跳（含回溯补偿）。
     * @param {number} tEvent 事件真实发生时刻（游戏秒）
     * @param {number} lag 检测到它时已过去的时间
     */
    _jumpAt(tEvent, lag, force, strength) {
      lag = U.clamp(lag, 0, 0.45);
      const k = strength || 1;
      // 强制触发也留一个生理下限：40 ms 内不可能有两次真实眨眼，
      // 挡住键盘连点造成的"无限上升"
      if (force && this.time - this._lastJumpAt < 0.04) return;

      if (lag > 0.005 && this._history.length > 3) {
        // ---- 回溯到事件时刻 ----
        let snap = this._history[0];
        for (let i = this._history.length - 1; i >= 0; i--) {
          if (this._history[i].t <= tEvent) {
            snap = this._history[i];
            break;
          }
        }
        this.bird.y = snap.y;
        this.bird.vy = snap.vy;

        // 施加跳跃，并按固定步长快进回当前时刻
        if (force || this.time - this._lastJumpAt >= this._minJumpGap) {
          // 强制触发时不叠加更大初速，避免连续眨眼"越跳越高"
          this.bird.vy = force
            ? Math.min(this.bird.vy, PHYS.jumpV * k)
            : PHYS.jumpV * k;
          this._lastJumpAt = this.time;
          this._flapFx();
          this.blinksApplied++;
        }
        let remain = lag;
        const step = PHYS.step;
        while (remain > 1e-6) {
          const dt = Math.min(step, remain);
          this._integrateBird(dt);
          remain -= dt;
        }
        this._trimHistory();
        return;
      }

      // ---- 无延迟：直接起跳 ----
      if (!force && this.time - this._lastJumpAt < this._minJumpGap) return;
      this.bird.vy = force
        ? Math.min(this.bird.vy, PHYS.jumpV * k)
        : PHYS.jumpV * k;
      this._lastJumpAt = this.time;
      this._flapFx();
      this.blinksApplied++;
    }

    _flapFx() {
      this.bird.wing = 1;
      this.sfx.flap();
      for (let i = 0; i < 4; i++) {
        this.particles.push({
          x: BIRD_X - 10,
          y: this.bird.y + 6,
          vx: -40 - Math.random() * 60,
          vy: 30 + Math.random() * 70,
          life: 0.35 + Math.random() * 0.2,
          age: 0,
          r: 1.6 + Math.random() * 1.8,
          color: "rgba(255,255,255,0.75)",
        });
      }
    }

    /* ---------------- 物理 ---------------- */

    _integrateBird(dt) {
      const b = this.bird;
      b.vy = Math.min(b.vy + PHYS.gravity * dt, PHYS.maxFall);
      b.y += b.vy * dt;
      if (b.y < PHYS.ceiling + BIRD_R) {
        b.y = PHYS.ceiling + BIRD_R;
        b.vy = Math.max(b.vy, 0);
      }
    }

    _recordHistory() {
      this._history.push({ t: this.time, y: this.bird.y, vy: this.bird.vy });
      this._trimHistory();
    }

    _trimHistory() {
      const from = this.time - 0.7;
      let cut = 0;
      while (cut < this._history.length - 2 && this._history[cut].t < from) cut++;
      if (cut > 0) this._history.splice(0, cut);
    }

    /* ---------------- 主循环 ---------------- */

    _loop(ts) {
      this._raf = requestAnimationFrame(this._loop);
      if (!this._last) this._last = ts;
      let dt = (ts - this._last) / 1000;
      this._last = ts;
      if (dt > 0.1) dt = 0.1;

      const active = this.state === "running" || this.state === "dying";
      if (active) {
        this._acc += dt;
        let guard = 0;
        while (this._acc >= PHYS.step && guard++ < 400) {
          this._acc -= PHYS.step;
          this._tick(PHYS.step);
        }
      }

      this._render(dt);
    }

    _tick(dt) {
      if (this.state === "dying") {
        this._deathTimer += dt;
        this.bird.vy = Math.min(this.bird.vy + PHYS.gravity * dt, PHYS.maxFall);
        this.bird.y += this.bird.vy * dt;
        this._shake = Math.max(0, this._shake - dt * 3);
        if (this._deathTimer > 0.85) {
          this.state = "over";
          this.emit("gameover", {
            score: this.score,
            best: this.best,
            blinks: this.blinks,
          });
        }
        return;
      }

      this.time += dt;
      this.bird.wing = Math.max(0, this.bird.wing - dt * 5);

      // ---- 自动振翅（assist / gate）----
      // 用"目标高度 + P 控制"代替固定节拍：固定节拍会累积高度误差，最终必撞管道。
      const beatOn =
        (this.mode === "assist" && this.assist) ||
        (this.mode === "gate" && this._autopilotOn);

      if (beatOn) {
        const target = this._autoTargetY(dt);
        if (
          this.bird.vy >= 0 &&
          this.bird.y > target &&
          this.time - this._lastJumpAt > 0.13
        ) {
          this.bird.vy = PHYS.jumpV * 0.82;
          this._lastJumpAt = this.time;
          this._flapFx();
        }
      }

      // ---- hold 模式：眨眼期间持续升力 ----
      if (this.mode === "hold") {
        if (this._holdActive && this.time < this._holdEndAt) {
          this.bird.vy = Math.min(this.bird.vy, 0);
          this.bird.vy -= 2400 * dt;
          this.bird.vy = Math.max(this.bird.vy, -420);
          if (Math.random() < 0.25) this._flapFx();
        } else {
          this._holdActive = false;
        }
      }

      this._integrateBird(dt);

      // ---- 管道生成（按水平间距，而不是固定计时，速度变化时间距才稳定）----
      if (this.pipes.length === 0) {
        if (this.time > 0.75) this._spawnPipe();
      } else {
        const last = this.pipes[this.pipes.length - 1];
        if (last.x < W - PHYS.pipeSpacing && this.pipes.length < 6) {
          this._spawnPipe();
        }
      }
      for (const p of this.pipes) p.x -= PHYS.pipeSpeed * dt;
      this.pipes = this.pipes.filter((p) => p.x + PHYS.pipeW > -20);

      // ---- 碰撞 ----
      if (this.bird.y + BIRD_R >= FLOOR_Y) {
        this.bird.y = FLOOR_Y - BIRD_R;
        this._hit(true);
      } else if (this.bird.y - BIRD_R <= PHYS.ceiling) {
        this.bird.y = PHYS.ceiling + BIRD_R;
        this.bird.vy = 0;
      }

      for (const p of this.pipes) {
        const top = p.gapY - PHYS.gap / 2;
        const bot = p.gapY + PHYS.gap / 2;
        const overlapX = BIRD_X + BIRD_R > p.x && BIRD_X - BIRD_R < p.x + PHYS.pipeW;
        if (overlapX && (this.bird.y - BIRD_R < top || this.bird.y + BIRD_R > bot)) {
          this._hit(false);
        }
        if (!p.scored && p.x + PHYS.pipeW < BIRD_X - BIRD_R) {
          p.scored = true;
          this.score++;
          this.sfx.score();
          this._flash = 0.18;
          this.emit("score", { score: this.score });
        }
      }

      this.bird.rot = U.clamp(this.bird.vy / 700, -0.42, 1.15);
      this._trimHistory();
      this._recordHistory();
    }

    _spawnPipe() {
      const marginTop = 84;
      const marginBot = FLOOR_Y - 96;
      const center = marginTop + Math.random() * (marginBot - marginTop);
      this.pipes.push({
        x: W + 20,
        gapY: U.clamp(center, marginTop + PHYS.gap / 2, marginBot - PHYS.gap / 2),
        scored: false,
        seed: Math.random(),
      });
    }

    /**
     * 自动振翅的目标高度：跟随前方管道的间隙中心，
     * 但每秒最多移动 130 px —— 转不过来的时候就该玩家出手了。
     */
    _autoTargetY(dt) {
      let goal = H * 0.52;
      for (const p of this.pipes) {
        if (p.x + PHYS.pipeW > BIRD_X - 26) {
          goal = p.gapY;
          break;
        }
      }
      // 眨眼带来的临时拉高
      const lift = this.time < this._blinkBoostUntil ? 46 : 0;
      goal -= lift;

      const maxMove = 300 * dt;
      const cur = Number.isFinite(this._targetY) ? this._targetY : H * 0.52;
      this._targetY = cur + U.clamp(goal - cur, -maxMove, maxMove);
      return U.clamp(
        this._targetY,
        PHYS.ceiling + 60,
        FLOOR_Y - 70
      );
    }

    _hit(isFloor) {
      if (this.state !== "running") return;
      this.state = "dying";
      this.hits++;
      this._deathTimer = 0;
      this._shake = 1;
      this.bird.vy = isFloor ? -180 : 260;
      this.sfx.hit();
      this.sfx.die();
      if (this.score > this.best) {
        this.best = this.score;
        localStorage.setItem("blinkbird.best", String(this.best));
      }
      this.emit("hit", { score: this.score });
    }

    /* ---------------- 渲染 ---------------- */

    _render(frameDt) {
      const ctx = this.ctx;
      const t = this.time;

      ctx.save();
      if (this._shake > 0) {
        const s = this._shake * this._shake * 7;
        ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      }

      this._drawSky(ctx, t);
      this._drawFar(ctx, t);
      this._drawPipes(ctx);
      this._drawFloor(ctx, t);
      this._drawParticles(ctx, frameDt);
      this._drawBird(ctx, t);
      ctx.restore();

      this._drawHud(ctx);

      if (this._flash > 0) {
        ctx.fillStyle = "rgba(255,255,255," + this._flash + ")";
        ctx.fillRect(0, 0, W, H);
        this._flash = Math.max(0, this._flash - frameDt * 1.6);
      }

      if (this._shake > 0) this._shake = Math.max(0, this._shake - frameDt * 2.2);
    }

    _drawSky(ctx, t) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#5fb8e8");
      g.addColorStop(0.45, "#9ed9f3");
      g.addColorStop(1, "#dff1f8");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // 太阳
      ctx.save();
      ctx.globalAlpha = 0.55;
      const sunG = ctx.createRadialGradient(392, 96, 6, 392, 96, 62);
      sunG.addColorStop(0, "#fff8d6");
      sunG.addColorStop(1, "rgba(255,248,214,0)");
      ctx.fillStyle = sunG;
      ctx.beginPath();
      ctx.arc(392, 96, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 云（视差）
      ctx.fillStyle = "rgba(255,255,255,0.78)";
      for (let i = 0; i < 5; i++) {
        const speed = 12 + i * 5;
        const cx = ((t * speed + i * 137) % (W + 220)) - 110;
        const cy = 72 + ((i * 61) % 150);
        const s = 0.6 + (i % 3) * 0.28;
        ctx.beginPath();
        ctx.ellipse(cx, cy, 40 * s, 17 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + 30 * s, cy + 4 * s, 26 * s, 13 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - 28 * s, cy + 6 * s, 22 * s, 11 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    _drawFar(ctx, t) {
      // 远山
      ctx.fillStyle = "#8fc9c0";
      ctx.beginPath();
      ctx.moveTo(0, FLOOR_Y);
      const off = (t * 8) % 260;
      for (let x = -off; x < W + 300; x += 130) {
        ctx.lineTo(x + 65, FLOOR_Y - 78 - ((x * 37) % 34));
        ctx.lineTo(x + 130, FLOOR_Y);
      }
      ctx.lineTo(W, FLOOR_Y);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#79b8b0";
      ctx.beginPath();
      ctx.moveTo(0, FLOOR_Y);
      const off2 = (t * 15) % 190;
      for (let x = -off2; x < W + 220; x += 95) {
        ctx.lineTo(x + 47, FLOOR_Y - 46 - ((x * 53) % 26));
        ctx.lineTo(x + 95, FLOOR_Y);
      }
      ctx.lineTo(W, FLOOR_Y);
      ctx.closePath();
      ctx.fill();
    }

    _drawPipes(ctx) {
      for (const p of this.pipes) {
        const top = p.gapY - PHYS.gap / 2;
        const bot = p.gapY + PHYS.gap / 2;
        this._pipeBody(ctx, p.x, 0, PHYS.pipeW, top, true);
        this._pipeBody(ctx, p.x, bot, PHYS.pipeW, FLOOR_Y - bot, false);
      }
    }

    _pipeBody(ctx, x, y, w, h, isTop) {
      if (h <= 0) return;
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, "#3f8f34");
      g.addColorStop(0.16, "#7ec95c");
      g.addColorStop(0.5, "#5cb043");
      g.addColorStop(0.86, "#3d8a32");
      g.addColorStop(1, "#2c6626");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);

      // 管身暗纹
      ctx.fillStyle = "rgba(0,0,0,0.07)";
      for (let yy = y + 12; yy < y + h - 6; yy += 26) {
        if (isTop ? yy < y + h - 30 : yy > y + 22) {
          ctx.fillRect(x + 8, yy, w - 16, 1.2);
        }
      }

      // 管口
      const capH = 22;
      const capY = isTop ? y + h - capH : y;
      const cg = ctx.createLinearGradient(x - 5, 0, x + w + 5, 0);
      cg.addColorStop(0, "#357c2c");
      cg.addColorStop(0.2, "#84cf60");
      cg.addColorStop(0.55, "#5db245");
      cg.addColorStop(1, "#2a6323");
      ctx.fillStyle = cg;
      ctx.fillRect(x - 5, capY, w + 10, capH);

      ctx.strokeStyle = "rgba(20,50,18,0.45)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 5 + 0.75, capY + 0.75, w + 10 - 1.5, capH - 1.5);

      // 高光
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.fillRect(x + 6, y + (isTop ? 6 : capH + 4), 5, h - capH - 12);
    }

    _drawFloor(ctx, t) {
      const g = ctx.createLinearGradient(0, FLOOR_Y, 0, H);
      g.addColorStop(0, "#e8d49a");
      g.addColorStop(0.18, "#dcc286");
      g.addColorStop(1, "#b89b62");
      ctx.fillStyle = g;
      ctx.fillRect(0, FLOOR_Y, W, FLOOR_H);

      ctx.fillStyle = "rgba(120,96,50,0.35)";
      ctx.fillRect(0, FLOOR_Y, W, 3);

      // 滚动草纹
      const off = (t * PHYS.pipeSpeed) % 34;
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      for (let x = -off; x < W + 40; x += 34) {
        ctx.beginPath();
        ctx.moveTo(x, FLOOR_Y + 9);
        ctx.lineTo(x + 12, FLOOR_Y + 9);
        ctx.lineTo(x + 6, FLOOR_Y + 16);
        ctx.closePath();
        ctx.fill();
      }
    }

    _drawParticles(ctx, dt) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.age += dt;
        if (p.age >= p.life) {
          this.particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 120 * dt;
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a * 0.8;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (0.6 + a * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    _drawBird(ctx, t) {
      const b = this.bird;
      const wingPhase = Math.sin(t * 18) * 0.5 + 0.5;
      const flap = b.wing;

      ctx.save();
      ctx.translate(BIRD_X, b.y);
      ctx.rotate(b.rot);

      // 影子
      ctx.fillStyle = "rgba(0,0,0,0.08)";
      ctx.beginPath();
      ctx.ellipse(2, 6, 17, 14, 0, 0, Math.PI * 2);
      ctx.fill();

      // 身体
      const bg = ctx.createRadialGradient(-4, -5, 3, 0, 0, 22);
      bg.addColorStop(0, "#ffe382");
      bg.addColorStop(0.6, "#ffcf3d");
      bg.addColorStop(1, "#f2a71b");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.ellipse(0, 0, 18, 15.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(150,90,10,0.35)";
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // 翅膀
      const wingLift = -7 - flap * 8 - wingPhase * 2.2;
      ctx.fillStyle = "#f8b524";
      ctx.beginPath();
      ctx.ellipse(-5, wingLift * 0.35, 11, 6.5, -0.5 - flap * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(150,90,10,0.28)";
      ctx.stroke();

      // 尾羽
      ctx.fillStyle = "#e89a17";
      ctx.beginPath();
      ctx.moveTo(-15, -2);
      ctx.lineTo(-25, -7);
      ctx.lineTo(-23, 1);
      ctx.lineTo(-15, 4);
      ctx.closePath();
      ctx.fill();

      // 眼睛
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(6.5, -5.5, 6.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#20242c";
      ctx.beginPath();
      ctx.arc(8.2, -5.2, 2.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.arc(9.3, -6.3, 1.0, 0, Math.PI * 2);
      ctx.fill();

      // 腮红
      ctx.fillStyle = "rgba(255,120,110,0.35)";
      ctx.beginPath();
      ctx.ellipse(3, 4.5, 4.4, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();

      // 喙
      const bg2 = ctx.createLinearGradient(12, 0, 28, 6);
      bg2.addColorStop(0, "#ff9f2e");
      bg2.addColorStop(1, "#f2721b");
      ctx.fillStyle = bg2;
      ctx.beginPath();
      ctx.moveTo(14, 0.5);
      ctx.quadraticCurveTo(24, 1.5, 26.5, 5.2);
      ctx.quadraticCurveTo(21, 8.6, 13.5, 6.4);
      ctx.closePath();
      ctx.fill();

      // 眨眼瞬间：闭眼效果
      if (b.wing > 0.55) {
        ctx.fillStyle = "#ffd54a";
        ctx.beginPath();
        ctx.ellipse(6.5, -5.5, 6.6, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    _drawHud(ctx) {
      // 分数
      ctx.save();
      ctx.font = "700 34px -apple-system, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(20,44,60,0.55)";
      ctx.fillStyle = "#fff";
      const s = String(this.score);
      ctx.strokeText(s, W / 2, 62);
      ctx.fillText(s, W / 2, 62);

      // 模式角标
      ctx.textAlign = "left";
      ctx.font = "600 11px -apple-system, system-ui, sans-serif";
      const label = MODES[this.mode] || this.mode;
      const wText = ctx.measureText(label).width + 20;
      ctx.fillStyle = "rgba(7,13,22,0.45)";
      this._roundRect(ctx, 12, 12, wText, 22, 11);
      ctx.fill();
      ctx.fillStyle = "rgba(235,245,255,0.92)";
      ctx.fillText(label, 22, 27);

      // 延迟补偿指示
      if (this.mode === "hold" && this._holdActive) {
        ctx.fillStyle = "rgba(76,224,179,0.85)";
        this._roundRect(ctx, 12, 40, 74, 20, 10);
        ctx.fill();
        ctx.fillStyle = "#062018";
        ctx.fillText("闭眼升力", 22, 54);
      }
      ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, h / 2, w / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    destroy() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  BB.Game = Game;
  BB.GAME_MODES = MODES;
  BB.GAME_CONST = { W, H, FLOOR_Y, BIRD_X, BIRD_R, PHYS, PHYS_DEFAULT };
})(typeof window !== "undefined" ? window : globalThis);
