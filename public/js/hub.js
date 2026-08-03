/**
 * Scorers Window — Cricket Local Live Hub client
 * Default: https://cricket-local-v5-1.onrender.com
 */
(function (global) {
  const STORAGE_KEY = "sw-settings-v1";
  const DEFAULT_HUB = "https://cricket-local-v5-1.onrender.com";
  const POLL_MS = 20_000;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      return { ...defaults(), ...JSON.parse(raw) };
    } catch {
      return defaults();
    }
  }

  function defaults() {
    return {
      hubUrl: DEFAULT_HUB,
      youtubeStreamKey: "",
      youtubeVideoId: "",
      clubLabel: "Lullington Park CC",
      /** Weekend demo (Sat 1 Aug 2026 LPCC v Brailsford) until a live match is picked */
      selectedMatchId: "7224658",
      selectedSite: "https://lpcc.play-cricket.com",
      useDemoWhenIdle: true,
    };
  }

  function saveSettings(partial) {
    const next = { ...loadSettings(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function hubBase() {
    const u = (loadSettings().hubUrl || DEFAULT_HUB).replace(/\/+$/, "");
    return u || DEFAULT_HUB;
  }

  async function getJson(path) {
    const url = `${hubBase()}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
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

  /** Single match board */
  async function fetchMatch(matchId, site = "") {
    const params = new URLSearchParams({ matchId: String(matchId || "") });
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
   * Normalise a hub match row for UI + overlay.
   */
  function normaliseMatch(m) {
    if (!m) return null;
    const board = m.board && typeof m.board === "object" ? m.board : {};
    const detail =
      m.detail ||
      board.detail ||
      board.step ||
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
    return {
      id: String(m.id || m.match_id || board.id || ""),
      site: m.site || board.site || "",
      homeTeam: m.homeTeam || m.home_team || board.homeTeam || "Home",
      awayTeam: m.awayTeam || m.away_team || board.awayTeam || "Away",
      homeScore: pickScore(m.homeScore, m.home_score, board.homeScore),
      awayScore: pickScore(m.awayScore, m.away_score, board.awayScore),
      status: m.status || m.result || board.status || (m.live ? "Live" : ""),
      live: !!(m.live || m.is_live) && !m.completed && !m.demo,
      completed: !!(m.completed || board.completed),
      demo: !!(m.demo || board.demo),
      date: m.date || board.date || "",
      competition: m.competition || "",
      playCricketUrl: m.playCricketUrl || "",
      polledAt: m.polledAt || m.polled_at || null,
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

  /** Poll helper — returns stop() */
  function poll(fn, ms = POLL_MS) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (e) {
        console.warn("[hub poll]", e.message || e);
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  global.SWHub = {
    DEFAULT_HUB,
    STORAGE_KEY,
    POLL_MS,
    loadSettings,
    saveSettings,
    hubBase,
    fetchHub,
    fetchMatch,
    fetchStatus,
    normaliseMatch,
    getDemoMatch,
    teamLine,
    poll,
  };
})(typeof window !== "undefined" ? window : globalThis);
