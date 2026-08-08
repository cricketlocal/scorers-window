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
 * Proxy Cricket Local hub APIs (same-origin for Moblin WebView — more reliable
 * than cross-origin fetch + CDN cache).
 * GET /api/live/match?matchId=&site=
 * GET /api/live/hub
 * GET /api/matchday/scoreboard?club=
 */
const HUB_UPSTREAM = (process.env.HUB_URL || "https://cricket-local-v5-1.onrender.com").replace(
  /\/+$/,
  ""
);

async function proxyHub(req, res, hubPath) {
  try {
    const qs = new URLSearchParams(req.query);
    qs.set("_", String(Date.now()));
    const url = `${HUB_UPSTREAM}${hubPath}?${qs.toString()}`;
    const r = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      cache: "no-store",
    });
    const text = await r.text();
    res.status(r.status);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Access-Control-Allow-Origin", "*");
    res.type("json").send(text);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
}

app.get("/api/live/match", (req, res) => proxyHub(req, res, "/api/live/match"));
app.get("/api/live/hub", (req, res) => proxyHub(req, res, "/api/live/hub"));
app.get("/api/live/status", (req, res) => proxyHub(req, res, "/api/live/status"));
app.get("/api/matchday/scoreboard", (req, res) =>
  proxyHub(req, res, "/api/matchday/scoreboard")
);

/**
 * Reliable Moblin/OBS scoreboard (NO client JS timers).
 * Full page reload every N seconds via meta refresh — works when WebViews freeze setInterval.
 *
 * GET /scoreboard
 * GET /scoreboard?matchId=7236091&site=https://lpcc.play-cricket.com&refresh=120
 *
 * Point Moblin Browser widget here (not #/overlay SPA).
 */
const DEFAULT_OVERLAY_MATCH = {
  matchId: "7236091",
  site: "https://lpcc.play-cricket.com",
  homeTeam: "Lullington Park CC - 2nd XI",
  awayTeam: "Rosehill CC - 1st XI",
};

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortTeamName(name) {
  let n = String(name || "").trim();
  n = n.replace(/\s*CC\s*/gi, " ").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim();
  if (n.length > 28) n = n.slice(0, 26) + "…";
  return n || "—";
}

function pickScoreVal(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const s = String(v).trim();
    if (s && s !== "–" && s !== "-" && s !== "—") return s;
  }
  return "—";
}

async function fetchMatchForOverlay(matchId, site) {
  const qs = new URLSearchParams({
    matchId: String(matchId),
    site: String(site || DEFAULT_OVERLAY_MATCH.site),
    _: String(Date.now()),
  });
  const url = `${HUB_UPSTREAM}/api/live/match?${qs}`;
  const r = await fetch(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`hub ${r.status}`);
  return r.json();
}

