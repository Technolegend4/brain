/* ============================================================
   filter.js — 流式 IIR 滤波器（RBJ Audio EQ Cookbook 双二阶）
   全部为因果实现，逐样本处理，无未来数据，适合实时链路。
   ============================================================ */
(function (root) {
  "use strict";

  const BB = (root.BB = root.BB || {});

  /**
   * 单个双二阶（biquad）节，Transposed Direct Form II。
   * 系数按 RBJ 公式在构造时算好，采样率变化需重建。
   */
  class Biquad {
    constructor(type, fs, f0, Q = Math.SQRT1_2, gainDb = 0) {
      this.type = type;
      this.fs = fs;
      this.f0 = f0;
      this.Q = Q;
      this.gainDb = gainDb;
      this.z1 = 0;
      this.z2 = 0;
      this._design();
    }

    _design() {
      const fs = this.fs;
      const f0 = Math.min(this.f0, fs * 0.49);
      const w0 = (2 * Math.PI * f0) / fs;
      const cos = Math.cos(w0);
      const sin = Math.sin(w0);
      const alpha = sin / (2 * this.Q);

      let b0, b1, b2, a0, a1, a2;

      switch (this.type) {
        case "lowpass":
          b0 = (1 - cos) / 2;
          b1 = 1 - cos;
          b2 = (1 - cos) / 2;
          a0 = 1 + alpha;
          a1 = -2 * cos;
          a2 = 1 - alpha;
          break;

        case "highpass":
          b0 = (1 + cos) / 2;
          b1 = -(1 + cos);
          b2 = (1 + cos) / 2;
          a0 = 1 + alpha;
          a1 = -2 * cos;
          a2 = 1 - alpha;
          break;

        case "bandpass":
          // 恒定峰值增益
          b0 = alpha;
          b1 = 0;
          b2 = -alpha;
          a0 = 1 + alpha;
          a1 = -2 * cos;
          a2 = 1 - alpha;
          break;

        case "notch":
          b0 = 1;
          b1 = -2 * cos;
          b2 = 1;
          a0 = 1 + alpha;
          a1 = -2 * cos;
          a2 = 1 - alpha;
          break;

        case "peak": {
          const A = Math.pow(10, this.gainDb / 40);
          b0 = 1 + alpha * A;
          b1 = -2 * cos;
          b2 = 1 - alpha * A;
          a0 = 1 + alpha / A;
          a1 = -2 * cos;
          a2 = 1 - alpha / A;
          break;
        }

        default:
          throw new Error("未知滤波器类型: " + this.type);
      }

      this.b0 = b0 / a0;
      this.b1 = b1 / a0;
      this.b2 = b2 / a0;
      this.a1 = a1 / a0;
      this.a2 = a2 / a0;
    }

    /** 处理单个样本 */
    step(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }

    reset() {
      this.z1 = 0;
      this.z2 = 0;
    }
  }

  /**
   * 因果滤波链：陷波 → 高通 → 低通（可选二阶级联）。
   * stages 顺序执行，便于按需插入/移除。
   */
  class FilterChain {
    constructor(fs, opts = {}) {
      this.fs = fs;
      this.stages = [];
      this.enabled = opts.enabled !== false;
      this.build(opts);
    }

    build(opts = {}) {
      const fs = this.fs;
      const {
        notchHz = 50,
        notchQ = 30,
        highpassHz = 0.5,
        lowpassHz = 8,
        order = 2, // 2 或 4（4 = 两阶级联，更陡）
        notchOn = true,
      } = opts;

      this.stages = [];
      const stages = this.stages;

      if (notchOn && notchHz > 0 && notchHz < fs / 2) {
        stages.push(new Biquad("notch", fs, notchHz, notchQ));
        // 50 Hz 的二次谐波在 250 Hz 采样下是 100 Hz（恰在奈奎斯特），不做
      }
      const sections = order >= 4 ? 2 : 1;
      for (let i = 0; i < sections; i++) {
        stages.push(new Biquad("highpass", fs, highpassHz, 0.5412)); // Butterworth 2 阶
      }
      for (let i = 0; i < sections; i++) {
        stages.push(new Biquad("lowpass", fs, lowpassHz, 1.3066)); // 与 HP 组成 4 阶
      }
      this.reset();
      return this;
    }

    /** 设置采样率后必须重建系数 */
    setSampleRate(fs) {
      if (Math.abs(fs - this.fs) < 1e-9) return this;
      this.fs = fs;
      return this.build(this.lastOpts || {});
    }

    step(x) {
      if (!this.enabled) return x;
      let y = x;
      const st = this.stages;
      for (let i = 0; i < st.length; i++) y = st[i].step(y);
      return y;
    }

    /** 批量处理（就地返回新数组） */
    process(arr) {
      const out = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = this.step(arr[i]);
      return out;
    }

    reset() {
      for (const s of this.stages) s.reset();
      return this;
    }
  }

  /* ---------------- 重采样 ---------------- */

  /**
   * 线性插值重采样到目标采样率。
   * 用于把 220/500 Hz 等设备数据统一到内部 250 Hz。
   * 返回 { data, fs }。
   */
  function resampleLinear(data, fsIn, fsOut) {
    if (Math.abs(fsIn - fsOut) < 1e-9 || data.length < 2) {
      return { data: Float64Array.from(data), fs: fsIn };
    }
    const ratio = fsIn / fsOut;
    const nOut = Math.max(2, Math.floor((data.length - 1) / ratio) + 1);
    const out = new Float64Array(nOut);
    for (let i = 0; i < nOut; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, data.length - 1);
      const frac = pos - i0;
      out[i] = data[i0] + (data[i1] - data[i0]) * frac;
    }
    return { data: out, fs: fsOut };
  }

  /* ---------------- 频响（仅用于自检/绘图） ---------------- */

  /** 计算 biquad 在归一化频率 f/fs 处的幅度响应 */
  function biquadResponse(bq, freq, fs) {
    const w = (2 * Math.PI * freq) / fs;
    const cosw = Math.cos(w);
    const sinw = Math.sin(w);
    const cos2w = Math.cos(2 * w);
    const sin2w = Math.sin(2 * w);

    const numRe = bq.b0 + bq.b1 * cosw + bq.b2 * cos2w;
    const numIm = -(bq.b1 * sinw + bq.b2 * sin2w);
    const denRe = 1 + bq.a1 * cosw + bq.a2 * cos2w;
    const denIm = -(bq.a1 * sinw + bq.a2 * sin2w);

    const num = Math.hypot(numRe, numIm);
    const den = Math.hypot(denRe, denIm) || 1e-12;
    return num / den;
  }

  BB.filter = { Biquad, FilterChain, resampleLinear, biquadResponse };
})(typeof window !== "undefined" ? window : globalThis);
