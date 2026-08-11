/**
 * YouTube OAuth + update live stream title/description from match details.
 *
 * Env:
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REDIRECT_URI  (default: https://scorers-window-live.onrender.com/api/youtube/oauth/callback)
 *   YOUTUBE_TOKEN_PATH    (optional file for refresh token)
 *   YOUTUBE_REFRESH_TOKEN (optional fallback after first connect / redeploy)
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const YT_API = "https://www.googleapis.com/youtube/v3";

function clientId() {
  return String(process.env.YOUTUBE_CLIENT_ID || "").trim();
}
function clientSecret() {
  return String(process.env.YOUTUBE_CLIENT_SECRET || "").trim();
}
function redirectUri() {
  return String(
    process.env.YOUTUBE_REDIRECT_URI ||
      "https://scorers-window-live.onrender.com/api/youtube/oauth/callback"
  ).trim();
}
function tokenPath() {
  return (
    process.env.YOUTUBE_TOKEN_PATH ||
    path.join(os.tmpdir(), "scorers-window-youtube-tokens.json")
  );
}

function configured() {
  return !!(clientId() && clientSecret());
}

function loadTokens() {
  const fromEnv = String(process.env.YOUTUBE_REFRESH_TOKEN || "").trim();
  let file = null;
  try {
    if (fs.existsSync(tokenPath())) {
      file = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
    }
  } catch {
    file = null;
  }
  return {
    refresh_token: file?.refresh_token || fromEnv || "",
    access_token: file?.access_token || "",
    expiry: Number(file?.expiry || 0),
    connectedAt: file?.connectedAt || null,
    channelTitle: file?.channelTitle || null,
  };
}

function saveTokens(partial) {
  const prev = loadTokens();
  const next = {
    refresh_token: partial.refresh_token || prev.refresh_token || "",
    access_token: partial.access_token || prev.access_token || "",
    expiry: partial.expiry != null ? partial.expiry : prev.expiry || 0,
    connectedAt: partial.connectedAt || prev.connectedAt || new Date().toISOString(),
    channelTitle: partial.channelTitle != null ? partial.channelTitle : prev.channelTitle,
  };
  try {
    fs.writeFileSync(tokenPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.warn("[youtube-oauth] could not write token file:", e.message);
  }
  return next;
}

function clearTokens() {
  try {
    if (fs.existsSync(tokenPath())) fs.unlinkSync(tokenPath());
  } catch {
    /* */
  }
}

function authUrl(state = "sw") {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId());
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", String(state || "sw"));
  return u.toString();
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code: String(code || ""),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(j.error_description || j.error || "token exchange failed");
  }
  const tokens = saveTokens({
    refresh_token: j.refresh_token || "",
    access_token: j.access_token || "",
    expiry: Date.now() + Number(j.expires_in || 3600) * 1000 - 60_000,
    connectedAt: new Date().toISOString(),
  });
  if (!tokens.refresh_token) {
    console.warn(
      "[youtube-oauth] no refresh_token returned — re-consent with prompt=consent or set YOUTUBE_REFRESH_TOKEN"
    );
  }
  try {
    const ch = await youtubeGet(tokens.access_token, "/channels", {
      part: "snippet",
      mine: "true",
    });
    const title = ch?.items?.[0]?.snippet?.title || null;
    if (title) saveTokens({ channelTitle: title });
  } catch {
    /* optional */
  }
  return loadTokens();
}

async function refreshAccessToken() {
  const t = loadTokens();
  if (!t.refresh_token) throw new Error("Not connected — open Connect YouTube in Settings");
  if (t.access_token && t.expiry && Date.now() < t.expiry) {
    return t.access_token;
  }
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: t.refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(j.error_description || j.error || "refresh failed");
  }
  saveTokens({
    access_token: j.access_token,
    expiry: Date.now() + Number(j.expires_in || 3600) * 1000 - 60_000,
    refresh_token: j.refresh_token || t.refresh_token,
  });
  return j.access_token;
}

