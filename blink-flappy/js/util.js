/* ============================================================
   util.js — 基础工具：环形缓冲、稳健统计、DOM、日志
   ============================================================ */
(function (root) {
  "use strict";

  const BB = (root.BB = root.BB || {});

  /* ---------------- 数学 ---------------- */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const nowMs = () => performance.now();

  /** 线性插值：在有序列 (x0,y0)-(x1,y1) 上取 x 处的值 */
  function lerpAt(x0, y0, x1, y1, x) {
    if (x1 === x0) return y0;
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }

  /* ---------------- 环形缓冲 ---------------- */

  /**
   * 定长环形缓冲。满时覆盖最旧元素。
   * push/pop 都是 O(1)，用于实时波形与检测历史。
   */
  class Ring {
    constructor(capacity) {
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new Error("Ring capacity 必须是正整数");
      }
      this.cap = capacity;
      this.buf = new Float64Array(capacity);
      this.start = 0; // 最旧元素下标
      this.size = 0;
    }

    push(v) {
      const idx = (this.start + this.size) % this.cap;
      this.buf[idx] = v;
      if (this.size < this.cap) {
        this.size++;
      } else {
        this.start = (this.start + 1) % this.cap;
      }
    }

    get(i) {
      // i: 0 = 最旧
      return this.buf[(this.start + i) % this.cap];
    }

    get last() {
      return this.size ? this.get(this.size - 1) : 0;
    }

    at(offsetFromEnd) {
      // 1 = 最后一个
      const i = this.size - offsetFromEnd;
      return i < 0 ? NaN : this.get(i);
    }

    clear() {
      this.start = 0;
      this.size = 0;
    }

    /** 拷贝成普通数组（最旧→最新） */
    toArray() {
      const out = new Array(this.size);
      for (let i = 0; i < this.size; i++) out[i] = this.get(i);
      return out;
    }

    /** 最近 n 个元素，返回 Float64Array（最旧→最新） */
    tail(n) {
      const k = Math.min(n, this.size);
      const out = new Float64Array(k);
      for (let i = 0; i < k; i++) out[i] = this.get(this.size - k + i);
      return out;
    }
  }

  /* ---------------- 稳健统计 ---------------- */

  /** 原地快速排序（数值） */
  function sortInPlace(arr) {
    // 双轴快排过重，这里用三路快排避免退化
    quickSort(arr, 0, arr.length - 1);
    return arr;
  }

  function quickSort(a, lo, hi) {
    while (lo < hi) {
      // 小区间插入排序
      if (hi - lo < 16) {
        for (let i = lo + 1; i <= hi; i++) {
          const v = a[i];
          let j = i - 1;
          while (j >= lo && a[j] > v) {
            a[j + 1] = a[j];
            j--;
          }
          a[j + 1] = v;
        }
        return;
      }
      const mid = (lo + hi) >> 1;
      const pivot = median3(a[lo], a[mid], a[hi]);
      let lt = lo;
      let gt = hi;
      let i = lo;
      while (i <= gt) {
        if (a[i] < pivot) swap(a, lt++, i++);
        else if (a[i] > pivot) swap(a, i, gt--);
        else i++;
      }
      if (lt - lo < hi - gt) {
        quickSort(a, lo, lt - 1);
        lo = gt + 1;
      } else {
        quickSort(a, gt + 1, hi);
        hi = lt - 1;
      }
    }
  }

  function swap(a, i, j) {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }

  function median3(a, b, c) {
    return a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const a = Float64Array.from(arr);
    sortInPlace(a);
    const n = a.length;
    return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }

  /** 中位数 + 稳健标准差（1.4826 * MAD） */
  function robustStats(arr) {
    if (!arr.length) return { median: 0, sigma: 1e-9 };
    const n = arr.length;
    const a = Float64Array.from(arr);
    sortInPlace(a);
    const med = n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = Math.abs(a[i] - med);
    sortInPlace(d);
    const mad = n % 2 ? d[(n - 1) >> 1] : 0.5 * (d[n / 2 - 1] + d[n / 2]);
    return { median: med, sigma: 1.4826 * mad + 1e-9 };
  }

  /** 指数滑动平均 */
  class Ema {
    constructor(alpha) {
      this.a = alpha;
      this.v = null;
    }
    push(x) {
      this.v = this.v === null ? x : this.v + this.a * (x - this.v);
      return this.v;
    }
    reset() {
      this.v = null;
    }
  }

  /* ---------------- 事件 ---------------- */

  class Emitter {
    constructor() {
      this._h = new Map();
    }
    on(name, fn) {
      if (!this._h.has(name)) this._h.set(name, new Set());
      this._h.get(name).add(fn);
      return () => this.off(name, fn);
    }
    off(name, fn) {
      const s = this._h.get(name);
      if (s) s.delete(fn);
    }
    emit(name, payload) {
      const s = this._h.get(name);
      if (!s) return;
      for (const fn of Array.from(s)) {
        try {
          fn(payload);
        } catch (e) {
          console.error("[emitter]", name, e);
        }
      }
    }
    clear() {
      this._h.clear();
    }
  }

  /* ---------------- DOM / 格式化 ---------------- */

  const $ = (id) => document.getElementById(id);

  function fmt(v, digits = 1) {
    return Number.isFinite(v) ? v.toFixed(digits) : "—";
  }

  /** 把秒格式化成 mm:ss.s */
  function fmtClock(sec) {
    if (!Number.isFinite(sec)) return "—";
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m > 0 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : s.toFixed(1);
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  BB.util = {
    clamp,
    lerp,
    lerpAt,
    nowMs,
    Ring,
    median,
    robustStats,
    sortInPlace,
    Ema,
    Emitter,
    $,
    fmt,
    fmtClock,
    downloadJSON,
  };
})(typeof window !== "undefined" ? window : globalThis);
