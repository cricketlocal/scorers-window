/**
 * Scorers Window — minimal SPA
 * 1) Live — embedded YouTube + Watch Live Video (red offline / green live)
 * 2) Settings — fixture for overlay + Moblin overlay URL
 * Overlay page remains for Moblin browser widget: #/overlay?obs=1
 */
(function () {
  const { SWHub, SWOverlay, SWDemo } = window;
  const main = () => document.getElementById("main");
  const hubStatusEl = () => document.getElementById("hub-status");

  const CHANNEL_HANDLE = "LullingtonLive";
  const CHANNEL_ID = "UCR4PqiyQh_U9_PWnI8wT9fA";
  const WATCH_PAGE = "https://www.youtube.com/@LullingtonLive/live";
  /** Official YouTube channel live embed — auto-follows current stream on the channel */
  const CHANNEL_LIVE_EMBED =
    `https://www.youtube.com/embed/live_stream?channel=${CHANNEL_ID}` +
    `&autoplay=1&mute=1&playsinline=1&rel=0`;

  let stopPoll = null;
  let cachedMatches = [];
  let ytLiveStatus = null; // { isLive, videoId, title, embedUrl }

  function route() {
    const hash = (location.hash || "#/live").replace(/^#/, "") || "/live";
    const path = hash.split("?")[0] || "/live";
    const params = new URLSearchParams(hash.includes("?") ? hash.split("?")[1] : "");
    return { path: path.startsWith("/") ? path : `/${path}`, params };
  }

  function setNav(active) {
    document.querySelectorAll(".nav a[data-nav]").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("data-nav") === active);
    });
  }

  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2800);
  }

  function stopActivePoll() {
    if (typeof stopPoll === "function") {
      stopPoll();
      stopPoll = null;
    }
  }

  function setOverlayMode(on) {
    document.body.classList.toggle("overlay-mode", !!on);
    document.body.classList.remove("player-mode", "watch-mode", "live-cam-mode");
    const m = main();
    if (!m) return;
    m.classList.toggle("main--overlay", !!on);
    m.classList.remove("main--wide", "main--player");
    document.documentElement.classList.toggle("obs-capture", !!on);
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escAttr(s) {
    return esc(s).replace(/'/g, "&#39;");
  }

  function overlayUrl() {
    const origin =
      location.hostname.includes("onrender.com") || location.hostname === "localhost"
        ? location.origin
        : "https://scorers-window-live.onrender.com";
    // Server HTML + meta refresh (Moblin-proof). 12s slots → 80/10/10 over ~2 min.
    return `${origin}/scoreboard?matchId=7236091&refresh=10`;
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || "Copied");
    } catch {
      toast(text);
    }
  }

  async function refreshHubStatus() {
    const el = hubStatusEl();
    if (!el) return;
    try {
      const s = await SWHub.fetchStatus();
      const n = s.liveNow ?? s.liveCount ?? 0;
      el.textContent = `hub live ${n}`;
      el.className = "hub-status ok";
    } catch {
      el.textContent = "hub —";
      el.className = "hub-status";
    }
  }

  async function fetchYoutubeLiveStatus() {
    // Always use channel live_stream embed (YouTube picks the current live).
    // Optional API probe only for LIVE / Offline badge.
    const embedUrl = CHANNEL_LIVE_EMBED;
    try {
      const res = await fetch(
        `${location.origin}/api/youtube/channel-live?handle=${encodeURIComponent(CHANNEL_HANDLE)}&_=${Date.now()}`,
        { cache: "no-store" }
      );
      const j = await res.json();
      const videoId = j.videoId || null;
      const live = !!(videoId && j.isLive === true);
      ytLiveStatus = {
        isLive: live,
        videoId,
        channelId: j.channelId || CHANNEL_ID,
        title: j.title || "",
        embedUrl,
        watchUrl: WATCH_PAGE,
      };
      return ytLiveStatus;
    } catch (e) {
      ytLiveStatus = {
        isLive: false,
        videoId: null,
        channelId: CHANNEL_ID,
        title: "",
        embedUrl,
        watchUrl: WATCH_PAGE,
        error: e.message,
      };
      return ytLiveStatus;
    }
  }

  function selectDemoMatch() {
    const d = SWHub.getDemoMatch?.();
    if (!d) return null;
    SWHub.saveSettings({
      selectedMatchId: d.id,
      selectedSite: d.site || "https://lpcc.play-cricket.com",
      useDemoWhenIdle: true,
    });
    return d;
  }

  async function loadMatches() {
    let data = { matches: [], message: null, liveCount: 0 };
    try {
      data = await SWHub.fetchHub();
    } catch (e) {
      data = { matches: [], message: e.message || "Hub offline", liveCount: 0 };
    }
    const liveList = (data.matches || []).map((m) => SWHub.normaliseMatch(m)).filter((m) => m?.id);
    const demo = SWHub.getDemoMatch?.();
    let list = liveList.slice();
    if (demo && !list.some((m) => m.id === demo.id)) list = [...list, demo];
    cachedMatches = list;
    return { list, liveList, demo, message: data.message, liveCount: data.liveCount ?? liveList.length };
  }

  /** Today's stream scoreboard: LPCC 2nd XI v Rosehill (Play-Cricket) */
  const TODAY_SCOREBOARD = {
    matchId: "7236091",
    site: "https://lpcc.play-cricket.com",
    homeTeam: "Lullington Park CC - 2nd XI",
    awayTeam: "Rosehill CC - 1st XI",
    date: "Saturday 8 August 2026",
    time: "13:00",
    ground: "Edingale Lane - Main Ground",
  };

  /**
   * Active overlay match: always re-fetch live scores for the selected id.
   * Shared pick (phone) only chooses WHICH match — not frozen scores.
   * For this match day we lock to 2nd XI v Rosehill unless demo is forced.
   */
  async function resolveActiveMatch() {
    const settings = SWHub.loadSettings();
    const demo = SWHub.getDemoMatch?.();
    let matchId = String(settings.selectedMatchId || "").trim();
    let site = String(settings.selectedSite || "").trim();
    let labelSnap = null;

    // Shared pick from Live Match feed / Match Day Settings (which game)
    try {
      const shared = await SWHub.fetchSharedScoreboard?.(settings.clubLabel || "Lullington Park CC");
      if (shared?.matchId) {
        matchId = String(shared.matchId);
        site = String(shared.site || site || TODAY_SCOREBOARD.site).trim();
        labelSnap = shared;
        if (
          String(settings.selectedMatchId) !== matchId ||
          String(settings.selectedSite || "") !== site
        ) {
          SWHub.saveSettings({ selectedMatchId: matchId, selectedSite: site });
        }
      }
    } catch {
      /* shared optional */
    }

    // Overlay always uses 2nd XI v Rosehill for this match day
    matchId = TODAY_SCOREBOARD.matchId;
    site = TODAY_SCOREBOARD.site;
    labelSnap = {
      ...(labelSnap || {}),
      ...TODAY_SCOREBOARD,
      matchId: TODAY_SCOREBOARD.matchId,
    };
    SWHub.saveSettings({ selectedMatchId: matchId, selectedSite: site });

    if (SWDemo?.isDemoId?.(matchId) || matchId === "demo-lpcc" || matchId === "demo") {
      return demo || SWHub.getDemoMatch();
    }

    // Live scores: always hit match API (hub list alone is often empty/stale)
    if (matchId) {
      try {
        const raw = await SWHub.fetchMatch(matchId, site || "https://lpcc.play-cricket.com");
        const m = SWHub.normaliseMatch(raw);
        if (m?.id) {
          // Prefer live API scores; keep labels from shared if API blanks teams
          if (labelSnap) {
            if (!m.homeTeam || m.homeTeam === "Home") m.homeTeam = labelSnap.homeTeam || m.homeTeam;
            if (!m.awayTeam || m.awayTeam === "Away") m.awayTeam = labelSnap.awayTeam || m.awayTeam;
          }
          m.live = m.live || !!raw?.live || !!raw?.summary?.live;
          return m;
        }
      } catch (e) {
        console.warn("[overlay] fetchMatch", matchId, e.message || e);
      }
    }

    // Fallback: hub list row
    try {
      const { list } = await loadMatches();
      const fromList = list.find((x) => String(x.id) === String(matchId) && !x.demo);
      if (fromList) return fromList;
    } catch {
      /* */
    }

    // Last resort: shared labels only (better than wrong demo)
    if (labelSnap && matchId && matchId !== "demo-lpcc") {
      return {
        id: matchId,
        matchId,
        site,
        homeTeam: labelSnap.homeTeam || "Lullington Park CC - 2nd XI",
        awayTeam: labelSnap.awayTeam || "Rosehill CC - 1st XI",
        homeScore: labelSnap.homeScore || "–",
        awayScore: labelSnap.awayScore || "–",
        live: !!labelSnap.live,
        demo: false,
        date: labelSnap.date || "",
        status: labelSnap.status || "Live",
      };
    }

    return demo || null;
  }

  /* ——— Live tab ——— */

  async function viewLive() {
    setOverlayMode(false);
    setNav("live");
    main().classList.add("main--wide");

    main().innerHTML = `
      <div class="live-tab">
        <h1>Live</h1>
        <p class="lead">Lullington Live YouTube feed</p>

        <button type="button" class="btn-watch-status offline" id="btn-watch-live" disabled>
          Checking live status…
        </button>

        <div class="yt-embed live-tab-player" id="yt-player">
          <div class="player-loading">Loading feed…</div>
        </div>

        <p class="muted" style="margin:12px 0 0;font-size:0.8rem;text-align:center">
          <a href="${escAttr(WATCH_PAGE)}" target="_blank" rel="noopener">youtube.com/@LullingtonLive/live</a>
        </p>
      </div>
    `;

    const btn = document.getElementById("btn-watch-live");
    const player = document.getElementById("yt-player");

    function paintButton(st) {
      if (!btn) return;
      btn.disabled = false;
      if (st?.isLive) {
        btn.className = "btn-watch-status live";
        btn.textContent = "Watch Live Video · LIVE";
      } else {
        btn.className = "btn-watch-status offline";
        btn.textContent = "Watch Live Video · Offline";
      }
    }

    function paintPlayer(st) {
      if (!player) return;
      // Responsive channel live_stream embed (YouTube picks current live on the channel)
      const src = st?.embedUrl || CHANNEL_LIVE_EMBED;
      if (player.querySelector("iframe[data-yt-channel-live]")) return;
      player.innerHTML = `
        <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%">
          <iframe
            data-yt-channel-live="1"
            src="${escAttr(src)}"
            style="position:absolute;top:0;left:0;width:100%;height:100%;border:0"
            title="Lullington Live"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        </div>
      `;
    }

    async function refreshLive() {
      const st = await fetchYoutubeLiveStatus();
      paintButton(st);
      paintPlayer(st);
    }

    btn?.addEventListener("click", () => {
      // Scroll to / focus player (already embedded); reload embed
      paintPlayer(ytLiveStatus);
      player?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast(ytLiveStatus?.isLive ? "Playing live feed" : "Showing channel feed (may be offline)");
    });

    await refreshLive();
    stopActivePoll();
    let lastEmbedId = ytLiveStatus?.videoId || null;
    stopPoll = SWHub.poll(async () => {
      if (route().path !== "/live" && route().path !== "/") return;
      const st = await fetchYoutubeLiveStatus();
      paintButton(st);
      // Rebuild iframe only when the resolved video id changes (new live stream)
      if ((st?.videoId || null) !== lastEmbedId) {
        lastEmbedId = st?.videoId || null;
        paintPlayer(st);
      }
    }, 60000);
  }

  /* ——— Settings ——— */

  async function pushMatchToYouTube(match) {
    if (!match) return null;
    const settings = SWHub.loadSettings();
    const payload = {
      matchId: match.id || match.matchId || "",
      homeTeam: match.homeTeam || "",
      awayTeam: match.awayTeam || "",
      date: match.date || "",
      time: match.time || "",
      ground: match.ground || match.venue || "",
      clubLabel: settings.clubLabel || "Lullington Park CC",
    };
    try {
      const res = await fetch("/api/youtube/match-description", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      return j;
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function refreshYoutubeStatus() {
    const el = document.getElementById("yt-oauth-status");
    if (!el) return null;
    try {
      const res = await fetch(`/api/youtube/oauth/status?_=${Date.now()}`, { cache: "no-store" });
      const j = await res.json();
      if (!j.configured) {
        el.innerHTML =
          `<span class="muted">YouTube API not configured on server (env YOUTUBE_CLIENT_ID / SECRET).</span>`;
        return j;
      }
      if (j.connected) {
        el.innerHTML = `<span class="yt-oauth-ok">Connected${
          j.channelTitle ? " · " + esc(j.channelTitle) : ""
        }</span>`;
      } else {
        el.innerHTML = `<span class="muted">Not connected — tap Connect YouTube once (Lullington Live account).</span>`;
      }
      return j;
    } catch (e) {
      el.innerHTML = `<span class="muted">Could not check YouTube status.</span>`;
      return null;
    }
  }

  async function viewSettings() {
    setOverlayMode(false);
    setNav("settings");
    const s = SWHub.loadSettings();
    const url = overlayUrl();

    // OAuth return messages
    const params = route().params;
    const ytFlag = params.get("youtube") || "";

    main().innerHTML = `
      <div class="settings-page">
        <h1>Settings</h1>
        <p class="lead">Choose the fixture for the scoreboard overlay, and copy the Moblin browser URL.</p>

        <div class="card">
          <h2>YouTube live title &amp; description</h2>
          <p class="muted" style="margin:0 0 10px;font-size:0.85rem">
            Connect the <strong>Lullington Live</strong> Google account once.
            When you select a fixture below, we update the current YouTube live
            <strong>title</strong> and <strong>description</strong> with match details.
          </p>
          <p id="yt-oauth-status" class="muted" style="margin:0 0 12px;font-size:0.85rem">Checking…</p>
          <div class="row-actions">
            <a class="btn btn-primary" id="btn-yt-connect" href="/api/youtube/oauth/start">Connect YouTube</a>
            <button type="button" class="btn btn-sm" id="btn-yt-push">Push selected match now</button>
            <button type="button" class="btn btn-sm btn-ghost" id="btn-yt-disconnect">Disconnect</button>
          </div>
          <p class="muted" style="margin:10px 0 0;font-size:0.8rem">
            Tip: start or schedule the stream in YouTube Studio first, then select the fixture.
            After Connect, copy <code>YOUTUBE_REFRESH_TOKEN</code> from server logs into Render if redeploys drop the link.
          </p>
        </div>

        <div class="card">
          <h2>Fixture for overlay</h2>
          <p class="muted" style="margin:0 0 12px;font-size:0.85rem">
            This match is shown on the Moblin / OBS scoreboard overlay.
            Selecting a fixture also updates YouTube (if connected).
          </p>
          <div class="row-actions" style="margin-bottom:12px">
            <button type="button" class="btn btn-sm btn-primary" id="btn-demo">Select demo match</button>
            <button type="button" class="btn btn-sm" id="btn-refresh-matches">Refresh live list</button>
            <span class="badge badge-live" id="match-badge">…</span>
          </div>
          <p class="muted" id="selected-label" style="margin:0 0 10px;font-size:0.85rem"></p>
          <div id="match-list" class="match-list"><p class="empty">Loading…</p></div>
        </div>

        <div class="card demo-select-card">
          <h2>Moblin overlay URL</h2>
          <p class="muted" style="margin:0 0 8px;font-size:0.85rem">
            Use this URL in Moblin <strong>Browser</strong> widget (or keep <code>#/overlay</code> — it redirects here).
            Rotates: <strong>~75%</strong> scores · batters · bowlers · run-rate/RRR
            (reloads every 10s from Play-Cricket — works when the phone throttles JS).
            Full width, bottom of the browser widget.
          </p>
          <p class="mono obs-url-box" id="overlay-url-box">${esc(url)}</p>
          <div class="row-actions">
            <button type="button" class="btn btn-primary" id="btn-copy-overlay">Copy overlay URL</button>
            <a class="btn btn-ghost" href="/scoreboard?matchId=7236091&refresh=10" target="_blank" rel="noopener">Preview overlay</a>
          </div>
        </div>
      </div>
    `;

    const listEl = document.getElementById("match-list");
    const badge = document.getElementById("match-badge");
    const selectedLabel = document.getElementById("selected-label");

    if (ytFlag === "connected") toast("YouTube connected");
    if (ytFlag === "error") {
      toast("YouTube connect failed: " + (params.get("msg") || "error"));
    }

    function updateSelectedLabel() {
      const set = SWHub.loadSettings();
      const id = set.selectedMatchId || "";
      const m = cachedMatches.find((x) => x.id === id) || (SWDemo?.isDemoId?.(id) ? SWHub.getDemoMatch() : null);
      if (selectedLabel) {
        selectedLabel.textContent = m
          ? `Selected: ${m.homeTeam} vs ${m.awayTeam} · ${m.homeScore} · ${m.awayScore}${m.demo ? " (DEMO)" : ""}`
          : id
            ? `Selected match #${id}`
            : "No fixture selected — pick demo or a live match";
      }
    }

    async function onFixtureChosen(match, isDemo) {
      try {
        if (match && SWHub.publishSharedScoreboard) {
          await SWHub.publishSharedScoreboard(match);
        }
      } catch (e) {
        console.warn("[settings] publish shared", e);
      }
      // Update YouTube live title/description when connected
      const yt = await pushMatchToYouTube(match);
      if (yt?.ok) {
        toast(
          isDemo
            ? "Demo selected · YouTube title updated"
            : "Fixture selected · YouTube title/description updated"
        );
      } else if (yt && yt.error && /not connected|Not connected/i.test(yt.error)) {
        toast(isDemo ? "Demo fixture selected" : "Fixture selected for overlay");
      } else if (yt && yt.error) {
        toast(
          (isDemo ? "Demo selected. " : "Fixture selected. ") +
            "YouTube: " +
            (yt.error.length > 80 ? yt.error.slice(0, 77) + "…" : yt.error)
        );
      } else {
        toast(isDemo ? "Demo fixture selected" : "Fixture selected for overlay");
      }
    }

    async function paintMatches() {
      try {
        const { list, liveCount, message } = await loadMatches();
        if (badge) badge.textContent = `${liveCount} live`;
        updateSelectedLabel();
        const selectedId = SWHub.loadSettings().selectedMatchId;

        if (!list.length) {
          listEl.innerHTML = `<p class="empty">${esc(message || "No matches.")}</p>`;
          return;
        }

        listEl.innerHTML = list
          .map((m) => {
            const sel = m.id === selectedId ? " selected" : "";
            const tag = m.demo ? "DEMO" : m.live ? "LIVE" : "MATCH";
            return `
              <button type="button" class="match-item${sel}" data-id="${escAttr(m.id)}" data-site="${escAttr(m.site || "")}" data-demo="${m.demo ? "1" : "0"}">
                <span class="teams">${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</span>
                <span class="scores">${esc(m.homeScore)} · ${esc(m.awayScore)}</span>
                <span class="meta">${tag} · #${esc(m.id)}${m.date ? " · " + esc(m.date) : ""}</span>
              </button>`;
          })
          .join("");

        listEl.querySelectorAll(".match-item").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const isDemo = btn.getAttribute("data-demo") === "1";
            let match = null;
            if (isDemo) {
              match = selectDemoMatch();
            } else {
              const id = btn.getAttribute("data-id");
              SWHub.saveSettings({
                selectedMatchId: id,
                selectedSite: btn.getAttribute("data-site") || "",
              });
              match = cachedMatches.find((x) => String(x.id) === String(id)) || {
                id,
                site: btn.getAttribute("data-site") || "",
                homeTeam: btn.querySelector(".teams")?.textContent?.split(" vs ")[0] || "",
                awayTeam: btn.querySelector(".teams")?.textContent?.split(" vs ")[1] || "",
              };
            }
            await onFixtureChosen(match, isDemo);
            paintMatches();
          });
        });
      } catch (e) {
        listEl.innerHTML = `<p class="empty">Could not load matches: ${esc(e.message || e)}</p>`;
      }
    }

    document.getElementById("btn-demo")?.addEventListener("click", async () => {
      const match = selectDemoMatch();
      await onFixtureChosen(match, true);
      paintMatches();
    });
    document.getElementById("btn-refresh-matches")?.addEventListener("click", () => paintMatches());
    document.getElementById("btn-copy-overlay")?.addEventListener("click", () => {
      copyText(overlayUrl(), "Overlay URL copied — paste into Moblin Browser widget");
    });
    document.getElementById("btn-yt-push")?.addEventListener("click", async () => {
      const set = SWHub.loadSettings();
      const id = set.selectedMatchId;
      let match =
        cachedMatches.find((x) => String(x.id) === String(id)) ||
        (SWDemo?.isDemoId?.(id) ? SWHub.getDemoMatch() : null);
      if (!match && id) {
        match = { id, site: set.selectedSite, homeTeam: "Home", awayTeam: "Away" };
      }
      if (!match) {
        toast("Select a fixture first");
        return;
      }
      toast("Updating YouTube…");
      const yt = await pushMatchToYouTube(match);
      if (yt?.ok) toast("YouTube title/description updated");
      else toast(yt?.error || "YouTube update failed");
    });
    document.getElementById("btn-yt-disconnect")?.addEventListener("click", async () => {
      try {
        await fetch("/api/youtube/oauth/disconnect", { method: "POST" });
        toast("YouTube disconnected on this server");
      } catch {
        toast("Disconnect failed");
      }
      refreshYoutubeStatus();
    });

    if (!SWHub.loadSettings().selectedMatchId) selectDemoMatch();
    await refreshYoutubeStatus();
    await paintMatches();
    stopActivePoll();
  }

  /* ——— Overlay (Moblin browser widget) ——— */

  async function viewOverlay() {
    // Same URL Moblin already uses (#/overlay) → reliable server scoreboard
    location.replace(
      `/scoreboard?matchId=${encodeURIComponent(TODAY_SCOREBOARD.matchId)}&refresh=10`
    );
  }

  /* ——— Router ——— */

  async function render() {
    stopActivePoll();
    document.body.classList.remove("watch-mode", "player-mode", "live-cam-mode", "overlay-mode");
    document.documentElement.classList.remove("obs-capture");
    const m = main();
    if (m) m.classList.remove("main--wide", "main--player", "main--overlay");

    const { path } = route();

    try {
      if (path === "/" || path === "" || path === "/live") await viewLive();
      else if (path === "/settings" || path === "/setup") await viewSettings();
      else if (path === "/overlay") await viewOverlay();
      else {
        // Old routes → Live
        location.hash = "#/live";
      }
    } catch (e) {
      console.error(e);
      main().innerHTML = `<div class="card"><h2>Error</h2><p class="muted">${esc(e.message || e)}</p></div>`;
    }
  }

  window.addEventListener("hashchange", () => render());
  window.addEventListener("DOMContentLoaded", () => {
    if (!location.hash || location.hash === "#/") location.hash = "#/live";
    render();
    refreshHubStatus();
    setInterval(refreshHubStatus, 60_000);
  });
})();
