/* ============================================================
   synth.js — 合成 EEG 信号源（无硬件也能完整跑通闭环）
   ------------------------------------------------------------
   生成的信号刻意做得"不干净"，用来验证检测器的鲁棒性：
     * 1/f 背景脑电
     * 缓慢基线漂移
     * 50 Hz 工频 + 谐波泄漏
     * 随机肌电（EMG）短突发
     * 双指数眨眼模板（真实眨眼在前额电极上的典型形态）
   ============================================================ */
(function (root) {
  "use strict";

  const BB = (root.BB = root.BB || {});
  const U = BB.util;

  /** 可复现伪随机数（mulberry32）。仅在显式传 seed 时启用，便于自检复现。 */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 简单的一阶低通白噪声，用来堆出 1/f 背景 */
  class Pinkish {
    constructor(fs, poles = 4, rand = Math.random) {
      this.fs = fs;
      this.rand = rand;
      this.poles = poles;
      this.state = new Float64Array(poles);
      this.gains = new Float64Array(poles);
      for (let i = 0; i < poles; i++) {
        this.gains[i] = 1 / (i + 1);
      }
      this.norm = 0;
      this._renorm();
    }
    _renorm() {
      let s = 0;
      for (let i = 0; i < this.poles; i++) s += this.gains[i] * this.gains[i];
      this.norm = Math.sqrt(s) || 1;
    }
    step() {
      const white = (this.rand() * 2 - 1) * Math.sqrt(3);
      let out = 0;
      for (let i = 0; i < this.poles; i++) {
        // 时间常数随极点数增大
        const a = 1 - Math.exp(-1 / (this.fs * (0.02 * Math.pow(2, i))));
        this.state[i] += a * (white - this.state[i]);
        out += this.state[i] * this.gains[i];
      }
      return out / this.norm;
    }
  }

  /**
   * 眨眼模板：双指数上升/衰减 + 轻微负向回弹。
   * 返回 0..1 的归一化幅度。
   */
  function blinkShape(tRel, tauRise = 0.035, tauDecay = 0.11) {
    if (tRel < 0) return 0;
    const rise = 1 - Math.exp(-tRel / tauRise);
    const decay = Math.exp(-tRel / tauDecay);
    let v = rise * decay;
    // 归一化到峰值 1
    const tp = tauRise * Math.log(1 + tauDecay / tauRise);
    const peak = (1 - Math.exp(-tp / tauRise)) * Math.exp(-tp / tauDecay);
    v /= peak || 1;
    // 尾部轻微反相（恢复期）
    if (tRel > 0.25) {
      v -= 0.12 * Math.exp(-(tRel - 0.25) / 0.12);
    }
    return v;
  }

  const BLINK_TYPES = {
    normal: { amp: 320, dur: 1.0, tauDecay: 0.11, weight: 6 },
    soft: { amp: 150, dur: 0.85, tauDecay: 0.09, weight: 2 },
    strong: { amp: 620, dur: 1.2, tauDecay: 0.14, weight: 2 },
    double: { amp: 380, dur: 1.0, tauDecay: 0.10, weight: 1 },
  };

  class BlinkSynth {
    constructor(opts = {}) {
      this.fs = opts.fs || 250;
      this.driftMuV = opts.drift ?? 260; // 缓慢漂移幅度
      this.noiseMuV = opts.noise ?? 26; // 背景 EEG 幅度
      this.lineMuV = opts.line ?? 9; // 工频幅度
      this.emgRate = opts.emgRate ?? 0.06; // 每秒肌电突发概率
      this.seed = opts.seed;
      // 显式传 seed 时启用可复现随机；否则保持自然随机（页面里每次不同）
      this.rand = typeof opts.seed === "number" ? mulberry32(opts.seed) : Math.random;

      this.n = 0;
      this.t = 0;

      this.pinkA = new Pinkish(this.fs, 4, this.rand);
      this.pinkB = new Pinkish(this.fs, 3, this.rand);

      // 漂移用两个很慢的正弦 + 随机游走
      this.driftPhase = this.rand() * Math.PI * 2;
      this.driftPhase2 = this.rand() * Math.PI * 2;

      // 活动眨眼队列
      this.blinks = [];
      this.nextAutoAt = this._expDelay(opts.meanInterval ?? 3.2);

      // 肌电突发
      this.emg = 0;
      this.emgDecay = 0;

      // 两通道的微小差异（增益/相位）
      this.gain = [1.0, 0.92];
      this.offset = [0, 0];
      this.polarity = opts.polarity ?? -1; // 前额眨眼通常为负向偏转（以本模板为准）

      // 真实眨眼时刻（供离线自检/评估使用）
      this.spawned = [];
      this.onSpawn = opts.onSpawn || null;
      this.maxLog = opts.maxLog || 4000;
    }

    _expDelay(meanSec) {
      return this.t + -Math.log(1 - this.rand()) * meanSec;
    }

    setSampleRate(fs) {
      if (Math.abs(fs - this.fs) < 1e-9) return;
      this.fs = fs;
      this.pinkA = new Pinkish(fs, 4, this.rand);
      this.pinkB = new Pinkish(fs, 3, this.rand);
    }

    /** 手动触发一次眨眼（模拟用户眨眼 / 按键注入） */
    trigger(kind = "normal", ampScale = 1) {
      const spec = BLINK_TYPES[kind] || BLINK_TYPES.normal;
      const amp = spec.amp * ampScale * (0.85 + this.rand() * 0.3);
      const rec = {
        t0: this.t + 0.01,
        amp,
        tauDecay: spec.tauDecay,
        tauRise: 0.03 + this.rand() * 0.02,
        kind,
      };
      this.blinks.push(rec);
      if (this.spawned.length < this.maxLog) this.spawned.push(rec);
      if (this.onSpawn) this.onSpawn(rec);
      if (kind === "double") {
        this.blinks.push({
          t0: this.t + 0.34,
          amp: amp * 0.8,
          tauDecay: spec.tauDecay,
          tauRise: 0.035,
        });
      }
      return rec;
    }

    /** 随机自然眨眼 */
    _autoBlink() {
      const r = this.rand() * 11;
      let kind = "normal";
      if (r < 2) kind = "soft";
      else if (r < 4) kind = "strong";
      else if (r < 5) kind = "double";
      this.trigger(kind);
    }

    /** 生成下一个双通道样本 */
    step() {
      const fs = this.fs;
      const dt = 1 / fs;
      this.t += dt;
      this.n++;

      // ---- 自动眨眼 ----
      if (this.t >= this.nextAutoAt) {
        this._autoBlink();
        this.nextAutoAt = this._expDelay(3.2);
      }

      // ---- 背景 ----
      const drift =
        this.driftMuV * 0.55 * Math.sin(2 * Math.PI * 0.055 * this.t + this.driftPhase) +
        this.driftMuV * 0.3 * Math.sin(2 * Math.PI * 0.013 * this.t + this.driftPhase2);

      const pink0 = this.pinkA.step() * this.noiseMuV;
      const pink1 = this.pinkB.step() * this.noiseMuV;

      // 工频（两通道同相，幅度略不同）
      const line = this.lineMuV * Math.sin(2 * Math.PI * 50 * this.t);

      // ---- 眨眼 ----
      let blink0 = 0;
      let blink1 = 0;
      for (let i = this.blinks.length - 1; i >= 0; i--) {
        const b = this.blinks[i];
        const rel = this.t - b.t0;
        if (rel < 0) continue;
        if (rel > 1.2) {
          this.blinks.splice(i, 1);
          continue;
        }
        const v = blinkShape(rel, b.tauRise, b.tauDecay) * b.amp * this.polarity;
        blink0 += v;
        blink1 += v * 0.94; // 另一通道略小
      }

      // ---- 肌电突发 ----
      if (this.rand() < this.emgRate * dt) {
        this.emg = 1;
        this.emgDecay = 0.05 + this.rand() * 0.12;
      }
      let emgVal = 0;
      if (this.emg > 0) {
        emgVal = (this.rand() * 2 - 1) * 45 * this.emg;
        this.emg -= dt / this.emgDecay;
        if (this.emg < 0) this.emg = 0;
      }

      const x0 = drift + pink0 + line + blink0 + emgVal + this.offset[0];
      const x1 = drift * 0.97 + pink1 + line * 0.85 + blink1 + emgVal * 0.8 + this.offset[1];

      return { x0, x1, t: this.t * 1000 };
    }
  }

  BB.BlinkSynth = BlinkSynth;
  BB.blinkShape = blinkShape;
})(typeof window !== "undefined" ? window : globalThis);
