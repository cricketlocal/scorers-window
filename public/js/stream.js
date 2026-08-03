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
  let audioTracks = [];
  let running = false;
  let lastMatch = null;

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
   * Start compositing camera (+audio) with score overlay into one MediaStream.
   * @returns {MediaStream|null}
   */
  function startComposite(videoEl, camStream, match) {
    stopComposite();
    lastMatch = match || null;
    if (!videoEl || !camStream) return null;

    const vw = videoEl.videoWidth || 1280;
    const vh = videoEl.videoHeight || 720;
    ensureCanvas(vw, vh);
    running = true;
    loop(videoEl);

    const fps = 30;
    const vTrack = canvas.captureStream(fps).getVideoTracks()[0];
    audioTracks = camStream.getAudioTracks().map((t) => t.clone());
    const tracks = [vTrack, ...audioTracks].filter(Boolean);
    compositeStream = new MediaStream(tracks);
    return compositeStream;
  }

  function updateMatch(match) {
    lastMatch = match || null;
  }

  function stopComposite() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (compositeStream) {
      compositeStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* */
        }
      });
      compositeStream = null;
    }
    audioTracks = [];
  }

  function getCompositeStream() {
    return compositeStream;
  }

  function hasStreamKey() {
    const s = global.SWHub?.loadSettings?.() || {};
    return !!(s.youtubeStreamKey && String(s.youtubeStreamKey).trim());
  }

  function streamKeyMasked() {
    const k = String(global.SWHub?.loadSettings?.()?.youtubeStreamKey || "").trim();
    if (!k) return "";
    if (k.length <= 6) return "••••";
    return `${k.slice(0, 3)}…${k.slice(-3)}`;
  }

  /**
   * Placeholder for cloud RTMP/WHIP publish.
   * Returns status object for UI.
   */
  async function beginPublish() {
    const key = String(global.SWHub?.loadSettings?.()?.youtubeStreamKey || "").trim();
    if (!key) {
      return {
        ok: false,
        mode: "local",
        message: "Add your YouTube stream key once in Setup, then Go Live again.",
      };
    }
    if (!compositeStream) {
      return { ok: false, mode: "local", message: "Camera composite not ready." };
    }
    // Browsers cannot open RTMP sockets. Relay (WHIP/RTMP) is the next backend piece.
    // Until then: on-air composite is ready; key is stored for the relay.
    return {
      ok: true,
      mode: "local-ready",
      message:
        "On air with scores. Stream key saved — phone→YouTube push uses this key via cloud relay (next). Picture is camera+overlay.",
      streamKeySet: true,
    };
  }

  function endPublish() {
    stopComposite();
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
  };
})(typeof window !== "undefined" ? window : globalThis);
