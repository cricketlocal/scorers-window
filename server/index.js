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

const youtubeOauth = require("./youtube-oauth");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

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
 * Full page reload via meta refresh — works when WebViews freeze setInterval.
 *
 * 4-panel rotation over a 2-minute cycle (12 × 10s slots):
 *   slots 0–8 (75%)  → 1) scores totals (main board)
 *   slot  9   (~8%)  → 2) batters totals
 *   slot 10   (~8%)  → 3) bowlers / balls
 *   slot 11   (~8%)  → 4) run-rate graph + RRR needed
 *
 * GET /scoreboard
 * GET /scoreboard?matchId=7236091&refresh=10
 * (#/overlay redirects here)
 */
const DEFAULT_OVERLAY_MATCH = {
  matchId: "7236095",
  site: "https://lpcc.play-cricket.com",
  homeTeam: "Lullington Park CC - 2nd XI",
  awayTeam: "Hilton CC, Derbyshire - 2nd XI",
};
/** Seconds per panel; 12 panels = 120s cycle (~75% score) */
const OVERLAY_SLOT_SECS = 10;
const OVERLAY_CYCLE_SLOTS = 12;

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

function shortPlayerName(name) {
  const n = String(name || "").replace(/\*|&dagger;|†/g, "").trim();
  if (!n) return "—";
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0];
  return `${parts[0].charAt(0)}. ${parts[parts.length - 1]}`;
}

function pickScoreVal(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const s = String(v).trim();
    if (s && s !== "–" && s !== "-" && s !== "—") return s;
  }
  return "—";
}

/** Parse "126 / 4 (27)" → { runs, wkts, overs } */
function parseScoreLine(line) {
  const s = String(line || "").trim();
  const m = s.match(/(\d+)\s*\/\s*(\d+)(?:\s*\(([^)]+)\))?/);
  if (!m) {
    const runsOnly = s.match(/^(\d+)/);
    return { runs: runsOnly ? runsOnly[1] : null, wkts: null, overs: null, raw: s };
  }
  return { runs: m[1], wkts: m[2], overs: m[3] || null, raw: s };
}

function currentInnings(data) {
  const list = data?.scorecard?.innings;
  if (!Array.isArray(list) || !list.length) return null;
  return list[list.length - 1];
}

function extractBatters(inn) {
  if (!inn?.batting) return [];
  return inn.batting
    .filter((b) => b && !b.didNotBat)
    .filter((b) => b.notOut || /not\s*out/i.test(String(b.howOut || "")))
    .slice(0, 2)
    .map((b) => ({
      name: shortPlayerName(b.name),
      runs: b.runs != null && b.runs !== "" ? String(b.runs) : "—",
      balls: b.balls != null && b.balls !== "" ? String(b.balls) : "—",
      sr: b.strikeRate != null && b.strikeRate !== "" ? String(b.strikeRate) : "",
    }));
}

function extractBowlers(inn) {
  if (!inn?.bowling) return [];
  // Prefer bowlers with overs in current spell (most recent non-zero)
  return [...inn.bowling]
    .filter((b) => b && b.name)
    .sort((a, b) => Number(b.overs || 0) - Number(a.overs || 0))
    .slice(0, 3)
    .map((b) => ({
      name: shortPlayerName(b.name),
      figures: `${b.wickets ?? 0}-${b.runs ?? 0}`,
      overs: b.overs != null ? String(b.overs) : "—",
      econ: b.economy != null && b.economy !== "" ? String(b.economy) : "",
      maidens: b.maidens != null && b.maidens !== "" ? String(b.maidens) : "",
    }));
}

function oversToBalls(ov) {
  if (ov == null || ov === "") return null;
  const s = String(ov).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const whole = Number(m[1]);
  const part = Number(m[2] || 0);
  // Cricket: 20.3 = 20 overs + 3 balls
  const balls = part > 5 ? Math.min(part, 5) : part;
  return whole * 6 + balls;
}

