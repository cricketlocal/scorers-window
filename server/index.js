/**
 * Scorers Window — static app + WebSocket media relay → YouTube RTMP via ffmpeg
 *
 * Phone sends MediaRecorder WebM (video-only). We buffer until probe-friendly,
 * then ffmpeg re-encodes H.264 → YouTube RTMP.
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "..", "public");
const YT_RTMP_BASE = process.env.YT_RTMP_BASE || "rtmp://a.rtmp.youtube.com/live2";
const MAX_SESSIONS = Number(process.env.MAX_STREAM_SESSIONS || 3);
// Wait for this many bytes before starting ffmpeg (helps WebM probe)
const START_BYTES = Number(process.env.STREAM_START_BYTES || 120000);

function ffmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = ffmpegAvailable();
console.log(`[scorers-window] ffmpeg: ${hasFfmpeg ? "ok" : "MISSING"}`);

const app = express();
app.disable("x-powered-by");

/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {object | null} */
let lastStreamEvent = null;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "scorers-window",
    ffmpeg: hasFfmpeg,
    youtubeRelay: hasFfmpeg,
    maxSessions: MAX_SESSIONS,
    activeSessions: sessions.size,
  });
});

app.get("/api/stream/status", (_req, res) => {
  res.json({
    ok: true,
    ffmpeg: hasFfmpeg,
    youtubeRelay: hasFfmpeg,
    activeSessions: sessions.size,
    rtmpBase: YT_RTMP_BASE.replace(/\/+$/, ""),
    lastStreamEvent,
  });
});

/**
 * Resolve @handle live for in-app embed.
 * Prefer channel live_stream embed (matches youtube.com/@handle/live).
 * GET /api/youtube/channel-live?handle=LullingtonLive
 */
app.get("/api/youtube/channel-live", async (req, res) => {
  const handle = String(req.query.handle || "LullingtonLive")
    .replace(/^@/, "")
    .replace(/[^\w.-]/g, "");
  if (!handle) return res.status(400).json({ ok: false, error: "handle required" });

  // Hardcoded club channel (reliable; matches @LullingtonLive)
  const KNOWN = {
    LullingtonLive: "UCR4PqiyQh_U9_PWnI8wT9fA",
  };

  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
  const pageUrl = `https://www.youtube.com/@${handle}/live`;

  try {
    let html = "";
    let finalUrl = pageUrl;
    try {
      const r = await fetch(pageUrl, {
        headers: {
          "User-Agent": ua,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html",
        },
        redirect: "follow",
      });
      html = await r.text();
      finalUrl = r.url || pageUrl;
    } catch {
      /* scrape optional */
    }

    let channelId = KNOWN[handle] || "";
    const chPatterns = [
      /"channelId":"(UC[^"]+)"/,
      /"externalId":"(UC[^"]+)"/,
      /itemprop="channelId" content="(UC[^"]+)"/,
    ];
    for (const re of chPatterns) {
      const m = html.match(re);
      if (m) {
        channelId = m[1];
        break;
      }
    }
    if (!channelId) channelId = KNOWN[handle] || null;

    // Live video id: prefer redirect URL, then isLiveNow / videoDetails near live
    let videoId = "";
    const fromFinal = String(finalUrl).match(/(?:v=|\/live\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    if (fromFinal && !String(finalUrl).includes(`@${handle}`)) {
      videoId = fromFinal[1];
    }
    // Live-specific patterns (avoid random recommended videoIds)
    const livePatterns = [
      /"videoId":"([a-zA-Z0-9_-]{11})"[^]{0,400}"isLiveNow"\s*:\s*true/,
      /"isLiveNow"\s*:\s*true[^]{0,400}"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
      /"videoId":"([a-zA-Z0-9_-]{11})"[^]{0,400}"isLiveContent"\s*:\s*true/,
      /"isLiveContent"\s*:\s*true[^]{0,400}"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
      /"videoDetails":\{"videoId":"([a-zA-Z0-9_-]{11})"/,
      /canonicalUrl":"https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/,
      /"watchEndpoint":\{"videoId":"([a-zA-Z0-9_-]{11})"/,
    ];
    for (const re of livePatterns) {
      if (videoId) break;
      const m = html.match(re);
      if (m) videoId = m[1];
    }

    let title = "";
    const t = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    if (t) title = t[1];
    if (!title) {
      const t2 = html.match(/<title>([^<]+)<\/title>/i);
      if (t2) title = t2[1].replace(/\s*-\s*YouTube\s*$/i, "").trim();
    }

    // Specific live video embed is more reliable than live_stream?channel=
    // (channel embed often shows blank on mobile while /@handle/live works)
    const videoEmbed = videoId
      ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0`
      : null;
    const channelEmbed = channelId
      ? `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1&playsinline=1`
      : null;

    res.json({
      ok: true,
      handle,
      videoId: videoId || null,
      channelId: channelId || null,
      title: title || null,
      watchUrl: `https://www.youtube.com/@${handle}/live`,
      // Prefer concrete live video embed when we have it
      embedUrl: videoEmbed || channelEmbed,
      videoEmbedUrl: videoEmbed,
      channelEmbedUrl: channelEmbed,
      isLive: !!(videoId || channelId),
      finalUrl,
    });
  } catch (err) {
    const ch = KNOWN[handle] || null;
    res.status(200).json({
      ok: true,
      handle,
      channelId: ch,
      videoId: null,
      watchUrl: `https://www.youtube.com/@${handle}/live`,
      embedUrl: ch
        ? `https://www.youtube.com/embed/live_stream?channel=${ch}&autoplay=1&mute=1&playsinline=1`
        : null,
      channelEmbedUrl: ch
        ? `https://www.youtube.com/embed/live_stream?channel=${ch}&autoplay=1&mute=1&playsinline=1`
        : null,
      error: err.message || String(err),
    });
  }
});