async function youtubeGet(accessToken, apiPath, params = {}) {
  const u = new URL(`${YT_API}${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  const r = await fetch(u, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(j?.error?.message || j.error || `YouTube GET ${apiPath} failed`);
  }
  return j;
}

async function youtubePut(accessToken, apiPath, params, body) {
  const u = new URL(`${YT_API}${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  const r = await fetch(u, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(j?.error?.message || j.error || `YouTube PUT ${apiPath} failed`);
  }
  return j;
}

/**
 * Prefer active live broadcast, else upcoming, else latest channel live video id from search.
 */
async function resolveBroadcastVideoId(accessToken) {
  for (const status of ["active", "upcoming"]) {
    try {
      const list = await youtubeGet(accessToken, "/liveBroadcasts", {
        part: "id,snippet,status",
        mine: "true",
        broadcastStatus: status,
        maxResults: "5",
      });
      const items = list.items || [];
      // Prefer one that is liveNow / ready
      const sorted = [...items].sort((a, b) => {
        const sa = a.status?.lifeCycleStatus || "";
        const sb = b.status?.lifeCycleStatus || "";
        const rank = (s) => (s === "live" ? 0 : s === "ready" || s === "testing" ? 1 : 2);
        return rank(sa) - rank(sb);
      });
      const hit = sorted[0];
      if (hit?.id) return { videoId: hit.id, lifeCycleStatus: hit.status?.lifeCycleStatus || status };
    } catch (e) {
      console.warn("[youtube-oauth] liveBroadcasts", status, e.message);
    }
  }
  // Fallback: search my live videos
  try {
    const search = await youtubeGet(accessToken, "/search", {
      part: "id,snippet",
      forMine: "true",
      type: "video",
      eventType: "live",
      maxResults: "1",
    });
    const id = search?.items?.[0]?.id?.videoId;
    if (id) return { videoId: id, lifeCycleStatus: "live" };
  } catch (e) {
    console.warn("[youtube-oauth] search live", e.message);
  }
  return null;
}

function buildMatchMeta(match = {}) {
  const home = String(match.homeTeam || match.home || "").trim() || "Home";
  const away = String(match.awayTeam || match.away || "").trim() || "Away";
  const date = String(match.date || "").trim();
  const time = String(match.time || "").trim();
  const ground = String(match.ground || match.venue || "").trim();
  const club = String(match.clubLabel || match.club || "Lullington Park CC").trim();
  const matchId = String(match.matchId || match.id || "").trim();

  let title = `${home} vs ${away}`;
  if (title.length > 95) title = title.slice(0, 92) + "…";

  const lines = [
    `${home} vs ${away}`,
    [date, time].filter(Boolean).join(" · "),
    ground ? `Ground: ${ground}` : "",
    club ? `Club: ${club}` : "",
    matchId ? `Play-Cricket match #${matchId}` : "",
    "",
    "Live stream · Lullington Live",
    "Watch + live scores on Cricket Local:",
    "https://cricket-local-v5-1.onrender.com",
    "https://cricket-local-v5-1.onrender.com/matchday/#/watch",
    "",
    "Stream managed via Scorers Window / Cricket Local.",
  ].filter((l, i, arr) => l !== "" || (arr[i - 1] !== "" && i > 0));

  const description = lines.join("\n").slice(0, 4900);
  return { title, description, home, away, date, time, ground, club, matchId };
}

async function updateMatchDescription(match) {
  if (!configured()) {
    return { ok: false, error: "YouTube OAuth not configured (missing CLIENT_ID/SECRET)" };
  }
  const accessToken = await refreshAccessToken();
  const target = await resolveBroadcastVideoId(accessToken);
  if (!target?.videoId) {
    return {
      ok: false,
      error:
        "No active or upcoming YouTube live broadcast found. Create / start a stream in YouTube Studio first, then select the fixture again.",
    };
  }

  const meta = buildMatchMeta(match);

  // Need full snippet for videos.update (categoryId required)
  const existing = await youtubeGet(accessToken, "/videos", {
    part: "snippet",
    id: target.videoId,
  });
  const sn = existing?.items?.[0]?.snippet;
  if (!sn) {
    return { ok: false, error: `Could not load video ${target.videoId}` };
  }

  const updated = await youtubePut(
    accessToken,
    "/videos",
    { part: "snippet" },
    {
      id: target.videoId,
      snippet: {
        title: meta.title,
        description: meta.description,
        categoryId: sn.categoryId || "17", // Sports
        tags: sn.tags || ["cricket", "Lullington", "live"],
        defaultLanguage: sn.defaultLanguage || "en",
      },
    }
  );

  return {
    ok: true,
    videoId: target.videoId,
    lifeCycleStatus: target.lifeCycleStatus,
    title: updated?.snippet?.title || meta.title,
    description: meta.description,
    watchUrl: `https://www.youtube.com/watch?v=${target.videoId}`,
  };
}

function getStatus() {
  const t = loadTokens();
  return {
    ok: true,
    configured: configured(),
    connected: !!(t.refresh_token || process.env.YOUTUBE_REFRESH_TOKEN),
    channelTitle: t.channelTitle || null,
    connectedAt: t.connectedAt || null,
    redirectUri: redirectUri(),
    hasClientId: !!clientId(),
  };
}

function mount(app) {
  app.get("/api/youtube/oauth/status", (_req, res) => {
    res.json(getStatus());
  });

  app.get("/api/youtube/oauth/start", (req, res) => {
    if (!configured()) {
      return res.status(503).send("YouTube OAuth not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.");
    }
    const state = String(req.query.state || "sw").slice(0, 64);
    res.redirect(302, authUrl(state));
  });

  app.get("/api/youtube/oauth/callback", async (req, res) => {
    try {
      const err = req.query.error;
      if (err) {
        return res.redirect(`/#/settings?youtube=error&msg=${encodeURIComponent(String(err))}`);
      }
      const code = req.query.code;
      if (!code) {
        return res.redirect("/#/settings?youtube=error&msg=missing_code");
      }
      await exchangeCode(code);
      const t = loadTokens();
      const rt = t.refresh_token || "";
      if (rt) {
        console.log(
          "[youtube-oauth] connected. Set Render env YOUTUBE_REFRESH_TOKEN for redeploy persistence."
        );
      }
      // One-time page so you can copy the refresh token into Render (disk is ephemeral)
      const esc = (s) =>
        String(s || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>YouTube connected</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a1f14;color:#e8f5e9;padding:24px;max-width:560px;margin:0 auto;line-height:1.45}
code,textarea{display:block;width:100%;box-sizing:border-box;background:#06140d;color:#7dffb3;border:1px solid #1a3d2a;border-radius:8px;padding:10px;font-size:12px;word-break:break-all}
a.btn{display:inline-block;margin-top:16px;padding:12px 18px;background:#16a34a;color:#fff;text-decoration:none;border-radius:10px;font-weight:700}
.muted{color:#8fb89a;font-size:0.9rem}
</style></head><body>
<h1>YouTube connected</h1>
<p>Lullington Live is linked to Scorers Window.</p>
${
  rt
    ? `<p class="muted">Copy this into Render → Environment as <strong>YOUTUBE_REFRESH_TOKEN</strong>
       so the link survives redeploys (server disk is temporary):</p>
       <textarea readonly rows="3" id="rt">${esc(rt)}</textarea>
       <p class="muted">Also keep YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET set.</p>`
    : `<p class="muted">No refresh token returned. Disconnect and Connect again, or ensure prompt=consent.</p>`
}
<p><a class="btn" href="/#/settings?youtube=connected">Back to Settings</a></p>
<script>
const t=document.getElementById("rt");
if(t){t.focus();t.select();}
</script>
</body></html>`);
    } catch (e) {
      console.error("[youtube-oauth] callback", e);
      res.redirect(`/#/settings?youtube=error&msg=${encodeURIComponent(e.message || "oauth_failed")}`);
    }
  });

  app.post("/api/youtube/oauth/disconnect", (_req, res) => {
    clearTokens();
    res.json({ ok: true, connected: false });
  });

  app.post("/api/youtube/match-description", async (req, res) => {
    try {
      const result = await updateMatchDescription(req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      console.error("[youtube-oauth] match-description", e);
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  /** Preview text without calling YouTube */
  app.post("/api/youtube/match-description/preview", (req, res) => {
    res.json({ ok: true, ...buildMatchMeta(req.body || {}) });
  });
}

module.exports = {
  mount,
  getStatus,
  updateMatchDescription,
  buildMatchMeta,
  configured,
};