function ballsToOversDisplay(balls) {
  if (balls == null || balls < 0) return null;
  const o = Math.floor(balls / 6);
  const b = balls % 6;
  return b ? `${o}.${b}` : String(o);
}

function guessMaxOvers(data) {
  const blob = [
    data?.homeTeam,
    data?.awayTeam,
    data?.divisionName,
    data?.summary?.divisionName,
    data?.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\bt20\b|twenty20|20 overs/.test(blob)) return 20;
  if (/\bu11\b|\bu13\b|\bu9\b|kwik/.test(blob)) return 20;
  if (/\bu15\b|\bu17\b/.test(blob)) return 20;
  // Default senior limited overs (DCCL-style)
  return 45;
}

/**
 * Chase / RRR when second innings is in progress.
 * Returns { target, need, remOvers, rrr, curRr, battingSide } or null.
 */
function extractChaseInfo(data, hs, as) {
  const inns = data?.scorecard?.innings;
  if (!Array.isArray(inns) || inns.length < 1) return null;
  const first = inns[0];
  const second = inns.length >= 2 ? inns[inns.length - 1] : null;
  // First innings total from batting card if possible
  let firstTotal = null;
  if (first?.batting && Array.isArray(first.batting)) {
    // Prefer explicit total on innings
  }
  if (first?.runs != null && first.runs !== "") firstTotal = Number(first.runs);
  if (firstTotal == null && first?.total != null) firstTotal = Number(first.total);
  // Fall back: the side that is NOT currently "active" may have full score in home/away
  const hp = parseScoreLine(hs);
  const ap = parseScoreLine(as);
  // Heuristic: if one side is all out or has more overs completed as "first"
  if (firstTotal == null) {
    // Use higher completed innings or the non-chasing score from labels
    const homeAllOut = /all\s*out/i.test(String(hs));
    const awayAllOut = /all\s*out/i.test(String(as));
    if (homeAllOut && hp.runs != null) firstTotal = Number(hp.runs);
    else if (awayAllOut && ap.runs != null) firstTotal = Number(ap.runs);
    else if (inns.length >= 2) {
      // Prefer the first score line that has overs matching first innings team
      if (hp.runs != null && ap.runs != null) {
        // Second innings is usually the lower overs count if still batting
        const hBalls = oversToBalls(hp.overs) || 0;
        const aBalls = oversToBalls(ap.overs) || 0;
        if (hBalls && aBalls) {
          firstTotal = hBalls >= aBalls ? Number(hp.runs) : Number(ap.runs);
        }
      }
    }
  }
  if (firstTotal == null || Number.isNaN(firstTotal)) return null;

  const target = firstTotal + 1;
  // Current batting total = second innings score
  let cur = null;
  let battingSide = "chase";
  if (second) {
    // Match second innings team to home/away scores
    const team = String(second.team || "").toLowerCase();
    const homeT = String(data.homeTeam || "").toLowerCase();
    const awayT = String(data.awayTeam || "").toLowerCase();
    if (team && homeT.includes(team.slice(0, 12))) {
      cur = hp;
      battingSide = "home";
    } else if (team && awayT.includes(team.slice(0, 12))) {
      cur = ap;
      battingSide = "away";
    }
  }
  if (!cur || cur.runs == null) {
    // Pick the side with fewer balls faced as "current" if both set
    const hB = oversToBalls(hp.overs);
    const aB = oversToBalls(ap.overs);
    if (hB != null && aB != null) {
      if (hB <= aB) {
        cur = hp;
        battingSide = "home";
      } else {
        cur = ap;
        battingSide = "away";
      }
    } else if (hp.runs != null && !/all\s*out/i.test(String(hs))) {
      cur = hp;
      battingSide = "home";
    } else if (ap.runs != null) {
      cur = ap;
      battingSide = "away";
    }
  }
  if (!cur || cur.runs == null) return null;

  const need = Math.max(0, target - Number(cur.runs));
  const maxOv = guessMaxOvers(data);
  const facedBalls = oversToBalls(cur.overs);
  const maxBalls = maxOv * 6;
  const remBalls =
    facedBalls != null ? Math.max(0, maxBalls - facedBalls) : null;
  const remOvers = remBalls != null ? remBalls / 6 : null;
  const rrr =
    remOvers != null && remOvers > 0 ? need / remOvers : need > 0 ? null : 0;
  const curRr =
    cur.overs && Number(cur.runs) >= 0
      ? runRateFromScore(
          `${cur.runs} / ${cur.wkts || 0} (${cur.overs})`
        )
      : null;

  return {
    target,
    need,
    remOvers: remOvers != null ? Number(remOvers.toFixed(1)) : null,
    remOversDisplay: remBalls != null ? ballsToOversDisplay(remBalls) : null,
    rrr: rrr != null && Number.isFinite(rrr) ? rrr : null,
    curRr,
    battingSide,
    maxOvers: maxOv,
  };
}

