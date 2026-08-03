/**
 * Scorers Window — static app + WebSocket media relay → YouTube RTMP via ffmpeg
 *
 * Client sends MediaRecorder webm chunks over WS; we pipe to:
 *   ffmpeg -i pipe:0 -c:v libx264 -c:a aac -f flv rtmp://a.rtmp.youtube.com/live2/KEY
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
  });
});

// SPA + static assets
app.use(
  express.static(PUBLIC, {
    maxAge: process.env.NODE_ENV === "production" ? "60s" : 0,
    setHeaders(res, filePath) {
      if (filePath.includes("overlay") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// SPA fallback for non-file routes (hash routes still load index.html)
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.sendFile(path.join(PUBLIC, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/stream" });

/** @type {Map<string, { proc: import('child_process').ChildProcess, started: number }>} */
const sessions = new Map();

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

wss.on("connection", (ws, req) => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let session = null;
  let streamKey = "";
  let bytesIn = 0;

  console.log(`[ws] connect ${id} from ${req.socket.remoteAddress}`);

  ws.send(
    JSON.stringify({
      type: "hello",
      ffmpeg: hasFfmpeg,
      youtubeRelay: hasFfmpeg,
      maxSessions: MAX_SESSIONS,
    })
  );

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON control message" }));
        return;
      }
      handleControl(msg);
      return;
    }

    // Binary = media chunk
    if (!session?.proc?.stdin?.writable) return;
    bytesIn += data.length;
    try {
      session.proc.stdin.write(data);
    } catch (err) {
      console.warn(`[ws] ${id} write error`, err.message);
    }
  });

  function handleControl(msg) {
    if (msg.type === "start") {
      if (session) {
        ws.send(JSON.stringify({ type: "error", message: "Session already started" }));
        return;
      }
      if (!hasFfmpeg) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Server has no ffmpeg — YouTube relay unavailable on this host",
            code: "NO_FFMPEG",
          })
        );
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Too many concurrent streams on this server",
            code: "BUSY",
          })
        );
        return;
      }

      streamKey = sanitizeKey(msg.streamKey);
      if (!streamKey || streamKey.length < 8) {
        ws.send(JSON.stringify({ type: "error", message: "Valid YouTube stream key required", code: "BAD_KEY" }));
        return;
      }

      const rtmpUrl = `${YT_RTMP_BASE.replace(/\/+$/, "")}/${streamKey}`;
      const args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-fflags",
        "+genpts",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "60",
        "-b:v",
        "2500k",
        "-maxrate",
        "2800k",
        "-bufsize",
        "5000k",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-f",
        "flv",
        rtmpUrl,
      ];

      console.log(`[ws] ${id} starting ffmpeg → YouTube key ${maskKey(streamKey)}`);
      const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
      session = { proc, started: Date.now() };
      sessions.set(id, session);

      proc.stderr.on("data", (buf) => {
        const line = String(buf).trim();
        if (line) console.log(`[ffmpeg ${id}] ${line.slice(0, 300)}`);
      });

      proc.on("error", (err) => {
        console.error(`[ffmpeg ${id}] spawn error`, err.message);
        ws.send(JSON.stringify({ type: "error", message: `ffmpeg: ${err.message}`, code: "FFMPEG_SPAWN" }));
      });

      proc.on("close", (code, signal) => {
        console.log(`[ffmpeg ${id}] exit code=${code} signal=${signal} bytesIn=${bytesIn}`);
        sessions.delete(id);
        session = null;
        try {
          ws.send(
            JSON.stringify({
              type: "ended",
              code,
              signal,
              bytesIn,
              message: code === 0 ? "Stream ended" : `Encoder exited (${code})`,
            })
          );
        } catch {
          /* closed */
        }
      });

      ws.send(
        JSON.stringify({
          type: "started",
          message: "Relaying to YouTube — keep this page open",
          key: maskKey(streamKey),
        })
      );
      return;
    }

    if (msg.type === "stop") {
      stopSession("client stop");
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
    }
  }

  function stopSession(reason) {
    console.log(`[ws] ${id} stop (${reason}) bytesIn=${bytesIn}`);
    if (session?.proc) {
      try {
        session.proc.stdin.end();
      } catch {
        /* */
      }
      try {
        session.proc.kill("SIGTERM");
      } catch {
        /* */
      }
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