function renderScoreboardHtml(data, opts = {}) {
  const refresh = Math.max(30, Math.min(600, Number(opts.refresh) || 120));
  const home = shortTeamName(data.homeTeam || DEFAULT_OVERLAY_MATCH.homeTeam);
  const away = shortTeamName(data.awayTeam || DEFAULT_OVERLAY_MATCH.awayTeam);
  const hs = pickScoreVal(data.homeScore, data.summary?.homeScore);
  const as = pickScoreVal(data.awayScore, data.summary?.awayScore);
  const live = !!(data.live || data.summary?.live);
  const status = data.status || data.summary?.status || (live ? "Match In Progress" : "Scoreboard");
  const badge = live ? "LIVE" : "MATCH";
  const updated = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const mid = data.matchId || data.id || opts.matchId || "";

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="${refresh}" />
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
  <title>Scoreboard ${escHtml(mid)}</title>
  <style>
    html, body { margin: 0; padding: 0; background: transparent; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #ecfdf5; }
    .bar {
      margin: 0 2% 2.5%;
      padding: 10px 14px 12px;
      border-radius: 12px;
      background: rgba(6, 20, 13, 0.88);
      border: 1px solid rgba(74, 222, 128, 0.45);
      box-shadow: 0 6px 24px rgba(0,0,0,0.45);
    }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
    .live { font-size: 0.65rem; font-weight: 800; letter-spacing: 0.08em; color: #fca5a5; }
    .live::before {
      content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: #ef4444; box-shadow: 0 0 6px #ef4444; margin-right: 5px; vertical-align: middle;
    }
    .status { font-size: 0.7rem; color: #a7f3d0; opacity: 0.95; text-align: right; max-width: 60%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .teams { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
    .name { font-size: clamp(0.9rem, 2.2vw, 1.15rem); font-weight: 800; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .away { text-align: right; }
    .score { font-size: clamp(1.2rem, 3vw, 1.65rem); font-weight: 800; font-variant-numeric: tabular-nums; color: #4ade80; }
    .vs { font-size: 0.75rem; font-weight: 800; opacity: 0.7; }
    .foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px;
      font-size: 0.65rem; color: #86efac; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="bar" data-match-id="${escHtml(mid)}">
    <div class="top">
      <span class="live">${escHtml(badge)}</span>
      <span class="status">${escHtml(status)}</span>
    </div>
    <div class="teams">
      <div>
        <div class="name">${escHtml(home)}</div>
        <div class="score">${escHtml(hs)}</div>
      </div>
      <div class="vs">VS</div>
      <div class="away">
        <div class="name">${escHtml(away)}</div>
        <div class="score">${escHtml(as)}</div>
      </div>
    </div>
    <div class="foot">
      <span>LPCC · Play-Cricket #${escHtml(mid)}</span>
      <span>Updated ${escHtml(updated)} · every ${refresh}s</span>
    </div>
  </div>
</body>
</html>`;
}

app.get("/scoreboard", async (req, res) => {
  const matchId = String(req.query.matchId || DEFAULT_OVERLAY_MATCH.matchId);
  const site = String(req.query.site || DEFAULT_OVERLAY_MATCH.site);
  const refresh = Number(req.query.refresh || 120);
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  try {
    const data = await fetchMatchForOverlay(matchId, site);
    res.type("html").send(
      renderScoreboardHtml(data, { refresh, matchId })
    );
  } catch (e) {
    // Still show teams so stream isn't blank
    res.type("html").send(
      renderScoreboardHtml(
        {
          matchId,
          homeTeam: DEFAULT_OVERLAY_MATCH.homeTeam,
          awayTeam: DEFAULT_OVERLAY_MATCH.awayTeam,
          homeScore: "—",
          awayScore: "—",
          live: false,
          status: `Waiting for scores (${e.message || "hub error"})`,
        },
        { refresh, matchId }
      )
    );
  }
});

/**
 * Resolve @handle live for in-app embed.
 * IMPORTANT: never rely on embed/live_stream?channel= — YouTube often shows a
 * different (or blank) stream than youtube.com/@handle/live. Always embed the
 * concrete videoId from the channel /live page (or RSS latest live stream).
 * GET /api/youtube/channel-live?handle=LullingtonLive
 */
const YT_KNOWN = {
  LullingtonLive: "UCR4PqiyQh_U9_PWnI8wT9fA",
};
const YT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
// Bypass EU consent interstitial that strips ytInitialPlayerResponse
const YT_COOKIE =
  "CONSENT=YES+cb.20210328-17-p0.en+FX+123; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJnPpwY";

function parseYtPlayerResponse(html) {
  const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{)/);
  if (!prMatch) return null;
  const start = prMatch.index + prMatch[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length && i < start + 2_000_000; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end <= start) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

function extractVideoIdFromHtml(html, finalUrl) {
  let videoId = "";
  let title = "";
  let isLive = false;

  const pr = parseYtPlayerResponse(html);
  if (pr?.videoDetails?.videoId) {
    videoId = String(pr.videoDetails.videoId);
    title = pr.videoDetails.title || "";
    const live = pr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
    if (live && typeof live.isLiveNow === "boolean") {
      isLive = !!live.isLiveNow;
    } else {
      isLive = !!(pr.videoDetails.isLive || pr.videoDetails.isUpcoming);
    }
  }

  if (!videoId) {
    const fromFinal = String(finalUrl || "").match(/(?:[?&]v=|\/live\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (fromFinal) videoId = fromFinal[1];
  }

  if (!videoId) {
    const patterns = [
      /"isLiveNow"\s*:\s*true[\s\S]{0,400}?"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
      /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"[\s\S]{0,400}?"isLiveNow"\s*:\s*true/,
      /"videoDetails"\s*:\s*\{\s*"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
      /"VIDEO_ID"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
      /"currentVideoEndpoint"[^}]{0,200}"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1] && m[1] !== "live_stream") {
        videoId = m[1];
        if (/isLiveNow/.test(re.source)) isLive = true;
        break;
      }
    }
  }

  // Any 11-char videoId near live badge (channel /live pages sometimes omit full PR)
  if (!videoId) {
    const ids = [...html.matchAll(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g)].map((m) => m[1]);
    const uniq = [...new Set(ids)].filter((id) => id !== "live_stream");
    if (uniq.length === 1) videoId = uniq[0];
    else if (uniq.length > 1 && /isLiveNow"\s*:\s*true/.test(html)) {
      const near = html.match(/"isLiveNow"\s*:\s*true[\s\S]{0,800}?"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
      if (near) {
        videoId = near[1];
        isLive = true;
      }
    }
  }

  if (!title) {
    const t = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    if (t) title = t[1];
  }
  if (!title) {
    const t2 = html.match(/<title>([^<]+)<\/title>/i);
    if (t2) title = t2[1].replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }
  if (title === "Keyboard shortcuts" || /consent|before you continue/i.test(title || "")) {
    title = "";
  }

  return { videoId, title, isLive };
}

async function ytFetch(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": YT_UA,
      "Accept-Language": "en-GB,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
      Cookie: YT_COOKIE,
    },
    redirect: "follow",
  });
  const html = await r.text();
  return { html, finalUrl: r.url || url, status: r.status };
}

async function ytRssLatest(channelId) {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      headers: { "User-Agent": YT_UA, Accept: "application/atom+xml,application/xml,text/xml" },
    });
    const xml = await r.text();
    const id = (xml.match(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/) || [])[1] || "";
    const titles = [...xml.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    // first title is channel name; second is latest video
    const title = titles[1] || titles[0] || "";
    return { videoId: id, title };
  } catch {
    return { videoId: "", title: "" };
  }
}

async function ytWatchMeta(videoId) {
  try {
    const { html } = await ytFetch(`https://www.youtube.com/watch?v=${videoId}`);
    const pr = parseYtPlayerResponse(html);
    if (!pr?.videoDetails) {
      const loose = extractVideoIdFromHtml(html, "");
      return { title: loose.title || "", isLive: loose.isLive };
    }
    const live = pr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
    return {
      title: pr.videoDetails.title || "",
      isLive: live ? !!live.isLiveNow : !!(pr.videoDetails.isLive || pr.videoDetails.isUpcoming),
    };
  } catch {
    return { title: "", isLive: false };
  }
}

app.get("/api/youtube/channel-live", async (req, res) => {
  const handle = String(req.query.handle || "LullingtonLive")
    .replace(/^@/, "")
    .replace(/[^\w.-]/g, "");
  if (!handle) return res.status(400).json({ ok: false, error: "handle required" });

  const channelId = YT_KNOWN[handle] || null;
  const watchUrl = `https://www.youtube.com/@${handle}/live`;

  try {
    let videoId = "";
    let title = "";
    let isLive = false;
    let finalUrl = watchUrl;
    let source = "";

    // 1) /channel/UC…/live is more reliable than /@handle/live (less consent junk)
    const pageUrls = [];
    if (channelId) pageUrls.push(`https://www.youtube.com/channel/${channelId}/live`);
    pageUrls.push(watchUrl);

    for (const pageUrl of pageUrls) {
      try {
        const page = await ytFetch(pageUrl);
        finalUrl = page.finalUrl;
        const extracted = extractVideoIdFromHtml(page.html, page.finalUrl);
        if (extracted.videoId) {
          videoId = extracted.videoId;
          title = extracted.title;
          isLive = extracted.isLive;
          source = pageUrl;
          break;
        }
      } catch (e) {
        console.warn("[channel-live] page fetch", pageUrl, e.message);
      }
    }

    // 2) RSS latest upload (works when HTML scrape is empty; often the live stream VOD)
    if (!videoId && channelId) {
      const rss = await ytRssLatest(channelId);
      if (rss.videoId) {
        videoId = rss.videoId;
        title = rss.title || title;
        source = "rss";
      }
    }

    // 3) Confirm live flag + title from watch page (same player as /live when that id is active)
    if (videoId) {
      const meta = await ytWatchMeta(videoId);
      if (meta.title) title = meta.title;
      // Only trust isLive from watch page when we could read it; keep earlier true
      if (meta.isLive) isLive = true;
      else if (source === "rss") isLive = false;
      else isLive = meta.isLive;
    }

    // Concrete video embed only — channel live_stream embed is intentionally omitted
    // (YouTube serves a different/blank stream than @handle/live for many channels)
    const videoEmbed = videoId
      ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0`
      : null;

    res.json({
      ok: true,
      handle,
      videoId: videoId || null,
      channelId: channelId || null,
      title: title || null,
      watchUrl,
      embedUrl: videoEmbed,
      videoEmbedUrl: videoEmbed,
      channelEmbedUrl: null,
      isLive: !!(videoId && isLive),
      finalUrl,
      source: source || null,
    });
  } catch (err) {
    res.status(200).json({
      ok: true,
      handle,
      channelId,
      videoId: null,
      title: null,
      watchUrl,
      embedUrl: null,
      videoEmbedUrl: null,
      channelEmbedUrl: null,
      isLive: false,
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