function buildMatchStats(data, hs, as) {
  const inn = currentInnings(data);
  const batting = parseScoreLine(as !== "—" && as ? as : hs);
  // If only one side has a real score, use that as "current"
  const cur =
    as !== "—" && as && as !== "0 / 0 (0)"
      ? { side: "away", ...parseScoreLine(as) }
      : { side: "home", ...parseScoreLine(hs) };
  const rows = [];
  if (cur.runs != null) rows.push({ label: "Score", value: cur.wkts != null ? `${cur.runs}/${cur.wkts}` : cur.runs });
  if (cur.overs) rows.push({ label: "Overs", value: cur.overs });
  if (cur.runs != null && cur.overs) {
    const ov = parseFloat(String(cur.overs).replace(/[^0-9.]/g, ""));
    if (ov > 0) {
      const rr = (Number(cur.runs) / ov).toFixed(2);
      rows.push({ label: "Run rate", value: rr });
    }
  }
  if (inn?.extras != null && inn.extras !== "") {
    rows.push({ label: "Extras", value: String(inn.extras).replace(/\s+/g, " ").slice(0, 24) });
  }
  if (inn?.fallOfWickets?.length) {
    const last = inn.fallOfWickets[inn.fallOfWickets.length - 1];
    if (last?.score) rows.push({ label: "Last wicket", value: String(last.score) });
  }
  const div = data.divisionName || data.summary?.divisionName || "";
  if (div) rows.push({ label: "Competition", value: String(div).slice(0, 36) });
  if (!rows.length) {
    rows.push({ label: "Status", value: data.status || "Waiting for live scoring" });
  }
  return rows.slice(0, 5);
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

/**
 * Panel for this moment (12-slot cycle):
 * 0–8 score (75%), 9 batters, 10 bowlers, 11 runrate
 */
function overlayPanelIndex(nowMs = Date.now()) {
  const slot = Math.floor(nowMs / (OVERLAY_SLOT_SECS * 1000)) % OVERLAY_CYCLE_SLOTS;
  if (slot <= 8) return "score";
  if (slot === 9) return "batters";
  if (slot === 10) return "bowlers";
  return "runrate";
}

/** Run rate from score line e.g. "126 / 4 (27)" → 4.67 */
function runRateFromScore(line) {
  const p = parseScoreLine(line);
  if (p.runs == null || !p.overs) return null;
  const ov = parseFloat(String(p.overs).replace(/[^0-9.]/g, ""));
  if (!ov || ov <= 0 || Number.isNaN(ov)) return null;
  return Number(p.runs) / ov;
}

function overlayShellCss() {
  return `
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      background: transparent;
    }
    html { height: 100%; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #ecfdf5;
      min-height: 100vh;
      min-height: 100dvh;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      align-items: stretch;
      box-sizing: border-box;
    }
    /* Full-width bar pinned to bottom of the widget window */
    .bar {
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      margin: 0;
      padding: 12px 14px calc(10px + env(safe-area-inset-bottom, 0px));
      border-radius: 0;
      background: rgba(6, 20, 13, 0.92);
      border: none;
      border-top: 2px solid rgba(74, 222, 128, 0.55);
      box-shadow: 0 -8px 28px rgba(0,0,0,0.5);
    }
    .top {
      display: flex; justify-content: space-between; align-items: center;
      gap: 10px; margin-bottom: 8px;
    }
    .live {
      font-size: clamp(0.85rem, 3.2vw, 1.05rem);
      font-weight: 900; letter-spacing: 0.1em; color: #fecaca;
    }
    .live::before {
      content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 50%;
      background: #ef4444; box-shadow: 0 0 8px #ef4444; margin-right: 7px; vertical-align: middle;
    }
    .live.stats { color: #93c5fd; }
    .live.stats::before { background: #3b82f6; box-shadow: 0 0 8px #3b82f6; }
    .live.players { color: #fde68a; }
    .live.players::before { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; }
    .status {
      font-size: clamp(0.8rem, 2.8vw, 0.95rem); font-weight: 700;
      color: #a7f3d0; text-align: right; max-width: 62%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .teams {
      display: grid; grid-template-columns: 1fr auto 1fr;
      gap: 10px; align-items: center;
    }
    .name {
      font-size: clamp(1.05rem, 4.2vw, 1.45rem); font-weight: 900;
      line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .away { text-align: right; }
    .score {
      font-size: clamp(1.55rem, 6.5vw, 2.25rem); font-weight: 900;
      font-variant-numeric: tabular-nums; color: #4ade80; line-height: 1.1; margin-top: 2px;
    }
    .vs {
      font-size: clamp(0.85rem, 3vw, 1.05rem); font-weight: 900; opacity: 0.75;
      letter-spacing: 0.06em;
    }
    /* Home vs Away run-rate bars */
    .rr {
      margin-top: 10px; padding-top: 8px;
      border-top: 1px solid rgba(74, 222, 128, 0.22);
    }
    .rr-title {
      font-size: clamp(0.7rem, 2.4vw, 0.8rem); font-weight: 800;
      letter-spacing: 0.08em; text-transform: uppercase; color: #86efac;
      margin: 0 0 6px; opacity: 0.95;
    }
    .rr-row {
      display: grid; grid-template-columns: minmax(4.5rem, 28%) 1fr auto;
      gap: 8px; align-items: center; margin-bottom: 5px;
    }
    .rr-row:last-child { margin-bottom: 0; }
    .rr-lab {
      font-size: clamp(0.85rem, 3vw, 1rem); font-weight: 800;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .rr-track {
      height: clamp(12px, 3.2vw, 16px); border-radius: 999px;
      background: rgba(255,255,255,0.1); overflow: hidden;
    }
    .rr-fill {
      height: 100%; border-radius: 999px; min-width: 0;
      background: linear-gradient(90deg, #16a34a, #4ade80);
    }
    .rr-fill.away { background: linear-gradient(90deg, #2563eb, #60a5fa); }
    .rr-fill.need { background: linear-gradient(90deg, #c2410c, #fb923c); }
    .rr-val {
      font-size: clamp(0.95rem, 3.4vw, 1.15rem); font-weight: 900;
      font-variant-numeric: tabular-nums; color: #ecfdf5; min-width: 2.6rem; text-align: right;
    }
    .panel-sub {
      font-size: clamp(0.8rem, 2.8vw, 0.95rem); font-weight: 700;
      color: #a7f3d0; margin: 0 0 8px; opacity: 0.95;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .chase-line {
      font-size: clamp(0.9rem, 3.2vw, 1.1rem); font-weight: 800;
      color: #fde68a; margin: 0 0 8px; line-height: 1.3;
    }
    .chase-line strong { color: #fff; font-weight: 900; }
    .plist-solo { margin-top: 2px; }
    .prow.big {
      font-size: clamp(1.15rem, 4.4vw, 1.45rem); font-weight: 900;
      margin-bottom: 8px; padding: 4px 0;
      border-bottom: 1px solid rgba(74, 222, 128, 0.15);
    }
    .prow.big .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .prow.big .pstat { color: #4ade80; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .prow.big small {
      font-size: 0.72em; font-weight: 700; color: #86efac; margin-left: 2px;
    }
    .foot {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;
      font-size: clamp(0.7rem, 2.4vw, 0.8rem); font-weight: 700; color: #86efac; opacity: 0.85;
    }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-top: 4px; }
    .stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .stat em {
      font-style: normal; font-size: clamp(0.7rem, 2.4vw, 0.8rem); font-weight: 800;
      color: #86efac; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .stat strong {
      font-size: clamp(1.1rem, 4vw, 1.4rem); font-weight: 900; color: #ecfdf5;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .plist { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
    .pcol h3 {
      margin: 0 0 6px; font-size: clamp(0.7rem, 2.4vw, 0.8rem); font-weight: 800;
      letter-spacing: 0.06em; text-transform: uppercase; color: #86efac;
    }
    .prow {
      display: flex; justify-content: space-between; gap: 8px;
      font-size: clamp(1rem, 3.6vw, 1.2rem); font-weight: 800; margin-bottom: 4px;
    }
    .prow span { color: #4ade80; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .muted { opacity: 0.75; font-size: clamp(0.9rem, 3vw, 1.05rem); font-weight: 700; }
  `;
}

function renderRunRateGraph(ctx, opts = {}) {
  const homeRr = ctx.homeRr;
  const awayRr = ctx.awayRr;
  const chase = ctx.chase;
  const showRrr = !!opts.showRrr && chase && chase.rrr != null;
  if (homeRr == null && awayRr == null && !showRrr) {
    return `<div class="muted" style="margin-top:8px">Run rates appear when overs are scored.</div>`;
  }
  const max = Math.max(homeRr || 0, awayRr || 0, showRrr ? chase.rrr : 0, 0.01);
  const scale = max * 1.2;
  const pct = (v) =>
    v != null ? Math.min(100, Math.round((Number(v) / scale) * 100)) : 0;
  const lab = (v) => (v != null && Number.isFinite(v) ? Number(v).toFixed(2) : "—");
  return `
    <div class="rr" aria-label="Run rate home versus away">
      <div class="rr-title">${showRrr ? "Run rate · RRR needed" : "Run rate · Home vs Away"}</div>
      <div class="rr-row">
        <span class="rr-lab">${escHtml(ctx.homeShort || "Home")}</span>
        <div class="rr-track"><div class="rr-fill" style="width:${pct(homeRr)}%"></div></div>
        <span class="rr-val">${escHtml(lab(homeRr))}</span>
      </div>
      <div class="rr-row">
        <span class="rr-lab">${escHtml(ctx.awayShort || "Away")}</span>
        <div class="rr-track"><div class="rr-fill away" style="width:${pct(awayRr)}%"></div></div>
        <span class="rr-val">${escHtml(lab(awayRr))}</span>
      </div>
      ${
        showRrr
          ? `<div class="rr-row">
        <span class="rr-lab">Need</span>
        <div class="rr-track"><div class="rr-fill need" style="width:${pct(chase.rrr)}%"></div></div>
        <span class="rr-val">${escHtml(lab(chase.rrr))}</span>
      </div>`
          : ""
      }
    </div>`;
}

function renderScorePanel(ctx) {
  const { home, away, hs, as, badge, status, updated } = ctx;
  return `
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
      <span>${escHtml(updated)}</span>
    </div>`;
}

function renderBattersPanel(ctx) {
  const { batters, status, updated, home, away } = ctx;
  const batHtml = batters.length
    ? batters
        .map(
          (b) =>
            `<div class="prow big">
              <span class="pname">${escHtml(b.name)}</span>
              <span class="pstat">${escHtml(b.runs)}${
                b.balls !== "—" ? ` <small>(${escHtml(b.balls)})</small>` : ""
              }${b.sr ? ` <small>SR ${escHtml(b.sr)}</small>` : ""}</span>
            </div>`
        )
        .join("")
    : `<div class="muted">Waiting for batters…</div>`;
  return `
    <div class="top">
      <span class="live players">BATTERS</span>
      <span class="status">${escHtml(status)}</span>
    </div>
    <div class="panel-sub">${escHtml(home)} vs ${escHtml(away)}</div>
    <div class="plist-solo">${batHtml}</div>
    <div class="foot"><span>${escHtml(updated)}</span></div>`;
}

function renderBowlersPanel(ctx) {
  const { bowlers, status, updated, home, away } = ctx;
  const bowlHtml = bowlers.length
    ? bowlers
        .map(
          (b) =>
            `<div class="prow big">
              <span class="pname">${escHtml(b.name)}</span>
              <span class="pstat">${escHtml(b.figures)}
                <small>· ${escHtml(b.overs)}ov${
                  b.econ ? ` · E ${escHtml(b.econ)}` : ""
                }</small>
              </span>
            </div>`
        )
        .join("")
    : `<div class="muted">Waiting for bowlers…</div>`;
  return `
    <div class="top">
      <span class="live players">BOWLERS</span>
      <span class="status">${escHtml(status)}</span>
    </div>
    <div class="panel-sub">${escHtml(home)} vs ${escHtml(away)}</div>
    <div class="plist-solo">${bowlHtml}</div>
    <div class="foot"><span>${escHtml(updated)}</span></div>`;
}

function renderRunRatePanel(ctx) {
  const { status, updated, chase } = ctx;
  const chaseBits =
    chase && chase.target != null
      ? `<div class="chase-line">
          Target <strong>${escHtml(String(chase.target))}</strong>
          · Need <strong>${escHtml(String(chase.need))}</strong>
          ${
            chase.remOversDisplay != null
              ? ` · <strong>${escHtml(String(chase.remOversDisplay))}</strong> ov left`
              : ""
          }
          ${
            chase.rrr != null
              ? ` · RRR <strong>${escHtml(chase.rrr.toFixed(2))}</strong>`
              : ""
          }
        </div>`
      : `<div class="panel-sub">RRR shows in the second innings when a target is known.</div>`;
  return `
    <div class="top">
      <span class="live stats">RUN RATE</span>
      <span class="status">${escHtml(status)}</span>
    </div>
    ${chaseBits}
    ${renderRunRateGraph(ctx, { showRrr: true })}
    <div class="foot"><span>${escHtml(updated)}</span></div>`;
}

function renderScoreboardHtml(data, opts = {}) {
  // Default 10s; 12-slot cycle ≈ 2 minutes (75% score / 3 secondary panels)
  const refresh = Math.max(8, Math.min(120, Number(opts.refresh) || OVERLAY_SLOT_SECS));
  let panel = opts.panel || overlayPanelIndex();
  // Accept legacy query values
  if (panel === "stats") panel = "runrate";
  if (panel === "players") panel = "batters";
  const home = shortTeamName(data.homeTeam || DEFAULT_OVERLAY_MATCH.homeTeam);
  const away = shortTeamName(data.awayTeam || DEFAULT_OVERLAY_MATCH.awayTeam);
  const hs = pickScoreVal(data.homeScore, data.summary?.homeScore);
  const as = pickScoreVal(data.awayScore, data.summary?.awayScore);
  const live = !!(data.live || data.summary?.live);
  const status = data.status || data.summary?.status || (live ? "Match In Progress" : "Scoreboard");
  const badge = live ? "LIVE" : "MATCH";
  const updated = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const mid = data.matchId || data.id || opts.matchId || "";
  const inn = currentInnings(data);
  const batters = extractBatters(inn);
  const bowlers = extractBowlers(inn);
  const homeRr = runRateFromScore(hs);
  const awayRr = runRateFromScore(as);
  const chase = extractChaseInfo(data, hs, as);
  const homeShort = String(home).split(/\s+/).slice(0, 2).join(" ") || "Home";
  const awayShort = String(away).split(/\s+/).slice(0, 2).join(" ") || "Away";

  const ctx = {
    home,
    away,
    homeShort,
    awayShort,
    hs,
    as,
    homeRr,
    awayRr,
    chase,
    badge,
    status,
    mid,
    updated,
    batters,
    bowlers,
  };

  let bodyInner = "";
  if (panel === "batters") bodyInner = renderBattersPanel(ctx);
  else if (panel === "bowlers") bodyInner = renderBowlersPanel(ctx);
  else if (panel === "runrate") bodyInner = renderRunRatePanel(ctx);
  else bodyInner = renderScorePanel(ctx);

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta http-equiv="refresh" content="${refresh}" />
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
  <title>Scoreboard · ${escHtml(panel)}</title>
  <style>${overlayShellCss()}</style>
</head>
<body>
  <div class="bar" data-match-id="${escHtml(mid)}" data-panel="${escHtml(panel)}">
    ${bodyInner}
  </div>
</body>
</html>`;
}

app.get("/scoreboard", async (req, res) => {
  const matchId = String(req.query.matchId || DEFAULT_OVERLAY_MATCH.matchId);
  const site = String(req.query.site || DEFAULT_OVERLAY_MATCH.site);
  // Default 10s slots · 12-slot cycle (75% score); ?refresh= overrides
  const refresh = Number(req.query.refresh || OVERLAY_SLOT_SECS);
  const allowed = new Set(["score", "batters", "bowlers", "runrate", "stats", "players"]);
  const panel = allowed.has(String(req.query.panel || ""))
    ? String(req.query.panel)
    : overlayPanelIndex();
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  try {
    const data = await fetchMatchForOverlay(matchId, site);
    res.type("html").send(renderScoreboardHtml(data, { refresh, matchId, panel }));
  } catch (e) {
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
        { refresh, matchId, panel: "score" }
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
  const list = await ytRssRecent(channelId, 1);
  return list[0] || { videoId: "", title: "" };
}

/** Recent channel uploads from Atom RSS (bypasses consent walls). */
async function ytRssRecent(channelId, limit = 8) {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      headers: { "User-Agent": YT_UA, Accept: "application/atom+xml,application/xml,text/xml" },
      cache: "no-store",
    });
    const xml = await r.text();
    const ids = [...xml.matchAll(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/g)].map((m) => m[1]);
    // titles: [channelName, video1, video2, ...]
    const titles = [...xml.matchAll(/<media:title>([^<]*)<\/media:title>/g)].map((m) => m[1]);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < ids.length && out.length < limit; i++) {
      const videoId = ids[i];
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      out.push({ videoId, title: titles[i] || "" });
    }
    return out;
  } catch {
    return [];
  }
}

async function ytWatchMeta(videoId) {
  try {
    const { html } = await ytFetch(`https://www.youtube.com/watch?v=${videoId}`);
    // Strong live signals in raw HTML (works even when player JSON parse fails)
    const liveNowHtml = /"isLiveNow"\s*:\s*true/.test(html);
    const pr = parseYtPlayerResponse(html);
    if (!pr?.videoDetails) {
      const loose = extractVideoIdFromHtml(html, "");
      return {
        title: loose.title || "",
        isLive: liveNowHtml || loose.isLive,
      };
    }
    const live = pr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
    const isLive = live
      ? !!live.isLiveNow
      : !!(liveNowHtml || pr.videoDetails.isLiveContent || pr.videoDetails.isLive);
    return {
      title: pr.videoDetails.title || "",
      isLive,
    };
  } catch {
    return { title: "", isLive: false };
  }
}

