/* ============================================================
   detector.js — 实时（因果）眨眼检测器
   ------------------------------------------------------------
   链路：原始两通道 → 陷波/带通 → 滑动稳健基线 → z 分数
        → 双通道同向合成 → 双阈值状态机 → 事件

   与离线版本的区别：
     * 只用过去的数据（因果滤波 + 在线基线），满足实时要求
     * 双阈值（hysteresis）避免噪声反复穿越阈值
     * 输出 onset（上升沿）事件，延迟约 40~120 ms；
       峰值确认事件稍晚，用于记录强度
     * 自动判定眨眼极性（不同设备参考电极方向不同）
   ============================================================ */
(function (root) {
  "use strict";

  const BB = (root.BB = root.BB || {});
  const U = BB.util;

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  const DEFAULTS = {
    fs: 250,
    threshold: 3.4, // 触发阈值（z 分数）：真实数据 F1 最优区间 3.4~3.6
    hysteresis: 0.45, // 回落比例：低于 threshold*ratio 才算结束
    // onset 确认窗（样本数）。1 = 一超阈就报（延迟最低但易被单点噪声骗）。
    // 3 个样本 @250 Hz = 12 ms，延迟代价可忽略，能挡掉大部分单点尖峰
    onsetConfirm: 3,
    // onset 触发要求的峰值倍数：真眨眼峰值远高于阈值，
    // 擦着阈值过的短促眼动/肌电不应触发游戏
    onsetBoost: 1.10,
    refractoryMs: 300, // 不应期：标签里 98% 的相邻眨眼间隔 > 0.4 s，300 ms 足够且更抗连眨漏检
    baselineSec: 1.5, // 基线窗口
    baselineHopMs: 100, // 基线更新步长
    minDurMs: 60,
    maxDurMs: 700,
    band: [0.5, 8.0],
    notchHz: 50,
    notchOn: true,
    order: 2,
    autoPolarity: true,
    // 极性自纠：超过这么久没有正向事件、却连续出现反向强峰，就翻转极性
    polarityFlipAfterMs: 20000,
    warmupMs: 1200, // 滤波器收敛期，期间只更新基线、不产生事件
  };

  class BlinkDetector extends U.Emitter {
    constructor(opts = {}) {
      super();
      this.o = Object.assign({}, DEFAULTS, opts);
      this.fs = this.o.fs;
      this.reset();
    }

    reset() {
      const o = this.o;
      const fs = (this.fs = o.fs);

      this.chains = [0, 1].map(
        (i) =>
          new BB.filter.FilterChain(fs, {
            notchHz: o.notchHz,
            notchOn: o.notchOn,
            highpassHz: o.band[0],
            lowpassHz: o.band[1],
            order: o.order,
          })
      );

      const win = Math.max(32, Math.round(o.baselineSec * fs));
      this.base = [new U.Ring(win), new U.Ring(win)];
      this.hop = Math.max(1, Math.round((o.baselineHopMs / 1000) * fs));
      this.hopCount = 0;

      this.stat = [
        { median: 0, sigma: 1 },
        { median: 0, sigma: 1 },
      ];
      this.baseReady = false;
      this.baseSamples = 0;

      // 极性：+1 / -1 / 0(未定)
      this.polarity = 0;
      this.polarityVotes = { pos: 0, neg: 0 };
      this.seenEvents = 0;
      // 极性自纠（电极接反时不必手动重连）
      this.confirmN = 0;
      this.pendingOnset = null;
      this.revArmed = false;
      this.revPeak = 0;
      this.revStartT = -1e9;
      this.posPeaks = []; // 正向事件强度（最近 20 个）
      this.negPeaks = []; // 反向候选峰强度（最近 20 个）
      this.polarityFlippedAt = -1e9;

      // 状态机
      this.state = "idle";
      this.onsetIdx = -1;
      this.onsetT = 0;
      this.peakIdx = -1;
      this.peakS = 0;
      this.peakT = 0;
      this.sinceOnset = 0;
      this.lastEventT = -1e9;
      this.lastEventEndT = -1e9;
      this.t0 = -1;
      this.warmedUp = false;

      // 计数
      this.nSamples = 0;
      this.nBlinks = 0;
      this.eventTimes = [];

      // 最近一次输出（供 UI 绘制）
      this.lastZ = [0, 0];
      this.lastScore = 0;
      this.lastOnsetT = -1e9;

      this.calib = null;
    }

    setSampleRate(fs) {
      if (Math.abs(fs - this.fs) < 1e-9) return;
      this.fs = fs;
      // 同步到 o.fs：reset() 会用 o.fs 重建滤波器链，
      // 不同步的话"先 reset 再 setSampleRate"的路径会把采样率退回旧值
      this.o.fs = fs;
      for (const c of this.chains) {
        c.fs = fs;
        c.build({ ...this.o, highpassHz: this.o.band[0], lowpassHz: this.o.band[1] });
      }
      const win = Math.max(32, Math.round(this.o.baselineSec * fs));
      for (let i = 0; i < 2; i++) {
        this.base[i] = new U.Ring(win);
      }
      this.hop = Math.max(1, Math.round((this.o.baselineHopMs / 1000) * fs));
      this.hopCount = 0;
      this.baseReady = false;
      this.baseSamples = 0;
    }

    /* ---------------- 主入口 ---------------- */

    /**
     * 推入一个双通道样本。
     * @param {number} x0 通道 1（如 Fp1）
     * @param {number} x1 通道 2（如 Fp2）
     * @param {number} tMs 该样本的时间戳（毫秒，单调递增）
     * @returns {object|null} 本次产生的调试信息
     */
    push(x0, x1, tMs) {
      const o = this.o;
      const fs = this.fs;

      if (!Number.isFinite(x0)) x0 = this.base[0].last || 0;
      if (!Number.isFinite(x1)) x1 = this.base[1].last || 0;

      const y0 = this.chains[0].step(x0);
      const y1 = this.chains[1].step(x1);

      this.base[0].push(y0);
      this.base[1].push(y1);
      this.nSamples++;

      // 基线：每 hop 个样本更新一次（排序成本摊薄）
      if (++this.hopCount >= this.hop || !this.baseReady) {
        this.hopCount = 0;
        this._updateBaseline();
      }

      const z0 = this._z(0, y0);
      const z1 = this._z(1, y1);
      this.lastZ[0] = z0;
      this.lastZ[1] = z1;

      const s = this._compose(z0, z1);
      this.lastScore = s;

      if (this.t0 < 0) this.t0 = tMs;
      if (!this.warmedUp && tMs - this.t0 < this.o.warmupMs) {
        // 收敛期：不触发事件，但基线继续学习
        return s;
      }
      this.warmedUp = true;

      this._stateMachine(s, tMs);
      // 极性自纠必须独立于状态机：接反时负向段会伴随滤波振铃产生的正向
      // onset，状态机一路被占用，永远走不到"回落"那一步
      if (this.polarity !== 0) this._trackReverse(s, this.o.threshold, tMs);

      return s;
    }

    _updateBaseline() {
      if (this.base[0].size < Math.min(48, this.base[0].cap * 0.5)) return;
      for (let i = 0; i < 2; i++) {
        const st = U.robustStats(this.base[i].toArray());
        this.stat[i] = {
          median: st.median,
          sigma: Math.max(st.sigma, 1e-6),
        };
      }
      this.baseReady = true;
    }

    _z(i, y) {
      const st = this.stat[i];
      return (y - st.median) / st.sigma;
    }

    /**
     * 双通道合成：
     *   极性已知 → 取两通道同向后较小者（要求两边都出现偏转，抗单侧伪迹）
     *   极性未知 → 取两通道同号的绝对幅值较小者，同时累计符号投票
     */
    _compose(z0, z1) {
      if (this.polarity !== 0) {
        const a = z0 * this.polarity;
        const b = z1 * this.polarity;
        return Math.min(a, b);
      }
      // 未定极性
      if (Math.sign(z0) !== Math.sign(z1) || z0 === 0 || z1 === 0) {
        return 0; // 反号视为非眨眼（肌电/单侧伪迹）
      }
      const mag = Math.min(Math.abs(z0), Math.abs(z1));
      return z0 < 0 ? -mag : mag;
    }

    /* ---------------- 状态机 ---------------- */

    _stateMachine(s, tMs) {
      const o = this.o;
      const th = o.threshold;
      const low = th * o.hysteresis;

      if (this.state === "idle") {
        if (s > th) {
          // 极短确认窗：连续 N 个样本都超阈才算真上升沿。
          // 单点噪声尖峰会在下一个样本掉回去，直接作废。
          this.confirmN++;
          if (this.confirmN < o.onsetConfirm) return;

          // 上升沿：立刻进入 active（跟踪与统计不受影响），
          // 但 onset 事件推迟 onsetConfirm 个样本再发：
          // 单点噪声尖峰会在下一采样掉出滞回带，事件就不发了。
          this.state = "active";
          this.onsetIdx = this.nSamples;
          this.onsetT = tMs;
          this.peakIdx = this.nSamples;
          this.peakS = s;
          this.peakT = tMs;
          this.sinceOnset = 0;
          if (o.onsetConfirm <= 1) {
            this.lastOnsetT = tMs;
            this.emit("onset", { t: tMs, score: s, lag: 0 });
          } else {
            this.pendingOnset = { t: tMs, s: s, n: 0 };
          }
        } else {
          if (s < -th && this.polarity === 0) {
            // 反向候选：暂不触发，只记录极性证据
            this._vote(-1, Math.abs(s));
          }
        }
        return;
      }

      // active 状态
      if (this.pendingOnset) {
        if (s > low) {
          this.pendingOnset.n++;
          if (this.pendingOnset.n >= o.onsetConfirm) {
            const strong = this.peakS >= th * o.onsetBoost;
            if (strong) {
              this.lastOnsetT = this.pendingOnset.t;
              this.emit("onset", {
                t: this.pendingOnset.t,
                score: this.pendingOnset.s,
                // 毫秒（main.js 是当作 ms 加到延迟统计里的）
                lag: (this.pendingOnset.n / this.fs) * 1000,
              });
            }
            this.pendingOnset = null;
          }
        } else {
          // 假上升沿：吞掉 onset，但 blink 仍继续跟踪
          this.pendingOnset = null;
        }
      }

      this.sinceOnset = tMs - this.onsetT;

      if (s > this.peakS) {
        this.peakS = s;
        this.peakIdx = this.nSamples;
        this.peakT = tMs;
      }

      const tooLong = this.sinceOnset > o.maxDurMs;
      const fell = s < low;

      if (fell || tooLong) {
        const dur = this.sinceOnset;
        if (dur < o.minDurMs) {
          // 太短：噪声尖峰，丢弃
          this.state = "idle";
          return;
        }
        const refractoryOk = tMs - this.lastEventEndT >= o.refractoryMs;
        if (refractoryOk) {
          this.nBlinks++;
          this.eventTimes.push(this.peakT);
          this.lastEventT = this.peakT;
          this.lastEventEndT = tMs;
          if (this.polarity === 0) this._vote(Math.sign(this.peakS), this.peakS);
          if (this.polarity !== 0) {
            this.posPeaks.push(this.peakS);
            if (this.posPeaks.length > 20) this.posPeaks.shift();
          }
          this.emit("blink", {
            t: this.onsetT,
            tPeak: this.peakT,
            score: this.peakS,
            durMs: dur,
            polarity: this.polarity,
          });
        }
        this.state = "idle";
      }
    }

    /**
     * 极性自纠。
     * 场景：电极接反（或参考方式不同），某次误判把极性定成反的，
     * 之后真实眨眼全落在"反向"一侧。
     *
     * 不能只用"长时间没事件"判断：带通滤波器对负向脉冲会产生正向振铃，
     * 振铃足以越过阈值被当成"正向眨眼"，于是永远等不到"没事件"。
     * 所以改用强度对比：反向候选峰持续比正向事件强两倍以上 → 极性反了。
     */
    _trackReverse(s, th, tMs) {
      const r = s * this.polarity; // 归一化：正 = 当前认定的眨眼方向
      const low = th * this.o.hysteresis;

      if (!this.revArmed) {
        if (r < -th) {
          this.revArmed = true;
          this.revPeak = r;
          this.revStartT = tMs;
        }
        return;
      }

      if (r < this.revPeak) this.revPeak = r;

      // 回落到滞回带以内 → 一次反向候选峰结束
      if (r > -low) {
        const dur = tMs - this.revStartT;
        this.revArmed = false;
        if (dur < this.o.minDurMs) return;
        if (-this.revPeak <= th * 1.15) return;

        this.negPeaks.push(-this.revPeak);
        if (this.negPeaks.length > 20) this.negPeaks.shift();
        this._maybeFlipPolarity(tMs);
      }
    }

    _maybeFlipPolarity(tMs) {
      // 翻转后 30 s 冷静期，避免来回抖
      if (tMs - this.polarityFlippedAt < 30000) return;
      if (this.negPeaks.length < 3) return;

      const medNeg = median(this.negPeaks);
      const medPos = this.posPeaks.length ? median(this.posPeaks) : 0;

      // 反向峰比"正向事件"强一倍以上：这些正向事件其实是振铃，极性反了
      if (medPos > 0 && medNeg <= medPos * 2) return;

      this.polarity *= -1;
      this.polarityVotes = { pos: 0, neg: 0 };
      this.posPeaks = [];
      this.negPeaks = [];
      this.lastEventT = tMs;
      this.lastEventEndT = tMs;
      this.polarityFlippedAt = tMs;
      this.emit("polarity", this.polarity);
      this.emit("polarityFlip", { polarity: this.polarity, at: tMs });
    }

    _vote(sign, mag) {
      if (!this.o.autoPolarity) return;
      if (sign > 0) this.polarityVotes.pos += mag;
      else this.polarityVotes.neg += mag;
      const { pos, neg } = this.polarityVotes;
      const total = pos + neg;
      const minEvidence = 6; // 至少累积少量证据再定极性
      if (total > minEvidence && Math.abs(pos - neg) / total > 0.55) {
        this.polarity = pos > neg ? 1 : -1;
        this.emit("polarity", this.polarity);
      }
    }

    /* ---------------- 辅助 ---------------- */

    /** 当前眨眼率（次/分钟），基于最近 windowSec 内的事件 */
    ratePerMin(windowSec = 30) {
      const t = this.lastOnsetT;
      if (this.eventTimes.length < 2) return 0;
      const from = t - windowSec * 1000;
      let n = 0;
      for (let i = this.eventTimes.length - 1; i >= 0; i--) {
        if (this.eventTimes[i] < from) break;
        n++;
      }
      const span = Math.min(windowSec, (t - this.eventTimes[0]) / 1000) || 1;
      return (n / span) * 60;
    }

    isActive() {
      return this.state === "active";
    }

    /** 当前是否处于不应期 */
    inRefractory(tMs) {
      return tMs - this.lastEventT < this.o.refractoryMs;
    }

    get threshold() {
      return this.o.threshold;
    }
    set threshold(v) {
      this.o.threshold = U.clamp(v, 0.8, 12);
    }
  }

  BB.BlinkDetector = BlinkDetector;
  BB.DETECTOR_DEFAULTS = DEFAULTS;
})(typeof window !== "undefined" ? window : globalThis);
