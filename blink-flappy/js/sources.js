/* ============================================================
   sources.js — 数据源
   ------------------------------------------------------------
   四类数据源，统一成两种输出：
     raw   : {x0, x1, t}  逐样本（需要经过检测器）
     event : {t, score}   已检测好的眨眼事件（跳过检测）

   1) SimSource    合成 EEG，零硬件可玩
   2) CsvSource    回放本地 EEG CSV（支持数据集两种格式）
   3) SerialSource Web Serial 连接 OpenBCI Cyton
   4) WsSource     连接 Python 桥接器（离线检测 + 回放）
   ============================================================ */
(function (root) {
  "use strict";

  const BB = (root.BB = root.BB || {});
  const U = BB.util;

  const BASE_FS = 250;

  /* ============================================================
     CSV 解析
     ============================================================ */

  /**
   * 解析 EEG CSV，自动适配：
   *   A. 分号表头格式（EEG-EyeBlinks/EEG-IO）：
   *      Time (s);FP1;FP2;...;Sampling Rate
   *   B. OpenBCI 原始格式（EEG-VR / EEG-VV）：
   *      前 5 行 % 注释，逗号分隔，第 0 列采样序号
   *   C. 通用两列/多列：第 0 列时间或序号，其后为电压
   *
   * @returns {{ch0:Float64Array, ch1:Float64Array, t:Float64Array, fs:number,
   *            format:string, channels:string[]}}
   */
  function _csvHead(text) {
    if (!text || !text.length) throw new Error("CSV 内容为空");

    const allLines = text.split(/\r?\n/);
    const comments = [];
    let idx = 0;

    // 跳过开头的注释/空行，收集 % 元信息
    while (idx < allLines.length) {
      const ln = allLines[idx];
      if (!ln || !ln.trim()) {
        idx++;
        continue;
      }
      if (ln.trim().startsWith("%") || ln.trim().startsWith("#")) {
        comments.push(ln.trim());
        idx++;
        continue;
      }
      break;
    }
    if (idx >= allLines.length) throw new Error("没有找到数据行");

    const headerLine = allLines[idx];
    const hasTextHeader = /[a-zA-Z\u4e00-\u9fa5]/.test(headerLine.replace(/e[+-]?\d+/gi, ""));

    // 分隔符判定
    const semi = (headerLine.match(/;/g) || []).length;
    const comma = (headerLine.match(/,/g) || []).length;
    const tab = (headerLine.match(/\t/g) || []).length;
    const sep = tab > Math.max(semi, comma) ? "\t" : semi > comma ? ";" : ",";

    // 从注释里找采样率（OpenBCI: "%Sample Rate = 250.0 Hz"）
    let fsFromComment = null;
    for (const c of comments) {
      const m = c.match(/Sample\s*Rate\s*=\s*([\d.]+)/i) || c.match(/采样率\s*[=:]\s*([\d.]+)/);
      if (m) {
        fsFromComment = parseFloat(m[1]);
        break;
      }
    }

    let channelNames = [];
    let dataStart = idx;
    let timeCol = 0;
    let fsFromHeader = null;

    if (hasTextHeader) {
      channelNames = headerLine.split(sep).map((s) => s.trim());
      dataStart = idx + 1;
      // 找采样率列
      const fsCol = channelNames.findIndex(
        (h) => /sampling\s*rate|采样率/i.test(h)
      );
      if (fsCol >= 0) fsFromHeader = fsCol;
      // 找时间列（Time (s) / timestamp / sec / 时间 …）
      // 以前这里写死 0，遇到"时间列不在第一列"的 CSV 会把时间当信号通道
      const tCol = channelNames.findIndex(
        (h) => /^(time|timestamp|sec|seconds)\b|^t$/i.test(h) || /时间|秒/.test(h)
      );
      timeCol = tCol >= 0 ? tCol : 0;
    }

    return {
      allLines,
      comments,
      headerLine,
      hasTextHeader,
      sep,
      fsFromComment,
      channelNames,
      dataStart,
      timeCol,
      fsFromHeader,
    };
  }

  /** 解析一行数值。整行无有效数字时返回 null */
  function _parseRowLine(line, sep) {
    const parts = line.split(sep);
    const nums = new Float64Array(parts.length);
    let ok = 0;
    for (let c = 0; c < parts.length; c++) {
      const v = parseFloat(parts[c]);
      if (Number.isFinite(v)) {
        nums[c] = v;
        ok++;
      } else {
        nums[c] = NaN;
      }
    }
    return ok === 0 ? null : nums;
  }

  /** 把 [from, to) 区间的数据行解析进 rows（可分批调用） */
  function _collectRows(head, from, to, rows) {
    const allLines = head.allLines;
    const sep = head.sep;
    for (let i = from; i < to; i++) {
      const ln = allLines[i];
      if (!ln) continue;
      const t = ln.trim();
      if (!t) continue;
      if (t.startsWith("%") || t.startsWith("#")) continue;
      const nums = _parseRowLine(ln, sep);
      if (nums) rows.push(nums);
    }
  }

  /**
   * 同步解析（小文件、Node/jsc 环境用）。
   * 大文件请用 parseEegCsvAsync，避免阻塞主线程。
   */
  function parseEegCsv(text, filename = "") {
    const head = _csvHead(text);
    const rows = [];
    _collectRows(head, head.dataStart, head.allLines.length, rows);
    return _csvFinish(head, rows, filename);
  }

  /**
   * 分片解析：每 4000 行让出一次事件循环。
   * @param {(ratio:number, rows:number)=>void} [onProgress] 进度回调（0~1）
   */
  async function parseEegCsvAsync(text, filename = "", onProgress = null) {
    const head = _csvHead(text);
    const rows = [];
    const CHUNK = 4000;
    const total = Math.max(1, head.allLines.length - head.dataStart);

    for (let i = head.dataStart; i < head.allLines.length; i += CHUNK) {
      _collectRows(head, i, Math.min(head.allLines.length, i + CHUNK), rows);
      if (onProgress) {
        const done = Math.min(head.allLines.length, i + CHUNK) - head.dataStart;
        onProgress(Math.min(1, done / total), rows.length);
      }
      // 让出主线程：渲染/定时器/输入事件都能插进来
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (onProgress) onProgress(1, rows.length);
    return _csvFinish(head, rows, filename);
  }

  function _csvFinish(head, rows, filename) {
    const {
      channelNames,
      timeCol,
      fsFromHeader,
      fsFromComment,
      comments,
      sep,
    } = head;



    // ---- 通道选择 ----
    let c0 = 1;
    let c1 = 2;
    let chNames = ["CH1", "CH2"];

    // 时间列、采样率列、以及整列都是文本的列（如 Subject ID）都不是信号
    const nColsData = rows[0].length;
    const probeN = Math.min(rows.length, 500);
    const validCnt = new Array(nColsData).fill(0);
    for (let i = 0; i < probeN; i++) {
      const r = rows[i];
      const lim = Math.min(nColsData, r.length);
      for (let c = 0; c < lim; c++) {
        if (Number.isFinite(r[c])) validCnt[c]++;
      }
    }
    const skipCols = new Set([timeCol]);
    if (Number.isInteger(fsFromHeader) && fsFromHeader >= 0) skipCols.add(fsFromHeader);
    const signalCols = [];
    for (let c = 0; c < nColsData && signalCols.length < 2; c++) {
      if (skipCols.has(c)) continue;
      // 有效数值不足一半 → 文本列，跳过
      if (validCnt[c] < probeN * 0.5) continue;
      signalCols.push(c);
    }

    if (channelNames.length > 2) {
      const fp1 = channelNames.findIndex((h) => /fp\s*1|fp1|af7/i.test(h));
      const fp2 = channelNames.findIndex((h) => /fp\s*2|fp2|af8/i.test(h));
      if (fp1 >= 0 && fp2 >= 0 && fp1 !== fp2) {
        c0 = fp1;
        c1 = fp2;
        chNames = [channelNames[fp1], channelNames[fp2]];
      } else if (signalCols.length >= 2) {
        // 没有 Fp1/Fp2 表头：取前两路非时间列信号
        c0 = signalCols[0];
        c1 = signalCols[1];
        chNames = [channelNames[c0] || "CH1", channelNames[c1] || "CH2"];
      } else {
        c0 = 0;
        c1 = 0;
        chNames = [channelNames[0] || "CH1", channelNames[0] || "CH1"];
      }
    } else if (nColsData === 1) {
      // 单列：无法构成双通道，复制成双通道
      c0 = 0;
      c1 = 0;
      chNames = ["CH1", "CH1"];
    } else {
      if (signalCols.length >= 2) {
        c0 = signalCols[0];
        c1 = signalCols[1];
      } else if (signalCols.length === 1) {
        c0 = signalCols[0];
        c1 = signalCols[0];
      } else {
        c0 = 0;
        c1 = 0;
      }
      chNames = [channelNames[c0] || "CH1", channelNames[c1] || "CH2"];
    }

    const n = rows.length;
    const tRaw = new Float64Array(n);
    const a = new Float64Array(n);
    const b = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      const r = rows[i];
      tRaw[i] = Number.isFinite(r[timeCol]) ? r[timeCol] : i;
      a[i] = Number.isFinite(r[c0]) ? r[c0] : NaN;
      b[i] = Number.isFinite(r[c1]) ? r[c1] : NaN;
    }

    // ---- 采样率推断 ----
    let fs = fsFromComment || 0;
    if (!fs && fsFromHeader !== null && fsFromHeader !== undefined) {
      const v = rows[0][fsFromHeader];
      if (Number.isFinite(v) && v > 0) fs = v;
    }
    if (!fs) {
      // 判断第 0 列是时间还是采样序号
      const looksIndex =
        Math.abs(tRaw[0]) < 1e-9 &&
        Math.abs(tRaw[1] - 1) < 1e-6 &&
        Math.abs(tRaw[2] - 2) < 1e-6;
      if (!looksIndex) {
        const dts = [];
        for (let i = 1; i < Math.min(n, 2000); i++) {
          const d = tRaw[i] - tRaw[i - 1];
          if (d > 0 && Number.isFinite(d)) dts.push(d);
        }
        dts.sort((x, y) => x - y);
        const med = dts.length ? dts[dts.length >> 1] : 0;
        if (med > 0) fs = 1 / med;
      }
    }
    if (!fs || !Number.isFinite(fs) || fs <= 0) fs = BASE_FS;

    // 统一时间轴（秒，从 0 开始）
    const looksIndexAgain =
      Math.abs(tRaw[0]) < 1e-9 &&
      n > 2 &&
      Math.abs(tRaw[1] - 1) < 1e-6 &&
      Math.abs(tRaw[2] - 2) < 1e-6;
    const t = new Float64Array(n);
    if (looksIndexAgain) {
      for (let i = 0; i < n; i++) t[i] = i / fs;
    } else {
      const t0 = tRaw[0];
      for (let i = 0; i < n; i++) t[i] = (tRaw[i] - t0) || i / fs;
    }

    // 缺失值线性插补
    fillNaNs(a);
    fillNaNs(b);

    const format =
      channelNames.length > 2
        ? "表头 CSV（" + sep + " 分隔）"
        : comments.length
        ? "OpenBCI 原始数据"
        : "通用 CSV";

    return {
      ch0: a,
      ch1: b,
      t,
      fs,
      format,
      channels: chNames,
      filename,
      duration: t[n - 1] || 0,
    };
  }

  function fillNaNs(arr) {
    let first = -1;
    for (let i = 0; i < arr.length; i++) {
      if (Number.isFinite(arr[i])) {
        first = i;
        break;
      }
    }
    if (first < 0) {
      arr.fill(0);
      return;
    }
    for (let i = 0; i < first; i++) arr[i] = arr[first];
    for (let i = first + 1; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) {
        let j = i + 1;
        while (j < arr.length && !Number.isFinite(arr[j])) j++;
        const prev = arr[i - 1];
        const next = j < arr.length ? arr[j] : prev;
        const span = j - i + 1;
        for (let k = i; k < j; k++) {
          arr[k] = prev + ((next - prev) * (k - i + 1)) / span;
        }
        i = j - 1;
      }
    }
  }

  /* ============================================================
     基类
     ============================================================ */

  class Source extends U.Emitter {
    constructor() {
      super();
      this.running = false;
      this.kind = "base";
      this.label = "未命名";
    }
    start() {
      throw new Error("未实现");
    }
    stop() {
      this.running = false;
    }
    /** 默认暂停：停掉定时器。需要保持底层连接（串口/WebSocket）的源自行覆盖。 */
    pause() {
      this.stop();
    }
    resume() {
      return this.start();
    }
  }

  /* ============================================================
     1. 合成信号源
     ============================================================ */

  class SimSource extends Source {
    constructor(opts = {}) {
      super();
      this.kind = "sim";
      this.label = "合成 EEG";
      this.fs = opts.fs || BASE_FS;
      this.synth = new BB.BlinkSynth({ fs: this.fs, ...opts });
      this._timer = null;
      this._acc = 0;
      this._last = 0;
      this.realtime = true;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this._last = performance.now();
      this._acc = 0;
      // 10 ms 一批，兼顾延迟与主线程开销
      this._timer = setInterval(() => this._tick(), 10);
    }

    _tick() {
      if (!this.running) return;
      const now = performance.now();
      let dt = (now - this._last) / 1000;
      this._last = now;
      if (dt > 0.25) dt = 0.25; // 切后台保护

      this._acc += dt * this.fs;
      let n = Math.floor(this._acc);
      this._acc -= n;
      if (n > this.fs) n = this.fs;

      const batch = { x0: new Float64Array(n), x1: new Float64Array(n), t: new Float64Array(n) };
      for (let i = 0; i < n; i++) {
        const s = this.synth.step();
        batch.x0[i] = s.x0;
        batch.x1[i] = s.x1;
        batch.t[i] = s.t;
      }
      if (n > 0) this.emit("raw", batch);
    }

    /** 注入一次眨眼（UI 的"模拟眨眼"按钮） */
    blink(kind = "normal", scale = 1) {
      return this.synth.trigger(kind, scale);
    }

    stop() {
      this.running = false;
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    }
  }

  /* ============================================================
     2. CSV 回放
     ============================================================ */

  class CsvSource extends Source {
    /**
     * @param {object} parsed parseEegCsv 的结果
     * @param {object} opts { speed, loop, startAt }
     */
    constructor(parsed, opts = {}) {
      super();
      this.kind = "csv";
      this.label = "CSV 回放";
      this.data = parsed;
      this.fs = parsed.fs;
      this.speed = opts.speed ?? 1;
      this.loop = opts.loop ?? true;
      this.pos = 0;
      this._started = false;
      this._timer = null;
      this._last = 0;
      this._acc = 0;
      this._t0 = 0;
    }

    start() {
      if (this.running) return;
      // 只有首次启动或已播到结尾时才回到开头：暂停后继续必须接着播
      if (!this._started || this.pos >= this.data.ch0.length) this.pos = 0;
      this._started = true;
      this.running = true;
      this._acc = 0;
      this._last = performance.now();
      this._t0 = performance.now();
      this._timer = setInterval(() => this._tick(), 10);
      this.emit("started", { fs: this.fs, duration: this.data.duration });
    }

    _tick() {
      if (!this.running) return;
      const now = performance.now();
      let dt = (now - this._last) / 1000;
      this._last = now;
      if (dt > 0.25) dt = 0.25;

      const { ch0, ch1, t } = this.data;
      const n = ch0.length;
      this._acc += dt * this.fs * this.speed;
      let count = Math.floor(this._acc);
      this._acc -= count;
      if (count > this.fs) count = this.fs;

      if (this.pos + count > n) {
        count = n - this.pos;
      }

      if (count > 0) {
        const b = {
          x0: ch0.slice(this.pos, this.pos + count),
          x1: ch1.slice(this.pos, this.pos + count),
          t: t.slice(this.pos, this.pos + count),
        };
        this.pos += count;
        this.emit("raw", b);
      }

      if (this.pos >= n) {
        if (this.loop) {
          this.pos = 0;
          this.emit("looped", {});
        } else {
          this.stop();
          this.emit("ended", {});
        }
      }
    }

    stop() {
      this.running = false;
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    }

    get progress() {
      return this.data ? this.pos / this.data.ch0.length : 0;
    }
  }

  /* ============================================================
     3. OpenBCI（Web Serial）
     ============================================================ */

  /**
   * Cyton 二进制包：33 字节
   *   [0] 0xA0  [1] sample number  [2..25] 8ch × 3byte  [26..31] accel  [32] 0xC0
   */
  class SerialSource extends Source {
    constructor(opts = {}) {
      super();
      this.kind = "serial";
      this.label = "OpenBCI 串口";
      this.fs = opts.fs || 250;
      this.baud = opts.baud || 115200;
      this.port = null;
      this.reader = null;
      this._buf = new Uint8Array(0);
      this._stop = false;
      this._paused = false;
      this._sampleNo = 0;
      this._chCount = opts.channels || 8;
    }

    static supported() {
      return typeof navigator !== "undefined" && "serial" in navigator;
    }

    async start() {
      if (!SerialSource.supported()) {
        throw new Error("当前浏览器不支持 Web Serial（请用 Chrome / Edge）");
      }
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.baud, bufferSize: 4096 });
      this.running = true;
      this._stop = false;
      this._readLoop();
      this.emit("opened", { baud: this.baud });
    }

    async _readLoop() {
      const port = this.port;
      while (port.readable && !this._stop) {
        this.reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && value.length) this._feed(value);
          }
        } catch (e) {
          if (!this._stop) this.emit("error", e);
        } finally {
          try {
            this.reader.releaseLock();
          } catch (e) {}
        }
      }
    }

    _feed(chunk) {
      if (this._paused) {
        this._buf = new Uint8Array(0);
        return;
      }
      // 拼接缓冲
      const buf = new Uint8Array(this._buf.length + chunk.length);
      buf.set(this._buf, 0);
      buf.set(chunk, this._buf.length);

      let i = 0;
      const out = { x0: [], x1: [], t: [] };
      while (i < buf.length) {
        if (buf[i] !== 0xa0) {
          i++;
          continue;
        }
        if (i + 33 > buf.length) break; // 等待更多数据
        if (buf[i + 32] !== 0xc0) {
          i++;
          continue;
        }
        const ch0 = readInt24(buf, i + 2);
        const ch1 = readInt24(buf, i + 5);
        out.x0.push(ch0 * 0.02235174); // OpenBCI Cyton 增益 → µV
        out.x1.push(ch1 * 0.02235174);
        out.t.push((this._sampleNo++ / this.fs) * 1000);
        i += 33;
      }
      this._buf = buf.slice(i);

      if (out.x0.length) {
        this.emit("raw", {
          x0: Float64Array.from(out.x0),
          x1: Float64Array.from(out.x1),
          t: Float64Array.from(out.t),
        });
      }
    }

    /** 暂停时保持端口打开，只在收到数据时丢弃，避免每次「继续」都重新弹设备选择框。 */
    pause() {
      if (!this.running) return;
      this._paused = true;
      this.running = false;
    }

    resume() {
      if (!this._paused) return;
      this._paused = false;
      this.running = true;
    }

    async stop() {
      this._stop = true;
      this.running = false;
      this._paused = false;
      try {
        if (this.reader) await this.reader.cancel();
      } catch (e) {}
      try {
        if (this.port) await this.port.close();
      } catch (e) {}
      this.port = null;
      this.reader = null;
    }
  }

  function readInt24(buf, off) {
    let v = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
    if (v & 0x800000) v |= 0xff000000; // 符号扩展
    return v;
  }

  /* ============================================================
     4. WebSocket（对接 Python 桥接器）
     ============================================================ */

  class WsSource extends Source {
    constructor(url, opts = {}) {
      super();
      this.kind = "ws";
      this.label = "Python 桥接器";
      this.url = url || "ws://127.0.0.1:8765";
      this.ws = null;
      this.reconnect = opts.reconnect !== false;
      this._retry = 0;
      this._closedByUser = false;
      this._paused = false;
    }

    start() {
      if (this.running) return;
      this._closedByUser = false;
      this._connect();
    }

    _connect() {
      this.running = true;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this.emit("error", e);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this._retry = 0;
        this.emit("opened", { url: this.url });
      };
      ws.onclose = () => {
        this.emit("closed", {});
        if (!this._closedByUser && this.reconnect) {
          this._retry = Math.min(this._retry + 1, 6);
          setTimeout(() => this._connect(), 600 * this._retry);
        }
      };
      ws.onerror = () => this.emit("error", new Error("WebSocket 连接失败"));
      ws.onmessage = (ev) => {
        if (this._paused) return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (msg.type === "blink") {
          this.emit("event", {
            t: Number(msg.t) * 1000,
            score: Number(msg.score) || 0,
            tPeak: Number(msg.tPeak || msg.t) * 1000,
          });
        } else if (msg.type === "ready") {
          this.emit("ready", { count: msg.count });
        } else if (msg.type === "done") {
          this.emit("done", {});
        }
      };
    }

    /** 暂停时保持连接：重连会让桥接器把事件从头重放。 */
    pause() {
      this._paused = true;
    }

    resume() {
      this._paused = false;
    }

    stop() {
      this._closedByUser = true;
      this.running = false;
      this._paused = false;
      if (this.ws) {
        try {
          this.ws.close();
        } catch (e) {}
        this.ws = null;
      }
    }
  }

  BB.sources = {
    Source,
    SimSource,
    CsvSource,
    SerialSource,
    WsSource,
    parseEegCsv,
    parseEegCsvAsync,
    BASE_FS,
  };
})(typeof window !== "undefined" ? window : globalThis);