/**
 * Pick the video that is actually LIVE now.
 * /@handle/live HTML often hits EU consent on Render → empty scrape → stale RSS head.
 * Always scan recent RSS entries and confirm isLiveNow on each watch page.
 */
async function resolveChannelLive(handle, channelId) {
  const watchUrl = `https://www.youtube.com/@${handle}/live`;
  let videoId = "";
  let title = "";
  let isLive = false;
  let finalUrl = watchUrl;
  let source = "";

  // 1) /channel/UC…/live then /@handle/live
  const pageUrls = [];
  if (channelId) pageUrls.push(`https://www.youtube.com/channel/${channelId}/live`);
  pageUrls.push(watchUrl);

  for (const pageUrl of pageUrls) {
    try {
      const page = await ytFetch(pageUrl);
      finalUrl = page.finalUrl;
      // Consent interstitial = no useful player JSON
      if (/consent\.youtube\.com/i.test(finalUrl) || /before you continue/i.test(page.html.slice(0, 2000))) {
        continue;
      }
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

  // 2) Confirm / upgrade via watch page meta
  if (videoId) {
    const meta = await ytWatchMeta(videoId);
    if (meta.title) title = meta.title;
    if (meta.isLive) isLive = true;
    else isLive = false;
  }

  // 3) Always scan recent RSS for a true live stream (covers consent + stale /live redirect)
  if (channelId && !isLive) {
    const recent = await ytRssRecent(channelId, 8);
    for (const item of recent) {
      if (!item.videoId) continue;
      // Skip re-checking the id we already know is offline
      if (item.videoId === videoId && !isLive) continue;
      const meta = await ytWatchMeta(item.videoId);
      if (meta.isLive) {
        videoId = item.videoId;
        title = meta.title || item.title || title;
        isLive = true;
        source = "rss-live-scan";
        finalUrl = `https://www.youtube.com/watch?v=${videoId}`;
        break;
      }
      // Keep newest non-live as fallback only if we had nothing
      if (!videoId) {
        videoId = item.videoId;
        title = meta.title || item.title || title;
        source = "rss";
        isLive = false;
      }
    }
  }

  // 4) RSS fallback when HTML empty and nothing live
  if (!videoId && channelId) {
    const rss = await ytRssLatest(channelId);
    if (rss.videoId) {
      videoId = rss.videoId;
      title = rss.title || title;
      source = "rss";
      const meta = await ytWatchMeta(videoId);
      if (meta.title) title = meta.title;
      isLive = !!meta.isLive;
    }
  }

  return { videoId, title, isLive, finalUrl, source, watchUrl };
}

app.get("/api/youtube/channel-live", async (req, res) => {
  const handle = String(req.query.handle || "LullingtonLive")
    .replace(/^@/, "")
    .replace(/[^\w.-]/g, "");
  if (!handle) return res.status(400).json({ ok: false, error: "handle required" });

  const channelId = YT_KNOWN[handle] || null;
  const watchUrl = `https://www.youtube.com/@${handle}/live`;

  try {
    const resolved = await resolveChannelLive(handle, channelId);
    const videoId = resolved.videoId || "";
    const isLive = !!(videoId && resolved.isLive);

    // Concrete video embed only — channel live_stream embed is intentionally omitted
    // (YouTube serves a different/blank stream than @handle/live for many channels)
    // Only advertise embed when live so clients do not stick on last week's VOD.
    const videoEmbed =
      videoId && isLive
        ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0`
        : videoId
          ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0`
          : null;

    res.json({
      ok: true,
      handle,
      videoId: videoId || null,
      channelId: channelId || null,
      title: resolved.title || null,
      watchUrl: resolved.watchUrl || watchUrl,
      embedUrl: videoEmbed,
      videoEmbedUrl: videoEmbed,
      channelEmbedUrl: null,
      isLive,
      finalUrl: resolved.finalUrl || watchUrl,
      source: resolved.source || null,
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

// OAuth connect + push match title/description to current YouTube live
youtubeOauth.mount(app);
console.log(
  `[scorers-window] youtube oauth: ${youtubeOauth.configured() ? "configured" : "not configured (set YOUTUBE_CLIENT_ID/SECRET)"}`
);

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
