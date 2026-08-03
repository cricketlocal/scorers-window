/**
 * Scorers Window — broadcast composite (camera + score → single video stream)
 * Stream key is stored once in settings; this module builds the on-air picture.
 * Direct browser → YouTube RTMP needs a cloud relay (WHIP/RTMP); canvas stream is the source.
 */
(function (global) {
  let canvas = null;
  let ctx = null;
  let raf = 0;
  let compositeStream = null;
  let ownedVideoTrack = null;
  let running = false;
  let lastMatch = null;
  let recorder = null;
  let ws = null;
  let publishState = "idle"; // idle | connecting | live | error | local
  let onStatus = null;
  let intentionalStop = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 8;
  let publishHandlers = null;
  let lastMime = "";
  let wakeLock = null;

  function ensureCanvas(w, h) {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
      document.body.appendChild(canvas);
      ctx = canvas.getContext("2d", { alpha: false });
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  }

  function shortName(name) {
    const parts = String(name || "")
      .replace(/\*|&dagger;|†/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length < 2) return parts[0] || "—";
    return `${parts[0].charAt(0)}. ${parts[parts.length - 1]}`;
  }

  function drawOverlayBar(c, match, W, H) {
    if (!match) return;
    const barH = Math.round(H * 0.22);
    const y0 = H - barH - Math.round(H * 0.03);
    const x0 = Math.round(W * 0.03);
    const bw = W - x0 * 2;
    const pad = Math.round(barH * 0.08);

    c.fillStyle = "rgba(6, 20, 13, 0.55)";
    roundRect(c, x0, y0, bw, barH, 12);
    c.fill();
    c.strokeStyle = "rgba(74, 222, 128, 0.35)";
    c.lineWidth = 2;
    c.stroke();

    const fs = Math.max(12, Math.round(barH * 0.11));
    const fsScore = Math.max(16, Math.round(barH * 0.18));
    c.fillStyle = "#fde68a";
    c.font = `800 ${Math.round(fs * 0.75)}px system-ui,sans-serif`;
    c.fillText(match.demo ? "DEMO" : match.live ? "LIVE" : "LIVE", x0 + pad, y0 + pad + fs);

    c.fillStyle = "#ecfdf5";
    c.font = `700 ${fs}px system-ui,sans-serif`;
    const home = String(match.homeTeam || "Home");
    const away = String(match.awayTeam || "Away");
    c.fillText(clip(c, home, bw * 0.42), x0 + pad, y0 + pad + fs * 2.1);
    c.textAlign = "right";
    c.fillText(clip(c, away, bw * 0.42), x0 + bw - pad, y0 + pad + fs * 2.1);
    c.textAlign = "left";

    c.fillStyle = "#4ade80";
    c.font = `800 ${fsScore}px system-ui,sans-serif`;
    c.fillText(String(match.homeScore || "—"), x0 + pad, y0 + pad + fs * 3.4);
    c.textAlign = "right";
    c.fillText(String(match.awayScore || "—"), x0 + bw - pad, y0 + pad + fs * 3.4);
    c.textAlign = "left";

    const d = match.detail || {};
    const bats = (d.batters || []).slice(0, 2);
    const bow = d.bowler;
    let lineY = y0 + pad + fs * 4.5;
    c.fillStyle = "#bbf7d0";
    c.font = `600 ${Math.round(fs * 0.85)}px system-ui,sans-serif`;
    if (bats.length) {
      const btxt = bats
        .map((b) => `${shortName(b.name)} ${b.runs ?? "—"}${b.onStrike ? "*" : ""}`)
        .join("   ");
      c.fillText(clip(c, btxt, bw - pad * 2), x0 + pad, lineY);
      lineY += fs * 1.15;
    }
    if (bow && bow.name) {
      const figs =
        bow.wickets != null && bow.runs != null ? `${bow.wickets}/${bow.runs}` : "";
      c.fillText(clip(c, `Bowl ${shortName(bow.name)} ${figs}`, bw - pad * 2), x0 + pad, lineY);
      lineY += fs * 1.1;
    }
    const balls = Array.isArray(d.lastBalls) ? d.lastBalls.slice(-8) : [];
    if (balls.length) {
      c.fillStyle = "#86efac";
      c.fillText(clip(c, `Balls ${balls.join(" ")}`, bw - pad * 2), x0 + pad, lineY);
    }
  }

  function clip(c, text, maxW) {
    let t = String(text);
    if (c.measureText(t).width <= maxW) return t;
    while (t.length > 1 && c.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function paintFrame(videoEl) {
    if (!running || !ctx || !videoEl) return;
    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    const c = ensureCanvas(vw, vh);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    try {
      ctx.drawImage(videoEl, 0, 0, c.width, c.height);
    } catch {
      /* video not ready */
    }
    drawOverlayBar(ctx, lastMatch, c.width, c.height);
  }

  function loop(videoEl) {
    paintFrame(videoEl);
    if (running) raf = requestAnimationFrame(() => loop(videoEl));
  }

  /**
   * Composite camera frames + score bar for YouTube.
   * Video-only (more reliable through ffmpeg/YouTube). Preview still has mic on <video>.
   */
  function startComposite(videoEl, camStream, match) {
    stopCompositeOwned();
    lastMatch = match || null;
    if (!videoEl || !camStream) return null;

    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    ensureCanvas(vw, vh);
    running = true;
    loop(videoEl);

    const fps = 25;
    const cStream = canvas.captureStream(fps);
    ownedVideoTrack = cStream.getVideoTracks()[0];
    // Video-only publish stream — avoids mobile audio+canvas MediaRecorder failures
    compositeStream = new MediaStream(ownedVideoTrack ? [ownedVideoTrack] : []);
    requestWakeLock();
    return compositeStream;
  }

  function updateMatch(match) {
    lastMatch = match || null;
  }

  function stopCompositeOwned() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try {
      ownedVideoTrack?.stop();
    } catch {
      /* */
    }
    ownedVideoTrack = null;
    compositeStream = null;
  }

  function stopComposite() {
    stopCompositeOwned();
    releaseWakeLock();
  }

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock?.request) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => {
          wakeLock = null;
        });
      }
    } catch {
      /* unsupported / denied */
    }
  }

  function releaseWakeLock() {
    try {
      wakeLock?.release?.();
    } catch {
      /* */
    }
    wakeLock = null;
  }

  function getCompositeStream() {
    return compositeStream;
  }

  function hasStreamKey() {
    const s = global.SWHub?.loadSettings?.() || {};
    const k = String(s.youtubeStreamKey || "").trim();
    if (!k) return false;
    if (global.SWHub?.looksLikeUrlNotStreamKey?.(k)) return false;
    if (global.SWHub?.isValidStreamKeyFormat && !global.SWHub.isValidStreamKeyFormat(k)) return false;
    return true;
  }

  function streamKeyMasked() {
    const k = String(global.SWHub?.loadSettings?.()?.youtubeStreamKey || "").trim();
    if (!k) return "";
    if (k.length <= 6) return "••••";
    return `${k.slice(0, 3)}…${k.slice(-3)}`;
  }

  function setStatus(partial) {
    if (partial.state) publishState = partial.state;
    if (typeof onStatus === "function") onStatus({ state: publishState, ...partial });
  }

  /** YouTube Studio / watch links are NOT the relay — ignore them. */
  function isInvalidRelayUrl(url) {
    const u = String(url || "").toLowerCase();
    if (!u) return false;
    return (
      u.includes("youtube.com") ||
      u.includes("youtu.be") ||
      u.includes("studio.youtube") ||
      u.includes("googlevideo.com")
    );
  }

  function effectiveRelayBase() {
    const s = global.SWHub?.loadSettings?.() || {};
    const custom = String(s.streamRelayUrl || "").trim();
    if (custom && !isInvalidRelayUrl(custom)) {
      return custom.replace(/\/+$/, "");
    }
    // Same origin as this page (must be the Docker app host)
    return location.origin;
  }

  function wsUrl() {
    const base = effectiveRelayBase();
    if (base.startsWith("ws")) {
      return base.includes("/ws/") ? base : base.replace(/\/+$/, "") + "/ws/stream";
    }
    const u = base.replace(/^http/, "ws").replace(/\/+$/, "");
    return u + "/ws/stream";
  }

  function pickRecorderMime() {
    // Video-only composite — must NOT request opus/audio codecs (causes "Invalid data" in ffmpeg)
    const types = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm;codecs=h264",
      "video/webm",
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  async function probeRelay() {
    const raw = String(global.SWHub?.loadSettings?.()?.streamRelayUrl || "").trim();
    if (isInvalidRelayUrl(raw)) {
      return {
        ok: false,
        youtubeRelay: false,
        ffmpeg: false,
        error: "INVALID_RELAY_URL",
        message:
          "Stream relay URL must be our Scorers Window app (e.g. https://scorers-window-live.onrender.com), not a YouTube Studio link. Leave the field blank if you opened the app on the Docker host.",
        hint: "Clear Stream relay URL, Save, then Test again. Open https://scorers-window-live.onrender.com for the phone.",
      };
    }
    try {
      const base = effectiveRelayBase();
      const url = base.replace(/\/+$/, "") + "/api/stream/status";
      const res = await fetch(url, { cache: "no-store" });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        return { ok: false, youtubeRelay: false, ffmpeg: false, status: res.status, probed: url };
      }
      // Static site returns HTML for /api/* — not the Docker relay
      if (!ct.includes("application/json")) {
        return {
          ok: false,
          youtubeRelay: false,
          ffmpeg: false,
          error: "NOT_DOCKER",
          message:
            "This host is the static site (no ffmpeg). Open https://scorers-window-live.onrender.com and leave Stream relay blank.",
          probed: url,
        };
      }
      const json = await res.json();
      return { ...json, probed: url };
    } catch (e) {
      return {
        ok: false,
        youtubeRelay: false,
        ffmpeg: false,
        error: "FETCH_FAIL",
        message: e.message || String(e),
      };
    }
  }

  function scheduleReconnect(reason) {
    if (intentionalStop) return;
    if (reconnectAttempts >= MAX_RECONNECT) {
      setStatus({
        state: "local",
        ok: true,
        message:
          "YouTube push stopped — camera+scores still on this phone. " +
          "Check: (1) real stream key in Setup (2) YouTube Studio already Live (3) stay on this screen. Then End → Go Live.",
      });
      return;
    }
    reconnectAttempts += 1;
    const delay = Math.min(10000, 2000 * reconnectAttempts);
    setStatus({
      state: "connecting",
      message: `Reconnecting to YouTube… try ${reconnectAttempts}/${MAX_RECONNECT}`,
    });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (intentionalStop || !compositeStream) return;
      connectRelay(lastMime || pickRecorderMime(), true).catch(() => {});
    }, delay);
  }

  /**
   * Open WS + MediaRecorder → server ffmpeg → YouTube.
   * @param {string} mime
   * @param {boolean} isRetry
   */
  function connectRelay(mime, isRetry) {
    const key = String(global.SWHub?.loadSettings?.()?.youtubeStreamKey || "").trim();
    lastMime = mime;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Tear down previous socket/recorder without clearing composite
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        /* */
      }
      recorder = null;
      try {
        if (ws) {
          ws.onclose = null;
          ws.onerror = null;
          ws.onmessage = null;
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "stop" }));
            } catch {
              /* */
            }
            ws.close();
          }
        }
      } catch {
        /* */
      }
      ws = null;

      try {
        ws = new WebSocket(wsUrl());
        ws.binaryType = "arraybuffer";
      } catch (e) {
        setStatus({ state: "error", message: "WebSocket failed: " + (e.message || e) });
        finish({ ok: false, mode: "error", message: String(e.message || e) });
        scheduleReconnect("socket fail");
        return;
      }

      const timeout = setTimeout(() => {
        setStatus({ state: "connecting", message: "Relay connect timeout — retrying…" });
        finish({ ok: false, mode: "error", message: "timeout" });
        try {
          ws.close();
        } catch {
          /* */
        }
        scheduleReconnect("timeout");
      }, 25000);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: "start", streamKey: key, mime }));
        } catch (e) {
          finish({ ok: false, message: e.message });
        }
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "ping") {
          try {
            ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
          } catch {
            /* */
          }
          return;
        }
        if (msg.type === "hello") {
          if (!msg.youtubeRelay && !msg.ffmpeg) {
            clearTimeout(timeout);
            setStatus({
              state: "local",
              ok: true,
              message: "Relay has no ffmpeg — on air on phone only.",
            });
            finish({ ok: true, mode: "local-ready" });
          }
          return;
        }
        if (msg.type === "started") {
          clearTimeout(timeout);
          reconnectAttempts = 0;
          try {
            recorder = new MediaRecorder(compositeStream, {
              mimeType: mime,
              videoBitsPerSecond: 2_000_000,
              audioBitsPerSecond: 128_000,
            });
          } catch (e) {
            setStatus({ state: "error", message: "MediaRecorder: " + e.message });
            finish({ ok: false, mode: "error", message: e.message });
            return;
          }
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
              e.data.arrayBuffer().then((buf) => {
                try {
                  if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
                } catch {
                  /* */
                }
              });
            }
          };
          recorder.onerror = () => {
            setStatus({ state: "connecting", message: "Recorder error — reconnecting…" });
            scheduleReconnect("recorder");
          };
          // 500ms chunks = faster start for ffmpeg probing
          // Smaller chunks help ffmpeg start; video-only is more stable on mobile
          recorder.start(1000);
          setStatus({
            state: "live",
            ok: true,
            mode: "youtube",
            message: isRetry
              ? "Back on YouTube — keep this screen open"
              : "ON AIR → YouTube. Keep screen open (don't lock or switch apps)",
            key: msg.key,
          });
          finish({
            ok: true,
            mode: "youtube",
            message: "Streaming to YouTube",
            streamKeySet: true,
          });
          return;
        }
        if (msg.type === "warn") {
          setStatus({
            state: publishState === "live" ? "live" : "connecting",
            message: msg.message || "Relay warning",
          });
          return;
        }
        if (msg.type === "error") {
          clearTimeout(timeout);
          setStatus({
            state: "connecting",
            message: msg.message || "Relay error",
            code: msg.code,
          });
          finish({ ok: false, mode: "error", message: msg.message });
          scheduleReconnect(msg.message || "error");
          return;
        }
        if (msg.type === "ended") {
          clearTimeout(timeout);
          const hint = msg.message || "YouTube encoder stopped";
          if (msg.recoverable !== false && !intentionalStop) {
            setStatus({ state: "connecting", message: hint + " — reconnecting…" });
            scheduleReconnect(hint);
          } else {
            setStatus({ state: "local", ok: true, message: hint + " — still on air on phone" });
          }
          finish({ ok: false, mode: "ended", message: hint });
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        if (!settled) {
          finish({ ok: false, mode: "error", message: "ws error" });
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (intentionalStop) return;
        if (publishState === "live" || publishState === "connecting") {
          scheduleReconnect("link dropped");
        }
      };
    });
  }

  /**
   * Start YouTube publish via server ffmpeg relay (MediaRecorder → WebSocket → RTMP).
   */
  async function beginPublish(handlers = {}) {
    publishHandlers = handlers;
    onStatus = handlers.onStatus || null;
    intentionalStop = false;
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);

    const key = String(global.SWHub?.loadSettings?.()?.youtubeStreamKey || "").trim();
    if (!key || global.SWHub?.looksLikeUrlNotStreamKey?.(key) || !global.SWHub?.isValidStreamKeyFormat?.(key)) {
      setStatus({
        state: "error",
        ok: false,
        mode: "local",
        message:
          "Need a real YouTube STREAM KEY (xxxx-xxxx-…), not a Studio web link. Studio → Go live → Stream → copy Stream key.",
      });
      return { ok: false, mode: "local", message: "Invalid stream key" };
    }
    if (!compositeStream) {
      setStatus({ state: "error", ok: false, mode: "local", message: "Camera composite not ready." });
      return { ok: false, mode: "local", message: "No composite" };
    }

    const probe = await probeRelay();
    if (!probe.youtubeRelay && !probe.ffmpeg) {
      setStatus({
        state: "local",
        ok: true,
        mode: "local-ready",
        message:
          "On air on this phone (camera + scores). YouTube relay not available — use https://scorers-window-live.onrender.com or OBS.",
      });
      return {
        ok: true,
        mode: "local-ready",
        message: "Local on-air; relay unavailable",
        streamKeySet: true,
      };
    }

    if (typeof MediaRecorder === "undefined") {
      setStatus({
        state: "local",
        ok: true,
        mode: "local-ready",
        message: "On air locally. This browser cannot MediaRecorder-publish.",
      });
      return { ok: true, mode: "local-ready", message: "No MediaRecorder" };
    }

    const mime = pickRecorderMime();
    if (!mime) {
      setStatus({
        state: "local",
        ok: true,
        mode: "local-ready",
        message: "On air locally. No supported video format in this browser.",
      });
      return { ok: true, mode: "local-ready", message: "No mime" };
    }

    setStatus({ state: "connecting", message: "Connecting to YouTube relay…" });
    return connectRelay(mime, false);
  }

  function stopRelayOnly() {
    intentionalStop = true;
    clearTimeout(reconnectTimer);
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      /* */
    }
    recorder = null;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
        ws.close();
      }
    } catch {
      /* */
    }
    ws = null;
  }

  function endPublish() {
    stopRelayOnly();
    stopComposite();
    publishState = "idle";
    onStatus = null;
    publishHandlers = null;
    reconnectAttempts = 0;
  }

  function getPublishState() {
    return publishState;
  }

  global.SWStream = {
    startComposite,
    updateMatch,
    stopComposite,
    getCompositeStream,
    hasStreamKey,
    streamKeyMasked,
    beginPublish,
    endPublish,
    probeRelay,
    getPublishState,
  };
})(typeof window !== "undefined" ? window : globalThis);
