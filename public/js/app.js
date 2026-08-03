/**
 * Scorers Window — hash SPA
 * Routes: / #/setup #/go-live #/overlay #/board
 */
(function () {
  const { SWHub, SWOverlay, SWDemo } = window;
  const main = () => document.getElementById("main");
  const hubStatusEl = () => document.getElementById("hub-status");

  let stopPoll = null;
  let mediaStream = null;
  let cachedMatches = [];
  let activeMatch = null;
  /** True while user is in a Go Live session on the control-room page */
  let onAir = false;

  function cameraIsLive() {
    return !!(mediaStream && mediaStream.getTracks().some((t) => t.readyState === "live"));
  }

  function bindCameraToVideo() {
    const video = document.getElementById("cam");
    const ph = document.getElementById("cam-ph");
    if (!video) return;
    if (cameraIsLive()) {
      if (video.srcObject !== mediaStream) video.srcObject = mediaStream;
      video.play?.().catch(() => {});
      if (ph) ph.style.display = "none";
    } else if (ph) {
      ph.style.display = "";
    }
  }

  async function startCamera() {
    if (cameraIsLive()) {
      bindCameraToVideo();
      return mediaStream;
    }
    stopCamera();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    bindCameraToVideo();
    return mediaStream;
  }

  function updateOnAirUi() {
    const btn = document.getElementById("btn-go-live");
    const end = document.getElementById("btn-end-live");
    const pill = document.getElementById("on-air-pill");
    const note = document.getElementById("go-live-note");
    if (btn) {
      btn.textContent = onAir ? "On Air" : "Go Live";
      btn.disabled = onAir;
      btn.classList.toggle("btn-live", !onAir);
    }
    if (end) end.hidden = !onAir;
    if (pill) {
      pill.hidden = !onAir;
      pill.textContent = onAir ? (cameraIsLive() ? "ON AIR · camera on" : "ON AIR · camera off") : "";
    }
    if (note && onAir) {
      note.textContent =
        "On air — camera stays on this page. Overlay is open for OBS (or open it again below). RTMP publish to YouTube comes next.";
    }
  }

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
    const video = document.getElementById("cam");
    if (video) video.srcObject = null;
    const ph = document.getElementById("cam-ph");
    if (ph) ph.style.display = "";
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

  function selectDemoMatch() {
    const d = SWHub.getDemoMatch();
    if (!d) {
      toast("Demo match not available");
      return null;
    }
    SWHub.saveSettings({
      selectedMatchId: d.id,
      selectedSite: d.site || "https://lpcc.play-cricket.com",
      clubLabel: SWHub.loadSettings().clubLabel || "Lullington Park CC",
      useDemoWhenIdle: true,
    });
    activeMatch = d;
    return d;
  }

  async function loadMatches() {
    let data = { matches: [], message: null, liveCount: 0 };
    try {
      data = await SWHub.fetchHub();
    } catch (e) {
      data = { matches: [], message: e.message || "Hub offline", liveCount: 0, hubError: true };
    }
    const liveList = (data.matches || []).map((m) => SWHub.normaliseMatch(m)).filter((m) => m?.id);
    const demo = SWHub.getDemoMatch();
    // Always include weekend demo so it can be selected
    let list = liveList.slice();
    if (demo && !list.some((m) => m.id === demo.id)) {
      list = [...list, demo];
    }
    cachedMatches = list;
    return {
      list,
      liveList,
      demo,
      message: data.message || null,
      liveCount: data.liveCount ?? liveList.length,
      usingDemoOnly: liveList.length === 0 && !!demo,
      hubError: !!data.hubError,
    };
  }

  async function resolveActiveMatch() {
    const settings = SWHub.loadSettings();
    const { list, demo } = await loadMatches();

    // Explicit weekend demo id
    if (settings.selectedMatchId && (SWDemo?.isDemoId?.(settings.selectedMatchId) || settings.selectedMatchId === demo?.id)) {
      activeMatch = demo || SWHub.getDemoMatch();
      return activeMatch;
    }

    if (settings.selectedMatchId) {
      let m = list.find((x) => x.id === settings.selectedMatchId && !x.demo);
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
      if (m) {
        activeMatch = m;
        return m;
      }
    }

    // Prefer a real live match; otherwise weekend demo
    const live = list.find((x) => x.live && !x.demo);
    activeMatch = live || demo || list[0] || null;
    return activeMatch;
  }

  /* ——— Views ——— */

  function viewHome() {
    setOverlayMode(false);
    setNav("home");
    const s = SWHub.loadSettings();
    const demo = SWHub.getDemoMatch();
    const hasKey = !!s.youtubeStreamKey;
    const hasYt = !!s.youtubeVideoId;
    const hasMatch = !!s.selectedMatchId;
    const demoActive = demo && (s.selectedMatchId === demo.id || SWDemo?.isDemoId?.(s.selectedMatchId));

    main().innerHTML = `
      <h1>Scorers Window</h1>
      <p class="lead">Phone / PWA → pick match → Go Live → camera + <strong>our</strong> Play-Cricket overlay → YouTube.</p>

      <div class="card">
        <h2>Weekend demo score</h2>
        <p class="muted" style="margin:0 0 8px">
          <strong>${esc(demo?.date || "Sat 1 Aug 2026")}</strong> · ${esc(demo?.competition || "DCCL Div 3 South")}
        </p>
        <p style="margin:0 0 4px;font-weight:700">${esc(demo?.homeTeam || "LPCC")} <span class="muted">vs</span> ${esc(demo?.awayTeam || "Brailsford")}</p>
        <p style="margin:0 0 8px;color:var(--accent);font-weight:800;font-variant-numeric:tabular-nums">
          ${esc(demo?.homeScore || "—")} &nbsp;·&nbsp; ${esc(demo?.awayScore || "—")}
        </p>
        <p class="muted" style="margin:0 0 12px;font-size:0.85rem">${esc(demo?.status || "")} · Play-Cricket #${esc(demo?.id || "")}</p>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="btn-select-demo">Select demo match</button>
          <a class="btn" href="#/overlay" id="btn-open-overlay-demo">Open overlay</a>
          <a class="btn btn-ghost" href="#/go-live">Go Live</a>
        </div>
        <p class="muted" id="demo-selected-label" style="margin:10px 0 0;font-size:0.85rem">
          ${demoActive ? "✓ Demo match is selected" : "Not selected yet — tap the button above"}
        </p>
      </div>

      <div class="card">
        <h2>Setup checklist</h2>
        <ul class="checklist">
          <li class="${s.hubUrl ? "done" : ""}"><span class="dot"></span><span>Hub connected (${esc(shortUrl(s.hubUrl))})</span></li>
          <li class="${hasKey ? "done" : ""}"><span class="dot"></span><span>YouTube stream key saved ${hasKey ? "" : "(optional for MVP overlay)"}</span></li>
          <li class="${hasYt ? "done" : ""}"><span class="dot"></span><span>YouTube video ID for embed ${hasYt ? `(${esc(s.youtubeVideoId)})` : ""}</span></li>
          <li class="${hasMatch || demoActive ? "done" : ""}"><span class="dot"></span><span>Match selected ${demoActive ? "(weekend demo)" : hasMatch ? `(#${esc(s.selectedMatchId)})` : ""}</span></li>
        </ul>
        <div class="row-actions">
          <a class="btn btn-primary" href="#/setup">Setup</a>
          <a class="btn btn-live" href="#/go-live">Go Live</a>
        </div>
      </div>

      <div class="card">
        <h2>Overlay for OBS</h2>
        <p class="muted" style="margin:0 0 12px">Use as a <strong>Browser Source</strong> (transparent background). Shows weekend demo until a live hub match is selected.</p>
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

    document.getElementById("btn-select-demo")?.addEventListener("click", () => {
      if (!selectDemoMatch()) return;
      const label = document.getElementById("demo-selected-label");
      if (label) label.textContent = "✓ Demo match is selected";
      toast("Demo match selected");
    });

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
      <p class="lead">Pick a live match from the hub, or select the weekend demo. Full phone→YouTube RTMP is next.</p>

      <div class="card demo-select-card">
        <h2>Weekend demo</h2>
        <p class="muted" style="margin:0 0 10px;font-size:0.9rem">
          Sat 1 Aug · LPCC 1st XI vs Brailsford · <strong>190 all out</strong> · <strong>194/6</strong>
        </p>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="btn-select-demo">Select demo match</button>
          <a class="btn btn-ghost" href="#/overlay">Show on overlay</a>
        </div>
        <p class="muted" id="demo-selected-label" style="margin:10px 0 0;font-size:0.85rem"></p>
      </div>

      <div class="card">
        <h2>Matches</h2>
        <div class="row-actions" style="margin-bottom:12px">
          <button type="button" class="btn btn-sm" id="btn-refresh-matches">Refresh matches</button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-select-demo-2">Select demo match</button>
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
          <button type="button" class="btn btn-ghost" id="btn-end-live" hidden>End Live</button>
          <a class="btn btn-ghost" href="#/overlay" target="_blank" rel="noopener" id="btn-overlay-tab">Overlay (new tab)</a>
        </div>
        <p class="badge badge-live" id="on-air-pill" hidden style="margin-top:12px"></p>
        <p class="hint muted" id="go-live-note" style="margin-top:12px">
          Go Live stays on this page with the camera on. Overlay opens in a <strong>new tab</strong> for OBS
          (does not turn the camera off). Stream key ${s.youtubeStreamKey ? "saved" : "optional in Setup"}.
        </p>
      </div>
    `;

    const listEl = document.getElementById("match-list");
    const badge = document.getElementById("live-count-badge");
    const previewOverlay = document.getElementById("preview-overlay");

    function updateDemoLabel() {
      const d = SWHub.getDemoMatch();
      const sel = SWHub.loadSettings().selectedMatchId;
      const on = d && (sel === d.id || SWDemo?.isDemoId?.(sel));
      const text = on ? "✓ Demo match is selected" : "Demo not selected";
      document.querySelectorAll("#demo-selected-label").forEach((el) => {
        el.textContent = text;
      });
    }

    function onSelectDemo() {
      if (!selectDemoMatch()) return;
      updateDemoLabel();
      toast("Demo match selected");
      paintMatches();
      refreshOverlayPreview();
    }

    async function paintMatches() {
      try {
        const { list, message, liveCount, usingDemoOnly, hubError } = await loadMatches();
        badge.textContent = usingDemoOnly ? "demo" : `${liveCount} live`;
        const selectedId = SWHub.loadSettings().selectedMatchId;
        updateDemoLabel();

        if (!list.length) {
          listEl.innerHTML = `<p class="empty">${esc(message || "No matches.")}</p>
            <button type="button" class="btn btn-primary" id="btn-select-demo-empty" style="width:100%;margin-top:10px">Select demo match</button>`;
          document.getElementById("btn-select-demo-empty")?.addEventListener("click", onSelectDemo);
          SWOverlay.mount(previewOverlay, null, { compact: true, brand: s.clubLabel || "Scorers Window" });
          return;
        }

        listEl.innerHTML =
          (usingDemoOnly || hubError
            ? `<p class="muted" style="margin:0 0 10px;font-size:0.85rem">${hubError ? "Hub offline — " : "No live hub matches — "}use <strong>Select demo match</strong> or tap the DEMO row.</p>`
            : `<p class="muted" style="margin:0 0 10px;font-size:0.85rem">Tap a row to select, or use <strong>Select demo match</strong>.</p>`) +
          list
            .map((m) => {
              const sel = m.id === selectedId ? " selected" : "";
              const tag = m.demo ? "DEMO" : m.live ? "LIVE" : m.completed ? "RESULT" : "MATCH";
              const selectLabel = m.id === selectedId ? "Selected" : m.demo ? "Select demo" : "Select";
              return `
              <button type="button" class="match-item${sel}" data-id="${escAttr(m.id)}" data-site="${escAttr(m.site)}" data-demo="${m.demo ? "1" : "0"}">
                <span class="teams">${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</span>
                <span class="scores">${esc(m.homeScore)} · ${esc(m.awayScore)}</span>
                <span class="meta"><span class="badge ${m.demo ? "" : "badge-live"}" style="${m.demo ? "background:rgba(251,191,36,0.2);color:#fde68a" : ""}">${tag}</span>
                  ${esc(m.date || m.status || "")} · #${esc(m.id)} · <strong>${selectLabel}</strong></span>
              </button>`;
            })
            .join("");

        listEl.querySelectorAll(".match-item").forEach((btn) => {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-id");
            const isDemo = btn.getAttribute("data-demo") === "1";
            if (isDemo) {
              selectDemoMatch();
            } else {
              SWHub.saveSettings({
                selectedMatchId: id,
                selectedSite: btn.getAttribute("data-site") || "",
              });
            }
            toast(isDemo ? "Demo match selected" : "Match selected");
            paintMatches();
            refreshOverlayPreview();
          });
        });

        await refreshOverlayPreview();
      } catch (e) {
        const demo = SWHub.getDemoMatch();
        badge.textContent = "demo";
        listEl.innerHTML = `
          <p class="muted" style="margin:0 0 10px;font-size:0.85rem">Could not load hub. (${esc(e.message || e)})</p>
          <button type="button" class="btn btn-primary" id="btn-select-demo-err" style="width:100%;margin-bottom:10px">Select demo match</button>
          ${
            demo
              ? `<button type="button" class="match-item" data-id="${escAttr(demo.id)}" data-site="${escAttr(demo.site)}" data-demo="1">
              <span class="teams">${esc(demo.homeTeam)} vs ${esc(demo.awayTeam)}</span>
              <span class="scores">${esc(demo.homeScore)} · ${esc(demo.awayScore)}</span>
              <span class="meta">DEMO · ${esc(demo.date)} · #${esc(demo.id)}</span>
            </button>`
              : ""
          }`;
        document.getElementById("btn-select-demo-err")?.addEventListener("click", onSelectDemo);
        listEl.querySelector(".match-item")?.addEventListener("click", onSelectDemo);
      }
    }

    async function refreshOverlayPreview() {
      const m = await resolveActiveMatch();
      SWOverlay.mount(previewOverlay, m, {
        compact: true,
        brand: m?.demo ? "DEMO · LPCC" : SWHub.loadSettings().clubLabel || "Scorers Window",
      });
    }

    document.getElementById("btn-refresh-matches").addEventListener("click", () => paintMatches());
    document.getElementById("btn-select-demo")?.addEventListener("click", onSelectDemo);
    document.getElementById("btn-select-demo-2")?.addEventListener("click", onSelectDemo);
    updateDemoLabel();

    document.getElementById("btn-cam").addEventListener("click", async () => {
      try {
        await startCamera();
        toast("Camera on");
        updateOnAirUi();
      } catch (e) {
        toast("Camera denied or unavailable");
        console.warn(e);
      }
    });

    document.getElementById("btn-go-live").addEventListener("click", async () => {
      const set = SWHub.loadSettings();
      if (!set.selectedMatchId && !cachedMatches[0]) {
        toast("Select a match or demo first");
        return;
      }
      if (!set.selectedMatchId && cachedMatches[0]) {
        SWHub.saveSettings({
          selectedMatchId: cachedMatches[0].id,
          selectedSite: cachedMatches[0].site || "",
        });
      }

      // Stay on Go Live — do NOT navigate to overlay (that was killing the camera)
      try {
        await startCamera();
      } catch (e) {
        toast("Allow camera to go live, or use Overlay-only in a new tab");
        console.warn(e);
        // Still mark on-air for score overlay workflow without camera
      }

      onAir = true;
      updateOnAirUi();
      await refreshOverlayPreview();

      // Open overlay in a separate tab so this page keeps the camera
      const overlayUrl = `${location.origin}${location.pathname}#/overlay`;
      try {
        window.open(overlayUrl, "sw-overlay", "noopener,noreferrer");
      } catch {
        /* popup blocked — user can use Overlay (new tab) link */
      }

      toast("On air — camera stays here; overlay opened for OBS");
    });

    document.getElementById("btn-end-live")?.addEventListener("click", () => {
      onAir = false;
      stopCamera();
      updateOnAirUi();
      toast("Live ended — camera off");
    });

    // Re-bind camera if we still hold a stream (e.g. soft re-entry)
    bindCameraToVideo();
    updateOnAirUi();

    await paintMatches();
    stopActivePoll();
    stopPoll = SWHub.poll(async () => {
      if (route().path !== "/go-live") return;
      // Only refresh match list + score strip — never tear down the <video>
      await paintMatches();
      bindCameraToVideo();
      updateOnAirUi();
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
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="btn-select-demo">Select demo match</button>
          <button type="button" class="btn btn-sm" id="btn-board-refresh">Refresh score</button>
          <a class="btn btn-sm btn-ghost" href="#/setup">Setup</a>
        </div>
        <div class="board-score" id="board-score"></div>
      </div>
    `;

    const box = document.getElementById("board-score");

    async function tick() {
      try {
        const m = await resolveActiveMatch();
        SWOverlay.mount(box, m, { brand: m?.demo ? "DEMO · LPCC" : s.clubLabel || "Scorers Window" });
      } catch (e) {
        SWOverlay.mount(box, null, { brand: "Scorers Window", extra: e.message });
      }
    }

    document.getElementById("btn-select-demo")?.addEventListener("click", () => {
      if (!selectDemoMatch()) return;
      toast("Demo match selected");
      tick();
    });
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
    const { path } = route();
    // Leaving Go Live ends the session and releases the camera
    if (path !== "/go-live") {
      if (onAir) onAir = false;
      stopCamera();
    }

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
