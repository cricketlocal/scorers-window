/**
 * Scorers Window — Cricket Local Live Hub client
 * Default: https://cricket-local-v5-1.onrender.com
 */
(function (global) {
  const STORAGE_KEY = "sw-settings-v1";
  const DEFAULT_HUB = "https://cricket-local-v5-1.onrender.com";
  const POLL_MS = 20_000;
  /** Club channel live page — always-on feed for Watch */
  const DEFAULT_LIVE_FEED = "https://www.youtube.com/@LullingtonLive/live";
  const DEFAULT_CHANNEL_HANDLE = "LullingtonLive";

  /**
   * Parse video ID, channel handle, or full YouTube URL.
   * @returns {{ type: 'video'|'channel', id?: string, handle?: string, watchUrl: string, embedUrl: string }|null}
   */
  function parseYouTubeInput(input) {
    const s = String(input || "").trim();
    if (!s) return null;

    // Channel live / handle: youtube.com/@Name or @Name/live
    const handleM = s.match(/(?:youtube\.com\/)?@([\w.-]+)(?:\/live)?\/?(?:\?|$)/i) || s.match(/^@([\w.-]+)$/);
    if (handleM && !s.match(/[?&]v=/) && !s.match(/youtu\.be\//)) {
      const handle = handleM[1];
      return {
        type: "channel",
        handle,
        watchUrl: `https://www.youtube.com/@${handle}/live`,
        embedUrl: "", // filled after resolve, or use video id if set
      };
    }

    // Full URLs → 11-char video id
    const vidM = s.match(
      /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|live\/|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
    );
    if (vidM) {
      const id = vidM[1];
      return {
        type: "video",
        id,
        watchUrl: `https://www.youtube.com/live/${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1`,
      };
    }

    // Bare 11-char id
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) {
      return {
        type: "video",
        id: s,
        watchUrl: `https://www.youtube.com/live/${s}`,
        embedUrl: `https://www.youtube.com/embed/${s}?autoplay=1&mute=1&playsinline=1`,
      };
    }

    return null;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      let s = raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
      // Normalize video id if user pasted a full URL
      if (s.youtubeVideoId) {
        const p = parseYouTubeInput(s.youtubeVideoId);
        if (p?.type === "video" && p.id) s.youtubeVideoId = p.id;
        else if (p?.type === "channel" && p.handle) {
          s.youtubeChannelHandle = p.handle;
          s.youtubeLiveFeedUrl = p.watchUrl;
          s.youtubeVideoId = "";
        }
      }
      if (!s.youtubeLiveFeedUrl) s.youtubeLiveFeedUrl = DEFAULT_LIVE_FEED;
      if (!s.youtubeChannelHandle) s.youtubeChannelHandle = DEFAULT_CHANNEL_HANDLE;
      return s;
    } catch {
      return defaults();
    }
  }

  function defaults() {
    return {
      hubUrl: DEFAULT_HUB,
      youtubeStreamKey: "",
      youtubeVideoId: "",
      youtubeLiveFeedUrl: DEFAULT_LIVE_FEED,
      youtubeChannelHandle: DEFAULT_CHANNEL_HANDLE,
      /** Optional override for relay host (default: same origin) */
      streamRelayUrl: "",
      clubLabel: "Lullington Park CC",
      /** Default: Sat 8 Aug 2026 LPCC 2nd XI v Rosehill (update when needed) */
      selectedMatchId: "7236091",
      selectedSite: "https://lpcc.play-cricket.com",
      useDemoWhenIdle: true,
    };
  }

  function saveSettings(partial) {
    const next = { ...loadSettings(), ...partial };
    // Never store a YouTube page URL as a stream key
    if (next.youtubeStreamKey && looksLikeUrlNotStreamKey(next.youtubeStreamKey)) {
      next.youtubeStreamKey = "";
    }
    // Normalize video / channel fields
    if (next.youtubeVideoId) {
      const p = parseYouTubeInput(next.youtubeVideoId);
      if (p?.type === "video" && p.id) next.youtubeVideoId = p.id;
      else if (p?.type === "channel") {
        next.youtubeChannelHandle = p.handle;
        next.youtubeLiveFeedUrl = p.watchUrl;
        next.youtubeVideoId = "";
      }
    }
    if (next.youtubeLiveFeedUrl) {
      const p = parseYouTubeInput(next.youtubeLiveFeedUrl);
      if (p?.type === "channel") {
        next.youtubeChannelHandle = p.handle;
        next.youtubeLiveFeedUrl = p.watchUrl;
      } else if (p?.type === "video") {
        next.youtubeVideoId = p.id;
        next.youtubeLiveFeedUrl = p.watchUrl;
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  /** Stream keys look like xxxx-xxxx-xxxx-xxxx — not https://studio.youtube.com/... */
  function looksLikeUrlNotStreamKey(key) {
    const k = String(key || "").trim().toLowerCase();
    if (!k) return false;
    if (k.startsWith("http://") || k.startsWith("https://")) return true;
    if (k.includes("youtube.com") || k.includes("youtu.be") || k.includes("studio.youtube")) return true;
    if (k.includes("livestreaming") || k.includes("/video/")) return true;
    // Sanitized URL pastes become long alphanumeric strings without dashes
    if (k.length > 40 && !k.includes("-")) return true;
    return false;
  }

  function isValidStreamKeyFormat(key) {
    const k = String(key || "").trim();
    if (!k || looksLikeUrlNotStreamKey(k)) return false;
    // YouTube keys are typically 4+ groups with dashes, or similar token
    if (k.length < 10) return false;
    if (/^x{2,}-x+/i.test(k) || k.includes("xxxx")) return false; // placeholder
    return true;
  }

  function hubBase() {
    // Prefer same-origin hub proxy on scorers-window (Moblin browser widget)
    try {
      if (
        typeof location !== "undefined" &&
        location.origin &&
        /scorers-window/i.test(location.hostname || "")
      ) {
        return location.origin;
      }
    } catch {
      /* */
    }
    const u = (loadSettings().hubUrl || DEFAULT_HUB).replace(/\/+$/, "");
    return u || DEFAULT_HUB;
  }

  async function getJson(path) {
    const base = `${hubBase()}${path.startsWith("/") ? path : `/${path}`}`;
    const sep = base.includes("?") ? "&" : "?";
    // Bust CDN/browser cache (hub sends max-age=15)
    const url = `${base}${sep}_=${Date.now()}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    if (!res.ok) {
      const err = new Error(`Hub ${res.status}: ${path}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Live hub list: { ok, liveCount, matches[], message } */
  async function fetchHub() {
    return getJson("/api/live/hub");
  }

  /** Single match board — always network, cache-busted */
  async function fetchMatch(matchId, site = "") {
    const params = new URLSearchParams({
      matchId: String(matchId || ""),
      t: String(Date.now()),
    });
    if (site) params.set("site", site);
    return getJson(`/api/live/match?${params}`);
  }

  async function fetchStatus() {
    try {
      return await getJson("/api/live/status");
    } catch {
      // status is optional; fall back to hub probe
      const hub = await fetchHub();
      return {
        ok: true,
        liveNow: hub.liveCount ?? hub.matches?.length ?? 0,
        fromHub: true,
      };
    }
  }

  /**
   * Shared scoreboard pick (Live Match feed / Match Day Settings on phone).
   * GET /api/matchday/scoreboard?club=…
   */
  async function fetchSharedScoreboard(club = "") {
    const c = encodeURIComponent(String(club || loadSettings().clubLabel || "Lullington Park CC"));
    try {
      return await getJson(`/api/matchday/scoreboard?club=${c}`);
    } catch (e) {
      console.warn("[SWHub] shared scoreboard", e.message || e);
      return null;
    }
  }

  /** Publish selected fixture so Moblin overlay / other phones see the same match */
  async function publishSharedScoreboard(match, club = "") {
    if (!match?.id && !match?.matchId) return null;
    const clubName = String(club || loadSettings().clubLabel || "Lullington Park CC");
    const body = {
      club: clubName,
      matchId: match.id || match.matchId,
      id: match.id || match.matchId,
      site: match.site || "",
      homeTeam: match.homeTeam || "",
      awayTeam: match.awayTeam || "",
      homeScore: match.homeScore || "–",
      awayScore: match.awayScore || "–",
      status: match.status || "",
      live: !!match.live,
      completed: !!match.completed,
      demo: !!match.demo,
      date: match.date || "",
      time: match.time || "",
      competition: match.competition || "",
      ground: match.ground || "",
    };
    const url = `${hubBase()}/api/matchday/scoreboard`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`Publish scoreboard ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * Normalise a hub match row for UI + overlay.
   */
  function normaliseMatch(m) {
    if (!m) return null;
    const board = m.board && typeof m.board === "object" ? m.board : {};
    const summary = m.summary && typeof m.summary === "object" ? m.summary : {};
    const detail =
      m.detail ||
      board.detail ||
      board.step ||
      summary.detail ||
      (board.batsmen || board.batters || board.bowler
        ? {
            batters: board.batsmen || board.batters,
            bowler: board.bowler,
            lastBalls: board.lastBalls || board.recentOvers || board.recentBalls,
            lastBall: board.lastBall,
            partnership: board.partnership,
            situation: board.situation || m.status,
          }
        : null);
    const id = String(
      m.matchId || m.id || m.match_id || summary.id || board.id || ""
    );
    const live = !!(m.live || m.is_live || summary.live) && !m.completed && !m.demo && !summary.completed;
    return {
      id,
      matchId: id,
      site: m.site || summary.site || board.site || "",
      homeTeam: m.homeTeam || m.home_team || summary.homeTeam || board.homeTeam || "Home",
      awayTeam: m.awayTeam || m.away_team || summary.awayTeam || board.awayTeam || "Away",
      homeScore: pickScore(
        m.homeScore,
        m.home_score,
        summary.homeScore,
        board.homeScore
      ),
      awayScore: pickScore(
        m.awayScore,
        m.away_score,
        summary.awayScore,
        board.awayScore
      ),
      status: m.status || m.result || summary.status || summary.result || board.status || (live ? "Live" : ""),
      live,
      completed: !!(m.completed || summary.completed || board.completed),
      demo: !!(m.demo || board.demo),
      date: m.date || summary.date || board.date || "",
      competition: m.competition || m.divisionName || summary.divisionName || "",
      ground: m.ground || summary.ground || "",
      playCricketUrl: m.playCricketUrl || "",
      polledAt: m.polledAt || m.polled_at || m.hubCachedAt || null,
      detail: detail || null,
      board,
      raw: m,
    };
  }

  /** Demo card when hub is empty (weekend score for overlay testing). */
  function getDemoMatch() {
    const demo = global.SWDemo?.getWeekendDemo?.();
    return demo ? normaliseMatch(demo) : null;
  }

  function pickScore(...vals) {
    for (const v of vals) {
      if (v == null || v === "") continue;
      return String(v);
    }
    return "—";
  }

  function teamLine(match) {
    if (!match) return "No match selected";
    return `${match.homeTeam} vs ${match.awayTeam}`;
  }

  /**
   * Poll helper — setInterval (more reliable than chained setTimeout in
   * background WebViews / Moblin browser widgets).
   * Returns stop().
   */
  function poll(fn, ms = POLL_MS) {
    let stopped = false;
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        console.warn("[hub poll]", e.message || e);
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(run, Math.max(3000, Number(ms) || POLL_MS));
    // Kick again when widget becomes visible (Moblin often freezes bg timers)
    const onVis = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }

  /**
   * Primary live feed = club channel live page.
   * Specific video ID is only an optional override (Setup).
   */
  function getLiveFeed() {
    const s = loadSettings();
    const handle = s.youtubeChannelHandle || DEFAULT_CHANNEL_HANDLE;
    const watchUrl =
      s.youtubeLiveFeedUrl || DEFAULT_LIVE_FEED || `https://www.youtube.com/@${handle}/live`;
    // Optional fixed video override (only if valid 11-char id, not a URL leftover)
    if (s.youtubeVideoId && /^[a-zA-Z0-9_-]{11}$/.test(String(s.youtubeVideoId).trim())) {
      const id = String(s.youtubeVideoId).trim();
      return {
        type: "video",
        id,
        handle,
        watchUrl: `https://www.youtube.com/live/${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1`,
        useChannelLive: false,
      };
    }
    return {
      type: "channel",
      handle,
      watchUrl,
      embedUrl: "",
      useChannelLive: true,
    };
  }

  async function resolveChannelLive(handle) {
    const h = String(handle || DEFAULT_CHANNEL_HANDLE).replace(/^@/, "");
    try {
      const base = typeof location !== "undefined" ? location.origin : "";
      const res = await fetch(`${base}/api/youtube/channel-live?handle=${encodeURIComponent(h)}`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const j = await res.json();
      if (j.embedUrl || j.videoId || j.channelId) {
        const videoId = j.videoId || null;
        const channelId = j.channelId || null;
        // Prefer channel live_stream (matches youtube.com/@handle/live)
        const embedUrl =
          j.embedUrl ||
          (channelId
            ? `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=0&playsinline=1`
            : videoId
              ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=0&playsinline=1`
              : "");
        return {
          type: "channel",
          id: videoId || undefined,
          handle: h,
          channelId: channelId || "",
          watchUrl: j.watchUrl || `https://www.youtube.com/@${h}/live`,
          embedUrl,
          title: j.title || "",
          isLive: !!j.isLive,
        };
      }
    } catch (e) {
      console.warn("[SWHub] resolveChannelLive", e);
    }
    return null;
  }

  global.SWHub = {
    DEFAULT_HUB,
    DEFAULT_LIVE_FEED,
    DEFAULT_CHANNEL_HANDLE,
    STORAGE_KEY,
    POLL_MS,
    loadSettings,
    saveSettings,
    parseYouTubeInput,
    getLiveFeed,
    resolveChannelLive,
    looksLikeUrlNotStreamKey,
    isValidStreamKeyFormat,
    hubBase,
    fetchHub,
    fetchMatch,
    fetchStatus,
    fetchSharedScoreboard,
    publishSharedScoreboard,
    normaliseMatch,
    getDemoMatch,
    teamLine,
    poll,
  };
})(typeof window !== "undefined" ? window : globalThis);
