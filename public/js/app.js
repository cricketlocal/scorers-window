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
    return `${origin}/#/overlay?obs=1`;
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
    try {
      const res = await fetch(
        `${location.origin}/api/youtube/channel-live?handle=${encodeURIComponent(CHANNEL_HANDLE)}&_=${Date.now()}`,
        { cache: "no-store" }
      );
      const j = await res.json();
      // Green only when we have the actual live video id (same stream as /@LullingtonLive/live)
      const live = !!(j.videoId && (j.isLive !== false));
      ytLiveStatus = {
        isLive: live,
        videoId: j.videoId || null,
        channelId: j.channelId || CHANNEL_ID,
        title: j.title || "",
        // Prefer concrete video embed — channel live_stream often shows wrong/blank feed
        embedUrl:
          j.videoEmbedUrl ||
          (j.videoId
            ? `https://www.youtube.com/embed/${j.videoId}?autoplay=1&mute=1&playsinline=1&rel=0`
            : j.channelEmbedUrl ||
              (j.channelId || CHANNEL_ID
                ? `https://www.youtube.com/embed/live_stream?channel=${j.channelId || CHANNEL_ID}&autoplay=1&mute=1&playsinline=1`
                : "")),
        watchUrl: WATCH_PAGE,
      };
      return ytLiveStatus;
    } catch (e) {
      ytLiveStatus = {
        isLive: false,
        videoId: null,
        channelId: CHANNEL_ID,
        title: "",
        embedUrl: `https://www.youtube.com/embed/live_stream?channel=${CHANNEL_ID}&autoplay=1&mute=1&playsinline=1`,
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

  async function resolveActiveMatch() {
    const settings = SWHub.loadSettings();
    const { list, demo } = await loadMatches();
    if (settings.selectedMatchId && (SWDemo?.isDemoId?.(settings.selectedMatchId) || settings.selectedMatchId === demo?.id)) {
      return demo || SWHub.getDemoMatch();
    }
    if (settings.selectedMatchId) {
      const m = list.find((x) => x.id === settings.selectedMatchId && !x.demo);
      if (m) return m;
    }
    return list.find((x) => x.live && !x.demo) || demo || list[0] || null;
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
      // Only embed when we know the live video id (matches youtube.com/@LullingtonLive/live)
      if (st?.videoId && st?.embedUrl) {
        const src = `${st.embedUrl}${st.embedUrl.includes("?") ? "&" : "?"}_=${Date.now()}`;
        player.innerHTML = `
          <iframe
            src="${escAttr(src)}"
            title="Lullington Live"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        `;
        return;
      }
      // Offline / unresolved: no wrong channel embed — show status + link
      player.innerHTML = `
        <div class="watch-video-placeholder card yt-fallback" style="min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <p style="margin:0 0 8px;font-weight:700">${st?.isLive ? "Loading live video…" : "No live stream detected"}</p>
          <p class="muted" style="margin:0 0 12px;font-size:0.9rem;text-align:center">
            Open the same feed YouTube shows for the club channel.
          </p>
          <a class="btn btn-live" href="${escAttr(WATCH_PAGE)}" target="_blank" rel="noopener">Open @LullingtonLive/live ↗</a>
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
    stopPoll = SWHub.poll(async () => {
      if (route().path !== "/live" && route().path !== "/") return;
      const st = await fetchYoutubeLiveStatus();
      paintButton(st);
      // Don't rebuild iframe every poll if already showing (avoids flicker)
    }, 60000);
  }

  /* ——— Settings ——— */

  async function viewSettings() {
    setOverlayMode(false);
    setNav("settings");
    const s = SWHub.loadSettings();
    const url = overlayUrl();

    main().innerHTML = `
      <div class="settings-page">
        <h1>Settings</h1>
        <p class="lead">Choose the fixture for the scoreboard overlay, and copy the Moblin browser URL.</p>

        <div class="card">
          <h2>Fixture for overlay</h2>
          <p class="muted" style="margin:0 0 12px;font-size:0.85rem">
            This match is shown on the Moblin / OBS scoreboard overlay.
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
            In Moblin: remove Practice scoreboard → add a <strong>Browser</strong> widget → paste this URL.
            Size about full width × 400 high, bottom of scene.
          </p>
          <p class="mono obs-url-box" id="overlay-url-box">${esc(url)}</p>
          <div class="row-actions">
            <button type="button" class="btn btn-primary" id="btn-copy-overlay">Copy overlay URL</button>
            <a class="btn btn-ghost" href="#/overlay?obs=1" target="_blank" rel="noopener">Preview overlay</a>
          </div>
        </div>
      </div>
    `;

    const listEl = document.getElementById("match-list");
    const badge = document.getElementById("match-badge");
    const selectedLabel = document.getElementById("selected-label");

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
          btn.addEventListener("click", () => {
            const isDemo = btn.getAttribute("data-demo") === "1";
            if (isDemo) selectDemoMatch();
            else {
              SWHub.saveSettings({
                selectedMatchId: btn.getAttribute("data-id"),
                selectedSite: btn.getAttribute("data-site") || "",
              });
            }
            toast(isDemo ? "Demo fixture selected" : "Fixture selected for overlay");
            paintMatches();
          });
        });
      } catch (e) {
        listEl.innerHTML = `<p class="empty">Could not load matches: ${esc(e.message || e)}</p>`;
      }
    }

    document.getElementById("btn-demo")?.addEventListener("click", () => {
      selectDemoMatch();
      toast("Demo fixture selected");
      paintMatches();
    });
    document.getElementById("btn-refresh-matches")?.addEventListener("click", () => paintMatches());
    document.getElementById("btn-copy-overlay")?.addEventListener("click", () => {
      copyText(overlayUrl(), "Overlay URL copied — paste into Moblin Browser widget");
    });

    if (!SWHub.loadSettings().selectedMatchId) selectDemoMatch();
    await paintMatches();
    stopActivePoll();
  }

  /* ——— Overlay (Moblin browser widget) ——— */

  async function viewOverlay() {
    setOverlayMode(true);
    setNav("");
    document.documentElement.classList.add("obs-capture");

    if (!SWHub.loadSettings().selectedMatchId) selectDemoMatch();

    main().innerHTML = `<div class="overlay-root" id="overlay-root"></div>`;
    const root = document.getElementById("overlay-root");
    const brand = SWHub.loadSettings().clubLabel || "Lullington Park CC";

    async function tick() {
      try {
        let m = await resolveActiveMatch();
        if (!m) m = SWHub.getDemoMatch();
        SWOverlay.mount(root, m, { brand: m?.demo ? "DEMO · LPCC" : brand });
      } catch (e) {
        const demo = SWHub.getDemoMatch();
        if (demo) SWOverlay.mount(root, demo, { brand: "DEMO · LPCC" });
        else SWOverlay.mount(root, null, { brand, extra: e.message });
      }
    }

    await tick();
    stopActivePoll();
    stopPoll = SWHub.poll(tick, 12000);
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
