/**
 * Scorers Window — static app + WebSocket media relay → YouTube RTMP via ffmpeg
 *
 * Client sends MediaRecorder webm chunks over WS; we pipe to ffmpeg → YouTube.
 */
const http = require("http");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "..", "public");
const YT_RTMP_BASE = process.env.YT_RTMP_BASE || "rtmp://a.rtmp.youtube.com/live2";
const MAX_SESSIONS = Number(process.env.MAX_STREAM_SESSIONS || 3);

function ffmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = ffmpegAvailable();
console.log(`[scorers-window] ffmpeg: ${hasFfmpeg ? "ok" : "MISSING — YouTube relay disabled"}`);

const app = express();
app.disable("x-powered-by");

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

app.use(
  express.static(PUBLIC, {
    maxAge: process.env.NODE_ENV === "production" ? "60s" : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.includes("overlay")) {
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

/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {{ at: string, message: string, code?: number, bytesIn?: number } | null} */
let lastStreamEvent = null;

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
  if (s.includes("error number -10053") || s.includes("connection refused") || s.includes("unable to open")) {
    return "Cannot reach YouTube RTMP. Check stream key and that Studio live is started.";
  }
  if (s.includes("403") || s.includes("authentication") || s.includes("failed to update header")) {
    return "YouTube rejected the stream key. Reset key in Studio or create a new live.";
  }
  if (s.includes("invalid data") || s.includes("could not find codec") || s.includes("ebml")) {
    return "Bad video format from phone. Try Chrome/Edge; leave screen open.";
  }
  if (s.includes("broken pipe") || s.includes("end of file")) {
    return "Phone stopped sending video (tab backgrounded or network drop).";
  }
  return "Encoder stopped. Keep the phone on this screen; check stream key + Studio Go live.";
}

wss.on("connection", (ws, req) => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  /** @type {null | { proc: import('child_process').ChildProcess, stderrBuf: string }} */
  let session = null;
  let streamKey = "";
  let bytesIn = 0;
  let prebuffer = [];
  let prebufferBytes = 0;
  const PREBUF_MAX = 2 * 1024 * 1024;

  console.log(`[ws] connect ${id} from ${req.socket.remoteAddress}`);

  const send = (obj) => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* */
      }
    }
  };

  send({
    type: "hello",
    ffmpeg: hasFfmpeg,
    youtubeRelay: hasFfmpeg,
    maxSessions: MAX_SESSIONS,
  });

  // Keepalive — Render/proxies drop idle sockets
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
        send({ type: "error", message: "Invalid JSON control message" });
        return;
      }
      handleControl(msg);
      return;
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytesIn += buf.length;

    if (!session?.proc) {
      // Buffer until ffmpeg is ready
      if (prebufferBytes + buf.length < PREBUF_MAX) {
        prebuffer.push(buf);
        prebufferBytes += buf.length;
      }
      return;
    }

    const stdin = session.proc.stdin;
    if (!stdin || !stdin.writable) return;
    try {
      const ok = stdin.write(buf);
      if (!ok) {
        // pause not available on ws easily; drop pressure by waiting for drain
        stdin.once("drain", () => {});
      }
    } catch (err) {
      console.warn(`[ws] ${id} write error`, err.message);
    }
  });

  function flushPrebuffer() {
    if (!session?.proc?.stdin?.writable || !prebuffer.length) return;
    for (const chunk of prebuffer) {
      try {
        session.proc.stdin.write(chunk);
      } catch {
        /* */
      }
    }
    prebuffer = [];
    prebufferBytes = 0;
  }

  function handleControl(msg) {
    if (msg.type === "pong" || msg.type === "ping") {
      if (msg.type === "ping") send({ type: "pong", t: Date.now() });
      return;
    }

    if (msg.type === "start") {
      if (session) {
        send({ type: "error", message: "Session already started", code: "ALREADY" });
        return;
      }
      if (!hasFfmpeg) {
        send({
          type: "error",
          message: "Server has no ffmpeg — YouTube relay unavailable on this host",
          code: "NO_FFMPEG",
        });
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        send({
          type: "error",
          message: "Too many concurrent streams on this server. Try again in a minute.",
          code: "BUSY",
        });
        return;
      }

      streamKey = sanitizeKey(msg.streamKey);
      if (!streamKey || streamKey.length < 8) {
        send({ type: "error", message: "Valid YouTube stream key required", code: "BAD_KEY" });
        return;
      }

      const rtmpUrl = `${YT_RTMP_BASE.replace(/\/+$/, "")}/${streamKey}`;
      // MediaRecorder WebM (often video-only). Re-encode H.264 → FLV for YouTube.
      // -use_wallclock_as_timestamps helps with chunked live webm from browsers.
      const args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-fflags",
        "+genpts+igndts+nobuffer",
        "-use_wallclock_as_timestamps",
        "1",
        "-thread_queue_size",
        "1024",
        "-f",
        "webm",
        "-i",
        "pipe:0",
        "-an", // phone publish is video-only for stability
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-level",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "50",
        "-keyint_min",
        "25",
        "-b:v",
        "1500k",
        "-maxrate",
        "1800k",
        "-bufsize",
        "3000k",
        "-f",
        "flv",
        "-flvflags",
        "no_duration_filesize",
        rtmpUrl,
      ];

      console.log(`[ws] ${id} starting ffmpeg → YouTube key ${maskKey(streamKey)}`);
      const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
      session = { proc, stderrBuf: "" };
      sessions.set(id, session);

      proc.stderr.on("data", (b) => {
        const line = String(b);
        session.stderrBuf = (session.stderrBuf + line).slice(-4000);
        const t = line.trim();
        if (t) console.log(`[ffmpeg ${id}] ${t.slice(0, 400)}`);
        // Surface useful progress/errors
        if (/error|failed|invalid|denied|unable|refused/i.test(line)) {
          send({
            type: "warn",
            message: t.slice(0, 200),
          });
        }
      });

      proc.on("error", (err) => {
        console.error(`[ffmpeg ${id}] spawn error`, err.message);
        send({ type: "error", message: `ffmpeg: ${err.message}`, code: "FFMPEG_SPAWN" });
      });

      proc.stdin.on("error", (err) => {
        console.warn(`[ffmpeg ${id}] stdin`, err.message);
      });

      proc.on("close", (code, signal) => {
        const hint = humanFfmpegHint(session?.stderrBuf);
        console.log(`[ffmpeg ${id}] exit code=${code} signal=${signal} bytesIn=${bytesIn} hint=${hint}`);
        lastStreamEvent = {
          at: new Date().toISOString(),
          message: hint,
          code,
          signal,
          bytesIn,
          key: maskKey(streamKey),
          stderrTail: (session?.stderrBuf || "").slice(-500),
        };
        sessions.delete(id);
        session = null;
        send({
          type: "ended",
          code,
          signal,
          bytesIn,
          message: code === 0 ? "Stream ended cleanly" : hint,
          recoverable: code !== 0,
        });
      });

      // Let client start sending immediately
      send({
        type: "started",
        message: "Relaying to YouTube — keep this screen open and unlocked",
        key: maskKey(streamKey),
      });
      // Small delay then flush any early chunks
      setTimeout(() => flushPrebuffer(), 50);
      return;
    }

    if (msg.type === "stop") {
      stopSession("client stop");
      return;
    }
  }

  function stopSession(reason) {
    console.log(`[ws] ${id} stop (${reason}) bytesIn=${bytesIn}`);
    clearInterval(pingTimer);
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
      }, 1500);
      sessions.delete(id);
      session = null;
    }
  }

  ws.on("close", () => stopSession("socket close"));
  ws.on("error", () => stopSession("socket error"));
});

server.listen(PORT, () => {
  console.log(`[scorers-window] http://0.0.0.0:${PORT}  relay=${hasFfmpeg}`);
});
