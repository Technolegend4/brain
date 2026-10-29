/* ============================================================
   main.js — 装配：数据源 → 检测器 → 游戏 → 界面
   ============================================================ */
(function () {
  "use strict";

  const BB = window.BB;
  const U = BB.util;
  const $ = U.$;

  // ?present=1 → 展示模式：隐藏右侧控制栏，只留游戏 + 波形，适合给别人看
  try {
    if (typeof location !== "undefined" && /[?&]present=1/.test(location.search)) {
      document.body.classList.add("present");
    }
  } catch (e) { /* 老环境忽略 */ }

  /* ============================================================
     全局状态
     ============================================================ */
  const S = {
    game: null,
    det: null,
    source: null,
    fs: 250,
    connected: false,
    paused: false,
    calibrating: false,
    calibBuf: [],
    calibEndsAt: 0,
    autoDiff: true,
    // 波形环形缓冲
    wave: {
      z0: new U.Ring(2500),
      z1: new U.Ring(2500),
      s: new U.Ring(2500),
    },
    events: [], // {t, score}
    lastLagMs: null,
    // 当前 batch 的游标（用于事件时间回溯）
    curIdx: 0,
    curN: 1,
    lastBatchAt: 0,
    packets: 0,
    samples: 0,
    blinkCount: 0,
    autoRestartAt: 0,
  };

  /* ============================================================
     日志
     ============================================================ */
  const logEl = $("log");

  function log(msg, kind) {
    const d = document.createElement("div");
    const t = S.game ? S.game.time.toFixed(1) : "0.0";
    const span = document.createElement("span");
    span.className = "t";
    span.textContent = "[" + t + "s]";
    const text = document.createElement("span");
    text.className = kind || "";
    text.textContent = msg;
    d.appendChild(span);
    d.appendChild(text);
    logEl.appendChild(d);
    if (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function step(n, done) {
    const el = $("s" + n);
    if (el) el.classList.toggle("done", !!done);
  }

  /* ============================================================
     初始化游戏
     ============================================================ */
  const game = new BB.Game($("game"));
  S.game = game;

  $("stBest").textContent = game.best;

  game.on("start", () => {
    $("overlay").hidden = true;
    $("stScore").textContent = "0";
    $("stBlinks").textContent = "0";
    $("stRate").textContent = "0";
    step(2, true);
  });

  game.on("score", ({ score }) => {
    $("stScore").textContent = score;
  });

  game.on("hit", ({ score }) => {
    log("碰撞，本局得分 " + score, "warn");
  });

  game.on("gameover", ({ score, best }) => {
    $("stBest").textContent = best;
    log("游戏结束，得分 " + score + "，最高 " + best, score >= best ? "ok" : "");

    // 数据还在回放时不要停在结算页：让小鸟自己再飞起来，
    // 否则用户看着波形在动、小鸟却不动，会以为程序坏了
    if (S.connected) {
      S.autoRestartAt = performance.now() + 1500;
      showOverlay(
        "本局结束",
        "得分 " + score + (score >= best ? " · 新纪录！" : " · 最高 " + best) + " · 即将自动重开",
        "立即重开"
      );
    } else {
      showOverlay(
        "本局结束",
        score > 0 ? "得分 " + score + (score >= best ? " · 新纪录！" : " · 最高 " + best) : "再试一次？",
        "再来一局"
      );
    }
  });

  game.on("blinkApplied", ({ lag }) => {
    const ms = Math.max(0, lag * 1000);
    S.lastLagMs = ms;
    $("stLag").textContent = ms.toFixed(0) + " ms";
  });

  game.on("gate", ({ on }) => {
    log(on ? "节拍：开" : "节拍：关", on ? "ok" : "");
  });

  /* ============================================================
     检测器
     ============================================================ */
  // 不在这里写死阈值/不应期：滑块（thr / refr）才是唯一真源，
  // 以前写死 2.8/400 会让页面初始状态和 UI 显示不一致
  const det = new BB.BlinkDetector({ fs: S.fs });
  S.det = det;

  det.on("polarity", (p) => {
    log("自动判定眨眼极性：" + (p > 0 ? "正向" : "负向"), "ok");
  });

  // 极性判反后自动纠正（电极接反时不必手动重连）
  det.on("polarityFlip", (e) => {
    log(
      "长时间没有正向眨眼事件，疑似极性判反，已自动翻转：" + (e.polarity > 0 ? "正向" : "负向"),
      "warn"
    );
  });

  det.on("onset", (e) => {
    // 把检测时刻回溯到触发样本的真实时刻
    const lagSamples = Math.max(0, S.curN - 1 - S.curIdx);
    const lagSec = lagSamples / S.fs;
    const tEvent = Math.max(0, game.time - lagSec);

    S.lastLagMs = lagSec * 1000 + (e.lag ?? 0);
    // 标记用事件真实时刻，而不是"发现它的时刻"，否则波形上会偏一个 lag
    S.events.push({ t: tEvent, score: e.score, wall: performance.now() / 1000 });
    if (S.events.length > 400) S.events.shift();

    $("stBlinks").textContent = det.nBlinks;
    pulseDot();

    if (game.state === "running") {
      game.onBlink(tEvent, e.score, { lagSamples });
    }
  });

  det.on("blink", (e) => {
    S.blinkCount++;
    $("vBlinkCount").textContent = S.blinkCount;
    $("stBlinks").textContent = det.nBlinks;
    $("stRate").textContent = Math.round(det.ratePerMin(30));
    if (S.autoDiff) game.setDifficultyFromRate(det.ratePerMin(30));
  });

  /* ============================================================
     波形绘制
     ============================================================ */
  const waveCv = $("wave");
  const wctx = waveCv.getContext("2d");
  let waveLastDraw = 0;

  function drawWave() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = waveCv.clientWidth || 720;
    const cssH = waveCv.clientHeight || 300;
    if (waveCv.width !== Math.round(cssW * dpr) || waveCv.height !== Math.round(cssH * dpr)) {
      waveCv.width = Math.round(cssW * dpr);
      waveCv.height = Math.round(cssH * dpr);
    }
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;

    wctx.clearRect(0, 0, w, h);
    wctx.fillStyle = "#08111d";
    wctx.fillRect(0, 0, w, h);

    const span = 8; // 显示最近 8 秒

    // 三条通道：两条生理通道 + 决策分数
    const lanes = [
      { label: "FP1", key: "z0", color: "#3bb6ff", range: 6 },
      { label: "FP2", key: "z1", color: "#ff8fb1", range: 6 },
      { label: "SCORE", key: "s", color: "#4ce0b3", range: 8 },
    ];
    const padTop = 16;
    const padBot = 16;
    const laneH = (h - padTop - padBot) / lanes.length;

    lanes.forEach((ln, i) => {
      const top = padTop + i * laneH;
      const mid = top + laneH / 2;
      // 分隔线
      wctx.strokeStyle = "rgba(40,64,92,0.55)";
      wctx.lineWidth = 1;
      wctx.beginPath();
      wctx.moveTo(0, top);
      wctx.lineTo(w, top);
      wctx.stroke();
      // 零线
      wctx.setLineDash([2, 6]);
      wctx.strokeStyle = "rgba(56,84,116,0.45)";
      wctx.beginPath();
      wctx.moveTo(0, mid);
      wctx.lineTo(w, mid);
      wctx.stroke();
      wctx.setLineDash([]);
      // 通道名
      wctx.fillStyle = ln.color;
      wctx.globalAlpha = 0.8;
      wctx.font = "600 10px ui-monospace, monospace";
      wctx.fillText(ln.label, 6, top + 11);
      wctx.globalAlpha = 1;
    });

    const nShow = Math.min(S.wave.s.size, Math.floor(span * S.fs));
    if (nShow < 4) {
      wctx.fillStyle = "#3d5470";
      wctx.font = "12px ui-monospace, monospace";
      wctx.fillText("等待信号…", 70, h / 2 + 4);
      return;
    }

    const xOf = (i, n) => (i / (n - 1)) * w;

    // 阈值：只画在分数道
    const scoreTop = padTop + 2 * laneH;
    const scoreMid = scoreTop + laneH / 2;
    const scoreScale = (laneH / 2 - 8) / 8;
    const th = det.threshold;
    wctx.setLineDash([4, 5]);
    wctx.strokeStyle = "rgba(255,180,84,0.7)";
    for (const sgn of [1, -1]) {
      const y = scoreMid - sgn * th * scoreScale;
      if (y > scoreTop + 2 && y < scoreTop + laneH - 2) {
        wctx.beginPath();
        wctx.moveTo(0, y);
        wctx.lineTo(w, y);
        wctx.stroke();
      }
    }
    wctx.setLineDash([]);

    // 各通道波形
    lanes.forEach((ln, i) => {
      const ring = S.wave[ln.key];
      const n = Math.min(ring.size, nShow);
      if (n < 2) return;
      const top = padTop + i * laneH;
      const mid = top + laneH / 2;
      const scale = (laneH / 2 - 8) / ln.range;

      if (ln.key === "s") {
        wctx.beginPath();
        wctx.moveTo(0, mid);
        for (let j = 0; j < n; j++) {
          const v = ring.get(ring.size - n + j);
          wctx.lineTo(xOf(j, n), mid - U.clamp(v, -ln.range, ln.range) * scale);
        }
        wctx.lineTo(w, mid);
        wctx.closePath();
        wctx.fillStyle = "rgba(76,224,179,0.14)";
        wctx.fill();
      }

      wctx.beginPath();
      for (let j = 0; j < n; j++) {
        const v = ring.get(ring.size - n + j);
        const y = mid - U.clamp(v, -ln.range, ln.range) * scale;
        if (j === 0) wctx.moveTo(xOf(j, n), y);
        else wctx.lineTo(xOf(j, n), y);
      }
      wctx.strokeStyle = ln.color;
      wctx.lineWidth = ln.key === "s" ? 1.7 : 1.2;
      wctx.globalAlpha = ln.key === "s" ? 1 : 0.62;
      wctx.stroke();
      wctx.globalAlpha = 1;
    });

    // 眨眼事件：竖线贯穿所有通道，顶部标注
    const nowWall = performance.now() / 1000;
    let labelled = 0;
    for (let k = S.events.length - 1; k >= 0; k--) {
      const ev = S.events[k];
      const age = nowWall - ev.wall;
      if (age < 0 || age > span) continue;
      const x = w * (1 - age / span);
      // 强度 → 色相：青(弱) → 琥珀(强)，线宽同步
      const kk = U.clamp((ev.score - 3) / 7, 0, 1);
      const hue = 175 - kk * 135;
      wctx.strokeStyle = "hsla(" + hue + ",92%," + (56 + kk * 16) + "%," + (0.30 + kk * 0.45) + ")";
      wctx.lineWidth = 1 + kk * 2;
      wctx.beginPath();
      wctx.moveTo(x, padTop);
      wctx.lineTo(x, h - padBot);
      wctx.stroke();

      // 顶部三角
      wctx.fillStyle = "hsla(" + hue + ",92%,66%,0.95)";
      wctx.beginPath();
      wctx.moveTo(x, padTop - 3);
      wctx.lineTo(x - 3.5, padTop - 10);
      wctx.lineTo(x + 3.5, padTop - 10);
      wctx.closePath();
      wctx.fill();

      // 只在最近出现的几次旁写 BLINK，避免拥挤
      if (age < 2.2 && labelled < 4) {
        wctx.fillStyle = "hsla(" + hue + ",92%,72%,0.9)";
        wctx.font = "700 9px ui-monospace, monospace";
        wctx.fillText("BLINK", x + 4, padTop - 11);
        labelled++;
      }
    }

    // 时间刻度
    wctx.fillStyle = "#4d6280";
    wctx.font = "9px ui-monospace, monospace";
    wctx.fillText("-" + span + "s", 4, h - 5);
    wctx.fillText("now", w - 22, h - 5);
  }

  /* ============================================================
     连接 / 断开
     ============================================================ */
  const btnConnect = $("btnConnect");
  const btnStop = $("btnStop");
  const btnPause = $("btnPause");

  function setLink(state, text) {
    const dot = $("dot");
    dot.className = "dot" + (state === "on" ? " on" : state === "err" ? " err" : state === "warn" ? " warn" : "");
    $("linkText").textContent = text;
  }

  function pulseDot() {
    const dot = $("dot");
    dot.classList.remove("pulse");
    void dot.offsetWidth;
    dot.classList.add("pulse");
  }

  function resetPipeline() {
    det.reset();
    // 防御：滑块读到空值/非法值时 parseFloat 会得 NaN，阈值变 NaN 会让检测器永久不触发，
    // 表现就是"数据喂进去了但小鸟一动不动"。这种情况直接保留原参数。
    const thrV = parseFloat($("thr").value);
    if (Number.isFinite(thrV) && thrV > 0) det.o.threshold = thrV;
    const refrV = parseFloat($("refr").value);
    if (Number.isFinite(refrV) && refrV > 0) det.o.refractoryMs = refrV;
    det.setSampleRate(S.fs);
    S.wave.z0.clear();
    S.wave.z1.clear();
    S.wave.s.clear();
    S.events.length = 0;
    S.packets = 0;
    S.samples = 0;
    S.blinkCount = 0;
    $("vBlinkCount").textContent = "0";
    $("playBar").style.width = "0%";
    $("vPlayPos").textContent = "0.0 / 0.0 s";
    S.lastLagMs = null;
    $("stLag").textContent = "—";
  }

  function onRaw(batch) {
    const n = batch.x0.length;
    if (!n) return;
    S.packets++;
    S.curN = n;

    const fs = S.fs;
    // 时间戳必须全局单调递增：检测器的收敛期(warmupMs)、不应期都依赖
    // tMs 的绝对值。若按"批内序号"从 0 重新计时（旧实现），tMs 永远落在
    // 首批的 0~96 ms 内，warmedUp 永不置位，一次眨眼都检测不到。
    const baseMs = (S.samples * 1000) / fs;
    for (let i = 0; i < n; i++) {
      S.curIdx = i;
      det.push(batch.x0[i], batch.x1[i], baseMs + (i * 1000) / fs);
      S.wave.z0.push(det.lastZ[0]);
      S.wave.z1.push(det.lastZ[1]);
      S.wave.s.push(det.lastScore);
      if (S.calibrating) S.calibBuf.push(det.lastScore);
    }
    S.samples += n;
    S.curIdx = n - 1;

    if (S.calibrating && performance.now() > S.calibEndsAt) {
      finishCalibration();
    }
  }

  function attachSource(src) {
    S.source = src;
    src.on("raw", onRaw);

    src.on("event", (ev) => {
      // 桥接器已经检测好，直接映射到游戏时间
      S.lastLagMs = 30;
      S.events.push({ t: game.time, score: ev.score });
      det.nBlinks++;
      $("stBlinks").textContent = det.nBlinks;
      pulseDot();
      if (game.state === "running") game.onBlink(game.time, ev.score);
    });

    src.on("opened", (info) => {
      setLink("on", "已连接");
      log("信号源已连接 " + (info && info.url ? info.url : ""), "ok");
    });

    src.on("error", (e) => {
      setLink("err", "错误");
      log("信号源错误：" + (e && e.message ? e.message : String(e)), "err");
    });

    src.on("closed", () => {
      setLink("", "已断开");
    });

    src.on("ended", () => {
      log("回放结束", "");
      setLink("warn", "回放结束");
    });

    src.on("looped", () => log("回放循环", ""));
  }

  async function connect() {
    if (S.connected) return;

    const kind = $("sourceSel").value;
    S.fs = BB.sources.BASE_FS;

    try {
      let src;
      if (kind === "sim") {
        const interval = parseFloat($("simInterval").value);
        src = new BB.sources.SimSource({
          fs: S.fs,
          meanInterval: interval,
        });
      } else if (kind === "csv") {
        if (!S.csvParsed) {
          log("请先选择一个 CSV 文件", "warn");
          return;
        }
        S.fs = S.csvParsed.fs;
    $("eegMeta").textContent = "FP1 · FP2 · " + S.fs + " Hz";
        src = new BB.sources.CsvSource(S.csvParsed, {
          speed: parseFloat($("playSpeed").value) || 1,
          loop: true,
        });
      } else if (kind === "serial") {
        S.fs = parseFloat($("serialFs").value)
    $("eegMeta").textContent = "FP1 · FP2 · " + S.fs + " Hz";
        src = new BB.sources.SerialSource({ fs: S.fs });
      } else if (kind === "ws") {
        src = new BB.sources.WsSource($("wsUrl").value.trim());
      }

      resetPipeline();
      attachSource(src);
      await src.start();

      S.connected = true;
      btnConnect.disabled = true;
      btnStop.disabled = false;
      btnPause.disabled = false;
      btnPause.textContent = "暂停";

      setLink("on", "运行中");
      $("detBadge").textContent = "检测中";
      step(1, true);
      step(2, true);

      if (kind === "csv") {
        log(
          "CSV 已载入：" + S.csvParsed.filename + "，fs=" + S.fs.toFixed(0) +
            " Hz，时长 " + S.csvParsed.duration.toFixed(1) + " s", "ok"
        );
      } else if (kind === "sim") {
        log("合成信号已启动，fs=" + S.fs + " Hz，自动眨眼间隔 " + $("simInterval").value + " s", "ok");
      }

      game.start();
    } catch (e) {
      log("连接失败：" + (e && e.message ? e.message : String(e)), "err");
      setLink("err", "连接失败");
      if (S.source) {
        try { S.source.stop(); } catch (_) {}
        S.source = null;
      }
    }
  }

  function disconnect() {
    if (S.source) {
      try { S.source.stop(); } catch (e) {}
      S.source = null;
    }
    S.connected = false;
    S.paused = false;
    // 校准依赖 onRaw 推进，断开后不会再有人调用，必须在这里收尾
    S.calibrating = false;
    S.calibBuf = [];
    btnConnect.disabled = false;
    btnStop.disabled = true;
    btnPause.disabled = true;
    btnPause.textContent = "暂停";
    game.pause();
    setLink("", "未连接");
    $("detBadge").textContent = "就绪";
    log("已断开信号源", "");
  }

  btnConnect.addEventListener("click", connect);
  btnStop.addEventListener("click", disconnect);

  btnPause.addEventListener("click", () => {
    if (!S.connected) return;
    if (!S.paused) {
      S.paused = true;
      game.pause();
      if (S.source) {
        try { S.source.pause(); } catch (e) {}
      }
      btnPause.textContent = "继续";
      setLink("warn", "已暂停");
      log("已暂停", "warn");
    } else {
      S.paused = false;
      game.resume();
      if (S.source) {
        try { Promise.resolve(S.source.resume()).catch(() => {}); } catch (e) {}
      }
      btnPause.textContent = "暂停";
      setLink("on", "运行中");
      log("继续", "ok");
    }
  });

  $("btnRestart").addEventListener("click", () => {
    game.start();
    log("新开一局", "");
  });

  /* ============================================================
     数据源切换
     ============================================================ */
  const srcSel = $("sourceSel");
  const srcBadge = $("srcBadge");

  function syncSourceBoxes() {
    const v = srcSel.value;
    $("boxSim").hidden = v !== "sim";
    $("boxCsv").hidden = v !== "csv";
    $("boxSerial").hidden = v !== "serial";
    $("boxWs").hidden = v !== "ws";
    srcBadge.textContent = {
      sim: "合成",
      csv: "CSV",
      serial: "串口",
      ws: "桥接",
    }[v];
    if (v === "serial" && !BB.sources.SerialSource.supported()) {
      log("当前浏览器不支持 Web Serial，请改用 Chrome 或 Edge", "warn");
    }
  }
  srcSel.addEventListener("change", syncSourceBoxes);
  syncSourceBoxes();

  /* ============================================================
     合成源交互
     ============================================================ */
  $("simInterval").addEventListener("input", (e) => {
    $("vSimInterval").textContent = parseFloat(e.target.value).toFixed(1) + " s";
  });

  $("btnSimBlink").addEventListener("click", () => {
    if (S.source && S.source.kind === "sim") {
      S.source.blink("normal");
      log("注入一次合成眨眼", "");
    } else {
      injectSyntheticBlink("normal");
    }
  });

  $("btnSimDouble").addEventListener("click", () => {
    if (S.source && S.source.kind === "sim") {
      S.source.blink("double");
      log("注入连续双眨眼", "");
    } else {
      injectSyntheticBlink("double");
    }
  });

  /**
   * 给非合成源也提供"手动注入"能力：
   * 直接按检测链路的时序构造一个事件，方便验证游戏端。
   */
  function injectSyntheticBlink(kind) {
    det.nBlinks++;
    $("stBlinks").textContent = det.nBlinks;
    pulseDot();
    const now = game.time;
    // 模拟典型的检测延迟 90 ms
    game.onBlink(now - 0.09, 3.6);
    S.lastLagMs = 90;
    $("stLag").textContent = "90 ms";
    S.events.push({ t: now, score: 3.6 });
    log("手动注入眨眼事件（" + kind + "）", "");
  }

  /* ============================================================
     CSV
     ============================================================ */
  S.csvParsed = null;

  async function loadCsvFile(file) {
    if (!file) return;
    if (S.loadingCsv) {
      log("上一份 CSV 还在解析，请稍候", "warn");
      return;
    }
    S.loadingCsv = true;
    try {
      log("读取 " + file.name + " …", "");
      $("vCsvInfo").textContent = "读取中…";
      const text = await file.text();
      // 分片解析：EEG-VV 单文件 96k 行，同步解析会冻结主线程 1~2 秒
      const parsed = await BB.sources.parseEegCsvAsync(text, file.name, (ratio) => {
        $("vCsvInfo").textContent = "解析中 " + Math.round(ratio * 100) + "%";
      });
      S.csvParsed = parsed;
      $("vCsvInfo").textContent =
        parsed.fs.toFixed(0) + " Hz · " + parsed.duration.toFixed(1) + " s";
      $("btnDemoCsv").textContent = "重新载入示例";
      log(
        "解析成功：" + parsed.format + "，通道 " + parsed.channels.join(" / ") +
          "，采样率 " + parsed.fs.toFixed(1) + " Hz，" + parsed.ch0.length + " 点", "ok"
      );
      if (srcSel.value !== "csv") {
        srcSel.value = "csv";
        syncSourceBoxes();
      }
      await startPlayback();
    } catch (e) {
      S.csvParsed = null;
      $("vCsvInfo").textContent = "—";
      log("CSV 解析失败：" + (e && e.message ? e.message : String(e)), "err");
    } finally {
      S.loadingCsv = false;
    }
  }

  $("csvFile").addEventListener("change", (e) => loadCsvFile(e.target.files[0]));

  // 回放速度：连接后实时生效，不用重连
  $("playSpeed").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value) || 1;
    $("vSpeed").textContent = v + "×";
    if (S.source && S.source.kind === "csv") S.source.speed = v;
  });

  /** 载入数据后直接开跑：用户拖进 CSV 就应该马上看到小鸟动 */
  async function startPlayback() {
    try {
      if (S.connected) await disconnect();
      await connect();
      // 数据一到就直接开局，用户不用再点一次「开始」
      if (S.connected) game.start();
    } catch (e) {
      log("自动开始回放失败：" + (e && e.message ? e.message : String(e)), "err");
    }
  }

  $("btnDemoCsv").addEventListener("click", async () => {
    if (S.loadingCsv) {
      log("上一份 CSV 还在解析，请稍候", "warn");
      return;
    }
    S.loadingCsv = true;
    try {
      await loadDemoCsv();
    } finally {
      S.loadingCsv = false;
    }
  });

  async function loadDemoCsv() {
    const candidates = [
      "../EEG-EyeBlinks%205/EEG-IO/S00_data.csv",
      "../EEG-EyeBlinks 5/EEG-IO/S00_data.csv",
    ];
    for (const url of candidates) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        $("vCsvInfo").textContent = "下载示例…";
        const text = await r.text();
        const parsed = await BB.sources.parseEegCsvAsync(text, url.split("/").pop(), (ratio) => {
          $("vCsvInfo").textContent = "解析中 " + Math.round(ratio * 100) + "%";
        });
        S.csvParsed = parsed;
        $("vCsvInfo").textContent = parsed.fs.toFixed(0) + " Hz · " + parsed.duration.toFixed(1) + " s";
        srcSel.value = "csv";
        syncSourceBoxes();
        log("已载入数据集示例：" + parsed.filename + "（" + parsed.duration.toFixed(1) + " s）", "ok");
        await startPlayback();
        return;
      } catch (e) {
        /* 继续尝试下一个 */
      }
    }
    log("无法直接读取数据集示例（file:// 下受限），请用「选择 CSV 文件」手动载入", "warn");
  }

  // 拖拽上传
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.style.outline = "2px dashed #4ce0b3";
  });
  document.addEventListener("dragleave", () => {
    document.body.style.outline = "";
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.style.outline = "";
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadCsvFile(f);
  });

  /* ============================================================
     参数
     ============================================================ */
  // 串口采样率滑块：以前只改了值，标签上的数字永远停在 250 Hz
  $("serialFs").addEventListener("input", (e) => {
    $("vSerialFs").textContent = e.target.value + " Hz";
  });

  // 「清空」按钮以前没有绑定，点了没反应
  $("btnClearLog").addEventListener("click", () => {
    logEl.textContent = "";
  });

  $("thr").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    det.threshold = v;
    $("vThr").textContent = v.toFixed(1) + " σ";
  });

  // 游戏灵敏度 = onset 的峰值门槛。
  // 调高：只有特别有力的眨眼才触发，误跳少；调低：轻微眨眼也触发，容易乱跳。
  $("boost").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    det.o.onsetBoost = v;
    $("vBoost").textContent = v.toFixed(2);
  });

  $("refr").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    det.o.refractoryMs = v;
    $("vRefr").textContent = v.toFixed(0) + " ms";
  });

  $("autoThr").addEventListener("input", (e) => {
    S.autoDiff = parseFloat(e.target.value) > 0.5;
    $("vAuto").textContent = S.autoDiff ? "开" : "关";
  });

  const modeSel = $("modeSel");
  const MODE_HINTS = {
    assist: "基础节拍保证可玩性，眨眼会额外振翅并短暂加快节拍。",
    direct: "不自动振翅，完全靠眨眼。适合比拼「一分钟能眨多准」。",
    hold: "检测到眨眼后约 0.3 秒内持续上升，更接近「按住」的手感。",
    gate: "每次眨眼切换自动节拍的开与关，适合做注意力/抑制训练。",
  };

  modeSel.addEventListener("change", (e) => {
    game.setMode(e.target.value);
    $("modeHint").textContent = MODE_HINTS[e.target.value] || "";
    log("映射模式：" + game.mode, "");
  });

  /* ============================================================
     自动校准
     ============================================================ */
  function startCalibration() {
    if (!S.connected) {
      log("请先连接信号源再校准", "warn");
      return;
    }
    S.calibrating = true;
    S.calibBuf = [];
    S.calibEndsAt = performance.now() + 8000;
    $("detBadge").textContent = "校准中…";
    log("开始校准：请自然睁眼、尽量少眨眼，保持 8 秒", "warn");
    step(3, true);
  }

  function finishCalibration() {
    S.calibrating = false;
    const arr = S.calibBuf.filter((v) => Number.isFinite(v));
    S.calibBuf = [];
    $("detBadge").textContent = "检测中";
    if (arr.length < 200) {
      log("校准样本不足，保持原阈值", "warn");
      return;
    }
    const a = Float64Array.from(arr);
    U.sortInPlace(a);
    const p995 = a[Math.floor(a.length * 0.995)];
    const p999 = a[Math.floor(a.length * 0.999)];
    const thr = U.clamp(Math.max(2.0, p999 * 1.05, p995 * 1.25), 1.2, 8);
    det.threshold = Math.round(thr * 10) / 10;
    $("thr").value = det.threshold;
    $("vThr").textContent = det.threshold.toFixed(1) + " σ";
    log("校准完成：背景 99.5% 分位 " + p995.toFixed(2) + " σ，阈值设为 " + det.threshold.toFixed(1) + " σ", "ok");
  }

  // 双击波形区域触发校准
  waveCv.addEventListener("dblclick", startCalibration);

  /* ============================================================
     键盘（调试）
     ============================================================ */
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      // 未连接时什么都别做：以前游戏已在运行（比如刚断开）按空格仍会注入假眨眼
      if (!S.connected) {
        log("请先选择信号源并点击「连接并开始」", "warn");
        return;
      }
      if (game.state === "ready" || game.state === "over") {
        game.start();
        return;
      }
      if (S.source && S.source.kind === "sim") {
        S.source.blink("normal");
      } else {
        injectSyntheticBlink("normal");
      }
    } else if (e.key === "r" || e.key === "R") {
      game.start();
    } else if (e.key === "c" || e.key === "C") {
      startCalibration();
    }
  });

  /* ============================================================
     覆盖层
     ============================================================ */
  function showOverlay(title, text, btn) {
    const ov = $("overlay");
    $("ovTitle").textContent = title;
    $("ovText").textContent = text;
    $("ovBtn").textContent = btn || "开始";
    ov.hidden = false;
  }

  $("ovBtn").addEventListener("click", () => {
    if (game.state === "over") {
      game.start();
    } else {
      connect();
    }
  });

  /* ============================================================
     主循环：波形 + 指标刷新
     ============================================================ */
  function tickUi() {
    requestAnimationFrame(tickUi);
    const now = performance.now();
    if (now - waveLastDraw < 33) return;
    waveLastDraw = now;
    drawWave();

    if (S.connected) {
      $("stRate").textContent = Math.round(det.ratePerMin(30));
    }

    // CSV 回放进度
    if (S.source && S.source.kind === "csv" && S.source.data) {
      const sp = S.source;
      const dur = sp.data.duration || 0;
      $("playBar").style.width = (sp.progress * 100).toFixed(2) + "%";
      $("vPlayPos").textContent =
        (sp.progress * dur).toFixed(1) + " / " + dur.toFixed(1) + " s";
    }
    // 校准计时必须由 UI 循环兜底：WebSocket 源只推 event、不推 raw，
    // 只挂在 onRaw 上会让进度条永远停在"校准中…"
    if (S.calibrating && performance.now() > S.calibEndsAt) finishCalibration();

    if (S.autoRestartAt && performance.now() > S.autoRestartAt) {
      S.autoRestartAt = 0;
      if (S.connected && game.state === "over") game.start();
    }
  }
  requestAnimationFrame(tickUi);

  /* ============================================================
     启动自检
     ============================================================ */
  log("眨眼小鸟已就绪。点击「连接并开始」启动。", "ok");
  log("提示：没有硬件时用「合成 EEG」，按空格键即可注入眨眼。", "");
  setLink("", "未连接");

  // 暴露给控制台，方便调试
  window.BB_APP = { game, det, S, connect, disconnect, startCalibration };
})();
