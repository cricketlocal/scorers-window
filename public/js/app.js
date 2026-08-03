/**
 * Scorers Window — hash SPA
 * Routes: / #/setup #/go-live #/overlay #/board
 */
(function () {
  const { SWHub, SWOverlay } = window;
  const main = () => document.getElementById("main");
  const hubStatusEl = () => document.getElementById("hub-status");

  let stopPoll = null;
  let mediaStream = null;
  let cachedMatches = [];
  let activeMatch = null;

  function route() {
    const hash = (location.hash || "#/").replace(/^#/, "") || "/";
    const path = hash.split("?")[0] || "/";
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

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
  }

  function setOverlayMode(on) {
    document.body.classList.toggle("overlay-mode", !!on);
    const m = main();
    if (!m) return;
    m.classList.toggle("main--overlay", !!on);
    m.classList.toggle("main--wide", false);
  }

  async function refreshHubStatus() {
    const el = hubStatusEl();
    if (!el) return;
    try {
      const s = await SWHub.fetchStatus();
      const n = s.liveNow ?? s.liveCount ?? 0;
      el.textContent = `live ${n} · ${SWHub.hubBase().replace(/^https?:\/\//, "")}`;
      el.className = "hub-status ok";
      el.title = JSON.stringify(s).slice(0, 200);
    } catch (e) {
      el.textContent = "hub offline";
      el.className = "hub-status err";
      el.title = e.message || String(e);
    }
  }

  async function loadMatches() {
    const data = await SWHub.fetchHub();
    const list = (data.matches || []).map((m) => SWHub.normaliseMatch(m)).filter((m) => m?.id);
    cachedMatches = list;
    return { list, message: data.message || null, liveCount: data.liveCount ?? list.length };
  }

  async function resolveActiveMatch() {
    const settings = SWHub.loadSettings();
    const { list } = await loadMatches();
    if (settings.selectedMatchId) {
      let m = list.find((x) => x.id === settings.selectedMatchId);
      if (!m) {
        try {
          const detail = await SWHub.fetchMatch(settings.selectedMatchId, settings.selectedSite);
          const row = detail.match || detail.board || detail;
          m = SWHub.normaliseMatch({
            ...row,
            id: settings.selectedMatchId,
            site: settings.selectedSite || row.site,
            board: detail.board || row.board || row,
          });
        } catch {
          m = null;
        }
      }
      activeMatch = m;
      return m;
    }
    activeMatch = list[0] || null;
    return activeMatch;
  }

  /* ——— Views ——— */

  function viewHome() {
    setOverlayMode(false);
    setNav("home");
    const s = SWHub.loadSettings();
    const hasKey = !!s.youtubeStreamKey;
    const hasYt = !!s.youtubeVideoId;
    const hasMatch = !!s.selectedMatchId;

    main().innerHTML = `
      <h1>Scorers Window</h1>
      <p class="lead">Phone / PWA → pick match → Go Live → camera + <strong>our</strong> Play-Cricket overlay → YouTube.</p>

      <div class="card">
        <h2>Setup checklist</h2>
        <ul class="checklist">
          <li class="${s.hubUrl ? "done" : ""}"><span class="dot"></span><span>Hub connected (${esc(shortUrl(s.hubUrl))})</span></li>
          <li class="${hasKey ? "done" : ""}"><span class="dot"></span><span>YouTube stream key saved ${hasKey ? "" : "(optional for MVP overlay)"}</span></li>
          <li class="${hasYt ? "done" : ""}"><span class="dot"></span><span>YouTube video ID for embed ${hasYt ? `(${esc(s.youtubeVideoId)})` : ""}</span></li>
          <li class="${hasMatch ? "done" : ""}"><span class="dot"></span><span>Match selected ${hasMatch ? `(#${esc(s.selectedMatchId)})` : ""}</span></li>
        </ul>
        <div class="row-actions">
          <a class="btn btn-primary" href="#/setup">Setup</a>
          <a class="btn btn-live" href="#/go-live">Go Live</a>
        </div>
      </div>

      <div class="card">
        <h2>Overlay for OBS</h2>
        <p class="muted" style="margin:0 0 12px">Use as a <strong>Browser Source</strong> (transparent background). Scores poll the Cricket Local live hub.</p>
        <div class="row-actions">
          <a class="btn" href="#/overlay" target="_blank" rel="noopener">Open overlay</a>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-copy-overlay">Copy overlay URL</button>
        </div>
      </div>

      <div class="card">
        <h2>Viewer board</h2>
        <p class="muted" style="margin:0 0 12px">Rich board + optional YouTube embed when a video ID is set.</p>
        <a class="btn" href="#/board">Open board</a>
      </div>
    `;

    document.getElementById("btn-copy-overlay")?.addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}#/overlay`;
      try {
        await navigator.clipboard.writeText(url);
        toast("Overlay URL copied");
      } catch {
        toast(url);
      }
    });
  }

  function viewSetup() {
    setOverlayMode(false);
    setNav("setup");
    const s = SWHub.loadSettings();

    main().innerHTML = `
      <h1>Setup</h1>
      <p class="lead">Stored in this browser only (localStorage). RTMP publish from the phone comes next.</p>

      <form class="card" id="setup-form">
        <div class="field">
          <label for="hubUrl">Cricket Local hub URL</label>
          <input id="hubUrl" name="hubUrl" type="url" value="${escAttr(s.hubUrl)}" placeholder="${escAttr(SWHub.DEFAULT_HUB)}" required />
          <p class="hint">Default: ${esc(SWHub.DEFAULT_HUB)}</p>
        </div>
        <div class="field">
          <label for="clubLabel">Club label</label>
          <input id="clubLabel" name="clubLabel" type="text" value="${escAttr(s.clubLabel)}" placeholder="Lullington Park" />
        </div>
        <div class="field">
          <label for="youtubeStreamKey">YouTube stream key</label>
          <input id="youtubeStreamKey" name="youtubeStreamKey" type="password" autocomplete="off" value="${escAttr(s.youtubeStreamKey)}" placeholder="xxxx-xxxx-xxxx-xxxx" />
          <p class="hint">YouTube Studio → Go live → Stream key. Used when device RTMP is wired up.</p>
        </div>
        <div class="field">
          <label for="youtubeVideoId">YouTube live video ID</label>
          <input id="youtubeVideoId" name="youtubeVideoId" type="text" value="${escAttr(s.youtubeVideoId)}" placeholder="e.g. ZHVBULQZB94" />
          <p class="hint">From a live URL: youtube.com/live/<strong>VIDEO_ID</strong> — used for board embed.</p>
        </div>
        <div class="row-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn btn-ghost" id="btn-test-hub">Test hub</button>
        </div>
      </form>

      <div class="card" id="hub-test-result" hidden></div>
    `;

    document.getElementById("setup-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      SWHub.saveSettings({
        hubUrl: String(fd.get("hubUrl") || "").trim() || SWHub.DEFAULT_HUB,
        clubLabel: String(fd.get("clubLabel") || "").trim(),
        youtubeStreamKey: String(fd.get("youtubeStreamKey") || "").trim(),
        youtubeVideoId: String(fd.get("youtubeVideoId") || "").trim(),
      });
      toast("Settings saved");
      refreshHubStatus();
    });

    document.getElementById("btn-test-hub").addEventListener("click", async () => {
      const input = document.getElementById("hubUrl");
      if (input?.value) SWHub.saveSettings({ hubUrl: input.value.trim() });
      const box = document.getElementById("hub-test-result");
      box.hidden = false;
      box.innerHTML = `<p class="muted">Testing…</p>`;
      try {
        const data = await SWHub.fetchHub();
        box.innerHTML = `
          <h2>Hub OK</h2>
          <p>Live matches: <strong>${data.liveCount ?? data.matches?.length ?? 0}</strong></p>
          <p class="muted mono">${esc(JSON.stringify({ message: data.message, source: data.source }).slice(0, 280))}</p>
        `;
        refreshHubStatus();
      } catch (err) {
        box.innerHTML = `<h2>Hub error</h2><p class="muted">${esc(err.message || err)}</p>`;
      }
    });
  }

  async function viewGoLive() {
    setOverlayMode(false);
    setNav("go-live");
    const s = SWHub.loadSettings();

    main().innerHTML = `
      <h1>Go Live</h1>
      <p class="lead">Pick a live match from the hub, preview camera + overlay. Full phone→YouTube RTMP is next.</p>

      <div class="card">
        <div class="row-actions" style="margin-bottom:12px">
          <button type="button" class="btn btn-sm" id="btn-refresh-matches">Refresh matches</button>
          <span class="badge badge-live" id="live-count-badge">…</span>
        </div>
        <div id="match-list" class="match-list"><p class="empty">Loading hub…</p></div>
      </div>

      <div class="card">
        <h2>Camera preview</h2>
        <div class="preview-wrap" id="preview-wrap">
          <video id="cam" playsinline muted autoplay></video>
          <div class="preview-placeholder" id="cam-ph">Camera off — tap Enable camera</div>
          <div class="preview-overlay-slot" id="preview-overlay"></div>
        </div>
        <div class="row-actions" style="margin-top:12px">
          <button type="button" class="btn" id="btn-cam">Enable camera</button>
          <button type="button" class="btn btn-live" id="btn-go-live">Go Live</button>
          <a class="btn btn-ghost" href="#/overlay" target="_blank" rel="noopener">Overlay only</a>
        </div>
        <p class="hint muted" id="go-live-note" style="margin-top:12px">
          MVP: Go Live keeps this page as your control room. Paste the overlay URL into OBS Browser Source
          while you stream from YouTube Studio / Streamlabs with key
          ${s.youtubeStreamKey ? "saved" : "(add stream key in Setup)"}.
        </p>
      </div>
    `;

    const listEl = document.getElementById("match-list");
    const badge = document.getElementById("live-count-badge");
    const previewOverlay = document.getElementById("preview-overlay");

    async function paintMatches() {
      try {
        const { list, message, liveCount } = await loadMatches();
        badge.textContent = `${liveCount} live`;
        const selectedId = SWHub.loadSettings().selectedMatchId;

        if (!list.length) {
          listEl.innerHTML = `<p class="empty">${esc(message || "No live matches right now. Start scoring on Play-Cricket, then refresh.")}</p>`;
          SWOverlay.mount(previewOverlay, null, { compact: true, brand: s.clubLabel || "Scorers Window" });
          return;
        }

        listEl.innerHTML = list
          .map((m) => {
            const sel = m.id === selectedId ? " selected" : "";
            return `
              <button type="button" class="match-item${sel}" data-id="${escAttr(m.id)}" data-site="${escAttr(m.site)}">
                <span class="teams">${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</span>
                <span class="scores">${esc(m.homeScore)} · ${esc(m.awayScore)}</span>
                <span class="meta">${esc(m.status || "Live")} · #${esc(m.id)}${m.site ? ` · ${esc(shortUrl(m.site))}` : ""}</span>
              </button>`;
          })
          .join("");

        listEl.querySelectorAll(".match-item").forEach((btn) => {
          btn.addEventListener("click", () => {
            SWHub.saveSettings({
              selectedMatchId: btn.getAttribute("data-id"),
              selectedSite: btn.getAttribute("data-site") || "",
            });
            paintMatches();
            refreshOverlayPreview();
          });
        });

        await refreshOverlayPreview();
      } catch (e) {
        listEl.innerHTML = `<p class="empty">Hub error: ${esc(e.message || e)}</p>`;
        badge.textContent = "error";
      }
    }

    async function refreshOverlayPreview() {
      const m = await resolveActiveMatch();
      SWOverlay.mount(previewOverlay, m, {
        compact: true,
        brand: SWHub.loadSettings().clubLabel || "Scorers Window",
      });
    }

    document.getElementById("btn-refresh-matches").addEventListener("click", () => paintMatches());

    document.getElementById("btn-cam").addEventListener("click", async () => {
      try {
        stopCamera();
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
        const video = document.getElementById("cam");
        video.srcObject = mediaStream;
        document.getElementById("cam-ph").style.display = "none";
        toast("Camera on");
      } catch (e) {
        toast("Camera denied or unavailable");
        console.warn(e);
      }
    });

    document.getElementById("btn-go-live").addEventListener("click", () => {
      const set = SWHub.loadSettings();
      if (!set.selectedMatchId && !cachedMatches[0]) {
        toast("Select a live match first (or wait for hub)");
        return;
      }
      if (!set.selectedMatchId && cachedMatches[0]) {
        SWHub.saveSettings({
          selectedMatchId: cachedMatches[0].id,
          selectedSite: cachedMatches[0].site || "",
        });
      }
      toast("Control room live — open Overlay in OBS; RTMP publish coming soon");
      location.hash = "#/overlay";
    });

    await paintMatches();
    stopActivePoll();
    stopPoll = SWHub.poll(async () => {
      if (route().path !== "/go-live") return;
      await paintMatches();
    }, SWHub.POLL_MS);
  }

  async function viewOverlay() {
    setOverlayMode(true);
    setNav("overlay");
    main().innerHTML = `<div class="overlay-root" id="overlay-root"></div>`;
    const root = document.getElementById("overlay-root");
    const brand = SWHub.loadSettings().clubLabel || "Scorers Window";

    async function tick() {
      try {
        const m = await resolveActiveMatch();
        SWOverlay.mount(root, m, { brand });
        // Auto-end hook placeholder: when completed, UI shows RESULT
        if (m?.completed) {
          root.dataset.completed = "1";
        }
      } catch (e) {
        SWOverlay.mount(root, null, { brand, extra: e.message || "hub error" });
      }
    }

    await tick();
    stopActivePoll();
    stopPoll = SWHub.poll(tick, 12_000);
  }

  async function viewBoard() {
    setOverlayMode(false);
    setNav("board");
    main().classList.add("main--wide");
    const s = SWHub.loadSettings();
    const yt = (s.youtubeVideoId || "").trim();

    main().innerHTML = `
      <h1>Live board</h1>
      <p class="lead">Viewer page — scores from the hub${yt ? " + YouTube embed" : ". Add a YouTube video ID in Setup to embed the feed."}</p>
      <div class="board-shell">
        ${
          yt
            ? `<div class="yt-embed">
                <iframe
                  src="https://www.youtube.com/embed/${escAttr(yt)}?autoplay=1&mute=1"
                  title="YouTube live"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowfullscreen
                  referrerpolicy="strict-origin-when-cross-origin"
                ></iframe>
              </div>`
            : `<div class="card"><p class="muted" style="margin:0">No YouTube video ID set. Example Brailsford weekend: <span class="mono">ZHVBULQZB94</span></p></div>`
        }
        <div class="board-score" id="board-score"></div>
        <div class="row-actions">
          <button type="button" class="btn btn-sm" id="btn-board-refresh">Refresh score</button>
          <a class="btn btn-sm btn-ghost" href="#/setup">Setup</a>
        </div>
      </div>
    `;

    const box = document.getElementById("board-score");

    async function tick() {
      try {
        const m = await resolveActiveMatch();
        SWOverlay.mount(box, m, { brand: s.clubLabel || "Scorers Window" });
      } catch (e) {
        SWOverlay.mount(box, null, { brand: "Scorers Window", extra: e.message });
      }
    }

    document.getElementById("btn-board-refresh")?.addEventListener("click", tick);
    await tick();
    stopActivePoll();
    stopPoll = SWHub.poll(tick, SWHub.POLL_MS);
  }

  function viewNotFound() {
    setOverlayMode(false);
    setNav("");
    main().innerHTML = `<h1>Not found</h1><p class="lead"><a href="#/">Back home</a></p>`;
  }

  /* ——— helpers ——— */

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

  function shortUrl(u) {
    return String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  /* ——— router ——— */

  async function render() {
    stopActivePoll();
    // Keep camera only on go-live
    const { path } = route();
    if (path !== "/go-live") stopCamera();

    try {
      if (path === "/" || path === "") await Promise.resolve(viewHome());
      else if (path === "/setup") viewSetup();
      else if (path === "/go-live") await viewGoLive();
      else if (path === "/overlay") await viewOverlay();
      else if (path === "/board") await viewBoard();
      else viewNotFound();
    } catch (e) {
      console.error(e);
      main().innerHTML = `<div class="card"><h2>Error</h2><p class="muted">${esc(e.message || e)}</p></div>`;
    }
  }

  window.addEventListener("hashchange", () => {
    render();
  });

  window.addEventListener("DOMContentLoaded", () => {
    if (!location.hash) location.hash = "#/";
    render();
    refreshHubStatus();
    setInterval(refreshHubStatus, 60_000);
  });
})();