app.use(
  express.static(PUBLIC, {
    maxAge: process.env.NODE_ENV === "production" ? "60s" : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".js") || filePath.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.sendFile(path.join(PUBLIC, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/stream" });

function sanitizeKey(key) {
  return String(key || "")
    .trim()
    .replace(/[^a-zA-Z0-9\-_=]/g, "");
}

function maskKey(key) {
  const k = String(key || "");
  if (k.length <= 6) return "••••";
  return `${k.slice(0, 3)}…${k.slice(-3)}`;
}

function humanFfmpegHint(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (s.includes("invalid data") || s.includes("error while decoding")) {
    return "Phone video format glitch — keep screen open; we will retry with a cleaner encode.";
  }
  if (s.includes("connection refused") || s.includes("unable to open") || s.includes("input/output error")) {
    return "Cannot reach YouTube. Check stream key and that Studio live is started.";
  }
  if (s.includes("403") || s.includes("authentication")) {
    return "YouTube rejected the stream key. Copy Stream key again from Studio.";
  }
  if (s.includes("broken pipe") || s.includes("end of file")) {
    return "Phone stopped sending (screen locked or app switched).";
  }
  return "Encoder stopped. Keep phone on this screen; check stream key + Studio Go live.";
}

wss.on("connection", (ws, req) => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let streamKey = "";
  let bytesIn = 0;
  /** @type {Buffer[]} */
  let queue = [];
  let queueBytes = 0;
  /** @type {null | { proc: import('child_process').ChildProcess, stderrBuf: string, started: boolean }} */
  let session = null;
  let startRequested = false;
  let tmpFile = "";

  console.log(`[ws] connect ${id} ${req.socket.remoteAddress}`);

  const send = (obj) => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* */
      }
    }
  };

  send({ type: "hello", ffmpeg: hasFfmpeg, youtubeRelay: hasFfmpeg, maxSessions: MAX_SESSIONS });

  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.ping();
      } catch {
        /* */
      }
      send({ type: "ping", t: Date.now() });
    }
  }, 15000);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        send({ type: "error", message: "Invalid JSON" });
        return;
      }
      handleControl(msg);
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytesIn += buf.length;
    queue.push(buf);
    queueBytes += buf.length;

    // Cap queue if ffmpeg not started yet
    while (queueBytes > 8 * 1024 * 1024 && queue.length > 1) {
      const drop = queue.shift();
      queueBytes -= drop.length;
    }

    if (startRequested && !session?.started && queueBytes >= START_BYTES) {
      startFfmpeg();
    } else if (session?.started && session.proc?.stdin?.writable) {
      drainQueueToFfmpeg();
    }
  });

  function drainQueueToFfmpeg() {
    if (!session?.proc?.stdin?.writable) return;
    while (queue.length) {
      const chunk = queue.shift();
      queueBytes -= chunk.length;
      try {
        const ok = session.proc.stdin.write(chunk);
        if (!ok) {
          queue.unshift(chunk);
          queueBytes += chunk.length;
          session.proc.stdin.once("drain", () => drainQueueToFfmpeg());
          return;
        }
      } catch (err) {
        console.warn(`[ws] ${id} write`, err.message);
        return;
      }
    }
  }

  function handleControl(msg) {
    if (msg.type === "ping") {
      send({ type: "pong", t: Date.now() });
      return;
    }
    if (msg.type === "pong") return;

    if (msg.type === "start") {
      if (startRequested) {
        send({ type: "error", message: "Session already started", code: "ALREADY" });
        return;
      }
      if (!hasFfmpeg) {
        send({ type: "error", message: "Server has no ffmpeg", code: "NO_FFMPEG" });
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        send({ type: "error", message: "Server busy — try again shortly", code: "BUSY" });
        return;
      }

      const rawKey = String(msg.streamKey || "").trim();
      if (/^https?:\/\//i.test(rawKey) || /youtube\.com|youtu\.be|studio\.youtube|livestreaming/i.test(rawKey)) {
        send({
          type: "error",
          code: "BAD_KEY_URL",
          message:
            "Stream key is a web link. Studio → Go live → Stream → copy Stream key only (xxxx-xxxx-…).",
        });
        return;
      }
      streamKey = sanitizeKey(rawKey);
      if (!streamKey || streamKey.length < 10 || (streamKey.length > 40 && !rawKey.includes("-"))) {
        send({
          type: "error",
          code: "BAD_KEY",
          message: "Valid YouTube stream key required (usually with dashes).",
        });
        return;
      }

      startRequested = true;
      send({
        type: "started",
        message: "Connected — waiting for video, then pushing to YouTube",
        key: maskKey(streamKey),
      });

      // If client already sent enough, start now
      if (queueBytes >= START_BYTES) startFfmpeg();
      // Fallback: start after 3s even with less data
      setTimeout(() => {
        if (startRequested && !session?.started && queueBytes > 8000) startFfmpeg();
      }, 3000);
      return;
    }

    if (msg.type === "stop") {
      cleanup("client stop");
    }
  }

  function startFfmpeg() {
    if (session?.started || !startRequested) return;

    const rtmpUrl = `${YT_RTMP_BASE.replace(/\/+$/, "")}/${streamKey}`;
    tmpFile = path.join(os.tmpdir(), `sw-stream-${id}.webm`);

    // Write buffered webm to temp file first (more reliable probe than pure pipe)
    try {
      fs.writeFileSync(tmpFile, Buffer.concat(queue));
      queue = [];
      queueBytes = 0;
    } catch (err) {
      send({ type: "error", message: "Could not buffer video: " + err.message });
      return;
    }

    // Append-only file + ffmpeg reading growing file is hard; use pipe from now
    // Restart approach: cat initial file into ffmpeg stdin, then more chunks
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-err_detect",
      "ignore_err",
      "-fflags",
      "+genpts+igndts+discardcorrupt",
      "-analyzeduration",
      "10000000",
      "-probesize",
      "5000000",
      "-f",
      "webm",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "50",
      "-b:v",
      "1200k",
      "-maxrate",
      "1500k",
      "-bufsize",
      "2000k",
      "-f",
      "flv",
      "-flvflags",
      "no_duration_filesize",
      rtmpUrl,
    ];

    console.log(`[ws] ${id} ffmpeg start key=${maskKey(streamKey)} initBytes=${fs.statSync(tmpFile).size}`);
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    session = { proc, stderrBuf: "", started: true };
    sessions.set(id, session);

    // Feed initial buffer then continue with live queue
    const init = fs.readFileSync(tmpFile);
    try {
      proc.stdin.write(init);
    } catch (e) {
      console.warn(`[ws] ${id} init write`, e.message);
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* */
    }
    tmpFile = "";

    proc.stderr.on("data", (b) => {
      const line = String(b);
      session.stderrBuf = (session.stderrBuf + line).slice(-5000);
      const t = line.trim();
      if (t) console.log(`[ffmpeg ${id}] ${t.slice(0, 350)}`);
      // Don't spam client on every "Invalid data" during recovery — only notable errors
      if (/rejected|unable to open|connection refused|403/i.test(line)) {
        send({ type: "warn", message: t.slice(0, 180) });
      }
    });

    proc.on("error", (err) => {
      send({ type: "error", message: "ffmpeg: " + err.message, code: "FFMPEG_SPAWN" });
    });

    proc.stdin.on("error", (err) => {
      console.warn(`[ffmpeg ${id}] stdin`, err.message);
    });

    proc.on("close", (code, signal) => {
      const hint = humanFfmpegHint(session?.stderrBuf);
      console.log(`[ffmpeg ${id}] exit ${code} ${signal} bytesIn=${bytesIn}`);
      lastStreamEvent = {
        at: new Date().toISOString(),
        message: hint,
        code,
        bytesIn,
        key: maskKey(streamKey),
        stderrTail: (session?.stderrBuf || "").slice(-600),
      };
      sessions.delete(id);
      session = null;
      send({
        type: "ended",
        code,
        bytesIn,
        message: code === 0 ? "Stream ended" : hint,
        recoverable: code !== 0,
      });
    });

    // Live chunks after init
    drainQueueToFfmpeg();
  }

  function cleanup(reason) {
    console.log(`[ws] ${id} cleanup ${reason} bytes=${bytesIn}`);
    clearInterval(pingTimer);
    startRequested = false;
    if (session?.proc) {
      try {
        session.proc.stdin.end();
      } catch {
        /* */
      }
      setTimeout(() => {
        try {
          session?.proc?.kill("SIGKILL");
        } catch {
          /* */
        }
      }, 800);
      sessions.delete(id);
      session = null;
    }
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* */
      }
      tmpFile = "";
    }
    queue = [];
    queueBytes = 0;
  }

  ws.on("close", () => cleanup("socket close"));
  ws.on("error", () => cleanup("socket error"));
});

server.listen(PORT, () => {
  console.log(`[scorers-window] :${PORT} relay=${hasFfmpeg}`);
});
