/**
 * Scorers Window — phone-first hash SPA
 * Ideal: open link → pick game → Go Live (stream key saved once in Setup).
 * Routes: / #/go-live #/live #/setup #/watch #/obs #/overlay
 */
(function () {
  const { SWHub, SWOverlay, SWDemo, SWStream } = window;
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
        "On air — open Live cam + score for full-screen camera with graphics. OBS score only is transparent (no camera).";
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

  function setOverlayMode(on, { withCamera = false } = {}) {
    document.body.classList.toggle("overlay-mode", !!on && !withCamera);
    document.body.classList.toggle("live-cam-mode", !!withCamera);
    const m = main();
    if (!m) return;
    m.classList.toggle("main--overlay", !!on || !!withCamera);
    m.classList.toggle("main--wide", false);
  }

  function isCameraRoute(path) {
    return path === "/go-live" || path === "/live";
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
    const hasKey = SWStream?.hasStreamKey?.() || !!(s.youtubeStreamKey || "").trim();
    const keyMask = SWStream?.streamKeyMasked?.() || "";
    const demoActive = demo && (s.selectedMatchId === demo.id || SWDemo?.isDemoId?.(s.selectedMatchId));

    main().innerHTML = `
      <h1>Scorers Window</h1>
      <p class="lead phone-flow-lead">
        <strong>On the phone:</strong> open this site → pick the game → <strong>Go Live</strong>.<br/>
        Stream key is entered <strong>once</strong> in Setup — not every match.
      </p>

      <div class="card phone-hero-card">
        <h2>Match day (3 taps)</h2>
        <ol class="obs-steps phone-flow-steps">
          <li><strong>Setup</strong> (once) — paste YouTube stream key</li>
          <li><strong>Go Live</strong> — select game (or demo)</li>
          <li>Tap <strong>Go Live</strong> — camera + scores on air</li>
        </ol>
        <div class="row-actions">
          <a class="btn btn-live" href="#/go-live" style="min-width:160px;font-size:1.05rem">Go Live</a>
          <a class="btn ${hasKey ? "btn-ghost" : "btn-primary"}" href="#/setup">${hasKey ? "Setup ✓" : "Setup stream key"}</a>
        </div>
        <p class="muted" style="margin:12px 0 0;font-size:0.85rem">
          Stream key: ${hasKey ? `<strong class="mono">${esc(keyMask)}</strong> saved on this phone` : "<strong>not set yet</strong> — one-time in Setup"}
        </p>
      </div>

      <div class="card">
        <h2>Quick select demo</h2>
        <p class="muted" style="margin:0 0 8px;font-size:0.9rem">
          ${esc(demo?.homeTeam || "LPCC")} vs ${esc(demo?.awayTeam || "Brailsford")} ·
          <span style="color:var(--accent);font-weight:700">${esc(demo?.homeScore || "")} · ${esc(demo?.awayScore || "")}</span>
        </p>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="btn-select-demo">Select demo match</button>
          <a class="btn btn-ghost" href="#/go-live">Then Go Live →</a>
        </div>
        <p class="muted" id="demo-selected-label" style="margin:10px 0 0;font-size:0.85rem">
          ${demoActive ? "✓ Demo selected" : "Optional — or pick on Go Live"}
        </p>
      </div>

      <div class="card">
        <h2>Fans (no setup)</h2>
        <p class="muted" style="margin:0 0 12px">Share the Watch link — scores only, no stream key.</p>
        <div class="row-actions">
          <a class="btn" href="#/watch">Open Watch</a>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-copy-watch">Copy Watch link</button>
        </div>
      </div>

      <details class="card advanced-details">
        <summary>Advanced: OBS on a PC</summary>
        <p class="muted" style="margin:10px 0 12px">Only if you stream from a laptop, not the one-phone flow.</p>
        <div class="row-actions">
          <a class="btn btn-sm" href="#/obs">OBS → YouTube</a>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-copy-overlay">Copy Browser Source URL</button>
        </div>
      </details>
    `;

    document.getElementById("btn-select-demo")?.addEventListener("click", () => {
      if (!selectDemoMatch()) return;
      const label = document.getElementById("demo-selected-label");
      if (label) label.textContent = "✓ Demo selected";
      toast("Demo match selected — open Go Live");
    });

    document.getElementById("btn-copy-overlay")?.addEventListener("click", () => {
      copyText(obsBrowserSourceUrl(), "OBS Browser Source URL copied");
    });

    document.getElementById("btn-copy-watch")?.addEventListener("click", () => {
      copyText(`${location.origin}${location.pathname}#/watch`, "Watch link copied — send to fans");
    });
  }

  function viewSetup() {
    setOverlayMode(false);
    setNav("setup");
    const s = SWHub.loadSettings();
    const hasKey = !!(s.youtubeStreamKey || "").trim();

    main().innerHTML = `
      <h1>Setup <span class="muted" style="font-size:0.9rem;font-weight:600">(once per phone)</span></h1>
      <p class="lead">Save your YouTube <strong>stream key</strong> here once. Match days only need: pick game → Go Live.</p>

      <form class="card" id="setup-form">
        <div class="field">
          <label for="youtubeStreamKey">YouTube stream key ${hasKey ? "✓ saved" : ""}</label>
          <input id="youtubeStreamKey" name="youtubeStreamKey" type="password" autocomplete="off" value="${escAttr(s.youtubeStreamKey)}" placeholder="xxxx-xxxx-xxxx-xxxx" />
          <p class="hint">
            YouTube Studio → Create → Go live → Stream → <strong>Stream key</strong>.
            Same key every week unless you reset it. Stored only on this phone.
          </p>
        </div>
        <div class="field">
          <label for="clubLabel">Club name on graphics</label>
          <input id="clubLabel" name="clubLabel" type="text" value="${escAttr(s.clubLabel)}" placeholder="Lullington Park CC" />
        </div>
        <div class="field">
          <label for="hubUrl">Score hub URL</label>
          <input id="hubUrl" name="hubUrl" type="url" value="${escAttr(s.hubUrl)}" placeholder="${escAttr(SWHub.DEFAULT_HUB)}" />
          <p class="hint">Default Cricket Local hub — leave as-is unless you know you need to change it.</p>
        </div>
        <div class="field">
          <label for="youtubeVideoId">YouTube video ID (optional, for Watch embed)</label>
          <input id="youtubeVideoId" name="youtubeVideoId" type="text" value="${escAttr(s.youtubeVideoId)}" placeholder="from youtube.com/live/VIDEO_ID" />
          <p class="hint">Not required for Go Live. Only if you share <span class="mono">#/watch?v=…</span> with video.</p>
        </div>
        <div class="row-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <a class="btn btn-live" href="#/go-live">Go Live →</a>
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
      toast(SWStream?.hasStreamKey?.() ? "Saved — stream key ready for Go Live" : "Saved");
      refreshHubStatus();
      viewSetup();
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
    const hasKey = SWStream?.hasStreamKey?.() || !!(s.youtubeStreamKey || "").trim();

    main().innerHTML = `
      <h1>Go Live</h1>
      <p class="lead">1) Select the game &nbsp;·&nbsp; 2) Tap <strong>Go Live</strong>. Stream key is ${hasKey ? "already saved" : "<a href='#/setup'>set once in Setup</a>"}.</p>

      ${
        !hasKey
          ? `<div class="card" style="border-color:rgba(251,191,36,0.5)">
        <p style="margin:0 0 10px"><strong>Stream key not on this phone yet</strong></p>
        <a class="btn btn-primary" href="#/setup">Add stream key (once)</a>
      </div>`
          : `<div class="card" style="padding:12px 16px">
        <p class="muted" style="margin:0;font-size:0.9rem">Stream key <strong class="mono">${esc(SWStream?.streamKeyMasked?.() || "saved")}</strong> — ready</p>
      </div>`
      }

      <div class="card demo-select-card">
        <h2>Select game</h2>
        <div class="row-actions" style="margin-bottom:12px">
          <button type="button" class="btn btn-primary" id="btn-select-demo">Select demo match</button>
          <button type="button" class="btn btn-sm" id="btn-refresh-matches">Refresh live list</button>
          <span class="badge badge-live" id="live-count-badge">…</span>
        </div>
        <p class="muted" id="demo-selected-label" style="margin:0 0 10px;font-size:0.85rem"></p>
        <div id="match-list" class="match-list"><p class="empty">Loading…</p></div>
      </div>

      <div class="card">
        <button type="button" class="btn btn-live" id="btn-go-live" style="width:100%;padding:16px;font-size:1.15rem">Go Live</button>
        <p class="hint muted" id="go-live-note" style="margin-top:12px;text-align:center">
          Opens full-screen camera with scores. Uses your saved stream key — no re-entry.
        </p>
        <p class="badge badge-live" id="on-air-pill" hidden style="margin-top:12px"></p>
        <button type="button" class="btn btn-ghost" id="btn-end-live" hidden style="width:100%;margin-top:8px">End Live</button>
        <!-- hidden cam bind target for optional pre-warm -->
        <video id="cam" playsinline muted autoplay style="display:none"></video>
        <div id="cam-ph" hidden></div>
        <div id="preview-overlay" hidden></div>
        <button type="button" id="btn-cam" hidden></button>
        <button type="button" id="btn-select-demo-2" hidden></button>
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
        // auto demo so one-tap still works
        selectDemoMatch();
      } else if (!set.selectedMatchId && cachedMatches[0]) {
        SWHub.saveSettings({
          selectedMatchId: cachedMatches[0].id,
          selectedSite: cachedMatches[0].site || "",
        });
      }

      if (!SWStream?.hasStreamKey?.() && !(SWHub.loadSettings().youtubeStreamKey || "").trim()) {
        toast("Add stream key once in Setup first");
        location.hash = "#/setup";
        return;
      }

      try {
        await startCamera();
      } catch (e) {
        toast("Allow camera access, then try again");
        console.warn(e);
        return;
      }

      onAir = true;
      sessionStorage.setItem("sw-on-air", "1");
      toast("Going live…");
      location.hash = "#/live";
    });

    document.getElementById("btn-end-live")?.addEventListener("click", () => {
      onAir = false;
      sessionStorage.removeItem("sw-on-air");
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

  /**
   * Full-screen phone broadcast: camera + score (composite feed for publish).
   * URL: #/live — reached from Go Live one-tap flow.
   */
  async function viewLiveCam() {
    setOverlayMode(true, { withCamera: true });
    setNav("go-live");
    onAir = true;
    sessionStorage.setItem("sw-on-air", "1");

    const hasKey = SWStream?.hasStreamKey?.();

    main().innerHTML = `
      <div class="live-stage" id="live-stage">
        <video id="cam" class="live-stage-video" playsinline muted autoplay webkit-playsinline></video>
        <div class="live-stage-ph" id="cam-ph">
          <strong>Starting camera…</strong>
          <span class="muted" style="color:#86efac">Allow camera if prompted</span>
          <button type="button" class="btn btn-primary" id="btn-cam-retry">Enable camera</button>
        </div>
        <div class="live-stage-chrome">
          <span class="live-pill" id="live-pill">Starting…</span>
          <div class="chrome-actions">
            <button type="button" class="btn btn-sm" id="btn-flip-cam">Flip</button>
            <button type="button" class="btn btn-sm btn-ghost" id="btn-end-live-stage">End</button>
          </div>
        </div>
        <div class="live-stage-score">
          <div class="overlay-root" id="overlay-root"></div>
        </div>
        <p class="live-stream-status" id="live-stream-status"></p>
      </div>
    `;

    const root = document.getElementById("overlay-root");
    const brand = SWHub.loadSettings().clubLabel || "Scorers Window";
    const statusEl = document.getElementById("live-stream-status");
    let facing = "environment";

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || "";
    }

    async function startFacing(mode) {
      facing = mode || facing;
      SWStream?.stopComposite?.();
      stopCamera();
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: true,
      });
      bindCameraToVideo();
      const ph = document.getElementById("cam-ph");
      if (ph) ph.hidden = true;
      await startCompositePipeline();
    }

    async function startCompositePipeline() {
      const video = document.getElementById("cam");
      const m = (await resolveActiveMatch()) || SWHub.getDemoMatch();
      // Wait for video dimensions
      await new Promise((r) => {
        if (video.videoWidth) return r();
        video.onloadedmetadata = () => r();
        setTimeout(r, 800);
      });
      if (SWStream && mediaStream && video) {
        SWStream.startComposite(video, mediaStream, m);
        const pub = await SWStream.beginPublish();
        const pill = document.getElementById("live-pill");
        if (pill) {
          pill.textContent = pub.ok ? "ON AIR" : "ON AIR · local";
        }
        setStatus(
          pub.message ||
            (hasKey
              ? "Camera + scores · stream key ready"
              : "Camera + scores · add stream key in Setup for YouTube")
        );
      }
    }

    async function tick() {
      try {
        let m = await resolveActiveMatch();
        if (!m) m = SWHub.getDemoMatch();
        SWOverlay.mount(root, m, {
          brand: m?.demo ? "DEMO · LPCC" : brand,
        });
        SWStream?.updateMatch?.(m);
      } catch (e) {
        const demo = SWHub.getDemoMatch();
        SWOverlay.mount(root, demo, { brand: "DEMO · LPCC", extra: e.message });
        SWStream?.updateMatch?.(demo);
      }
    }

    document.getElementById("btn-cam-retry")?.addEventListener("click", async () => {
      try {
        await startFacing(facing);
        toast("Camera on");
      } catch (e) {
        toast("Camera denied or unavailable");
        console.warn(e);
      }
    });

    document.getElementById("btn-flip-cam")?.addEventListener("click", async () => {
      try {
        await startFacing(facing === "environment" ? "user" : "environment");
      } catch (e) {
        toast("Could not flip camera");
      }
    });

    document.getElementById("btn-end-live-stage")?.addEventListener("click", () => {
      onAir = false;
      sessionStorage.removeItem("sw-on-air");
      SWStream?.endPublish?.();
      stopCamera();
      location.hash = "#/go-live";
    });

    try {
      if (cameraIsLive()) {
        bindCameraToVideo();
        document.getElementById("cam-ph").hidden = true;
        await startCompositePipeline();
      } else {
        await startFacing("environment");
      }
    } catch (e) {
      console.warn(e);
      setStatus("Tap Enable camera");
      toast("Allow camera to go live");
    }

    await tick();
    stopActivePoll();
    stopPoll = SWHub.poll(async () => {
      if (route().path !== "/live") return;
      await tick();
      bindCameraToVideo();
    }, 10_000);
  }

  /**
   * Guided OBS → YouTube setup so overlay is burned into the live (and VOD) feed.
   */
  function viewObsGuide() {
    setOverlayMode(false);
    setNav("obs");
    const s = SWHub.loadSettings();
    const obsUrl = obsBrowserSourceUrl();
    const hasKey = !!(s.youtubeStreamKey || "").trim();
    const matchOk = !!(s.selectedMatchId || SWHub.getDemoMatch());

    // Ensure a match is selected so the browser source has scores immediately
    if (!s.selectedMatchId) selectDemoMatch();

    main().innerHTML = `
      <h1>OBS → YouTube</h1>
      <p class="lead">
        Put our scoreboard <strong>inside</strong> the YouTube live stream. Viewers on YouTube (live and later)
        see camera + scores. You only set this up once per match day.
      </p>

      <div class="card demo-select-card">
        <h2>1. Browser Source URL (copy this)</h2>
        <p class="muted" style="margin:0 0 8px">Paste into OBS as a <strong>Browser</strong> source. Transparent page — scores only.</p>
        <p class="mono obs-url-box" id="obs-url-box">${esc(obsUrl)}</p>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="btn-copy-obs-url">Copy URL</button>
          <a class="btn btn-ghost" href="#/overlay?obs=1" target="_blank" rel="noopener">Preview overlay</a>
          <button type="button" class="btn btn-sm" id="btn-obs-demo">Select demo match</button>
        </div>
        <p class="muted" style="margin:12px 0 0;font-size:0.85rem">
          Match: <strong id="obs-match-label">${esc(SWHub.loadSettings().selectedMatchId || "demo")}</strong>
          ${matchOk ? " · ready" : ""}
        </p>
      </div>

      <div class="card">
        <h2>2. OBS scene layout</h2>
        <ol class="obs-steps">
          <li>Open <strong>OBS Studio</strong> (or Streamlabs).</li>
          <li>Add your <strong>camera</strong> (or phone capture / NDI) as a video source — full canvas.</li>
          <li><strong>+</strong> → <strong>Browser</strong> → Create new → name it <span class="mono">Scorers Overlay</span>.</li>
          <li>Paste the URL from step 1.</li>
          <li>Set size: <strong>Width 1920</strong> · <strong>Height 1080</strong> (or your canvas size).</li>
          <li>Tick <strong>Shutdown source when not visible</strong> = <em>off</em> (keeps scores updating).</li>
          <li>Tick <strong>Refresh browser when scene becomes active</strong> = <em>on</em>.</li>
          <li>Custom CSS (optional, clears white flash):
            <pre class="obs-pre" id="obs-css">body { background-color: rgba(0,0,0,0); margin: 0; overflow: hidden; }</pre>
            <button type="button" class="btn btn-sm btn-ghost" id="btn-copy-obs-css">Copy CSS</button>
          </li>
          <li>Drag the browser source to the <strong>top</strong> of the Sources list (above the camera).</li>
          <li>Resize so the score bar sits along the bottom; leave the rest of the frame empty (transparent).</li>
        </ol>
      </div>

      <div class="card">
        <h2>3. YouTube stream key</h2>
        <ol class="obs-steps">
          <li>YouTube Studio → <strong>Create</strong> → <strong>Go live</strong> → <strong>Stream</strong>.</li>
          <li>Copy <strong>Stream key</strong>.</li>
          <li>OBS → <strong>Settings</strong> → <strong>Stream</strong> → Service: <strong>YouTube - RTMPS</strong> → paste key
            ${hasKey ? "(also saved in our Setup)" : "(or save it in Scorers Window Setup)"}.
          </li>
          <li>Optional: save the key in <a href="#/setup">Setup</a> for your notes (OBS still needs it in Stream settings).</li>
        </ol>
        <div class="row-actions">
          <a class="btn" href="#/setup">Open Setup</a>
          <a class="btn btn-ghost" href="https://studio.youtube.com" target="_blank" rel="noopener">YouTube Studio</a>
        </div>
      </div>

      <div class="card">
        <h2>4. Go live checklist</h2>
        <ul class="checklist">
          <li class="done"><span class="dot"></span><span>Browser source URL copied</span></li>
          <li class="${hasKey ? "done" : ""}"><span class="dot"></span><span>YouTube stream key in OBS${hasKey ? "" : " — add in YT Studio / Setup"}</span></li>
          <li class="done"><span class="dot"></span><span>Camera under overlay in OBS</span></li>
          <li class=""><span class="dot"></span><span>In OBS: <strong>Start Streaming</strong></span></li>
          <li class=""><span class="dot"></span><span>Confirm on YouTube Studio preview: scores visible on the picture</span></li>
        </ul>
        <p class="muted" style="margin:12px 0 0;font-size:0.9rem">
          Once it’s in the encode, <strong>live and watch-later</strong> on YouTube both show the overlay.
        </p>
      </div>

      <div class="card">
        <h2>5. Share with fans</h2>
        <p class="muted" style="margin:0 0 12px">YouTube viewers use the normal live link. Optional companion scores page:</p>
        <div class="row-actions">
          <button type="button" class="btn btn-primary" id="btn-copy-watch-obs">Copy Watch link</button>
          <a class="btn btn-ghost" href="#/watch">Open Watch</a>
        </div>
      </div>
    `;

    document.getElementById("btn-copy-obs-url")?.addEventListener("click", () => {
      copyText(obsBrowserSourceUrl(), "Browser Source URL copied — paste in OBS");
    });
    document.getElementById("btn-copy-obs-css")?.addEventListener("click", () => {
      copyText(
        "body { background-color: rgba(0,0,0,0); margin: 0; overflow: hidden; }",
        "OBS Custom CSS copied"
      );
    });
    document.getElementById("btn-obs-demo")?.addEventListener("click", () => {
      selectDemoMatch();
      const el = document.getElementById("obs-match-label");
      if (el) el.textContent = SWHub.getDemoMatch()?.id || "demo";
      toast("Demo match selected for overlay");
    });
    document.getElementById("btn-copy-watch-obs")?.addEventListener("click", () => {
      copyText(`${location.origin}${location.pathname}#/watch`, "Watch link copied");
    });
  }

  /**
   * OBS / Streamlabs browser source — transparent score graphics only (no camera).
   * URL: #/overlay?obs=1  — clean capture for YouTube burn-in.
   * Phone camera + score (local only): #/live
   */
  async function viewOverlay() {
    setOverlayMode(true, { withCamera: false });
    setNav("overlay");
    const { params } = route();
    // Default clean for OBS-friendly captures; ?tip=1 shows the help banner
    const showTip = params.get("tip") === "1";
    const obsClean = !showTip;

    if (obsClean) {
      document.documentElement.classList.add("obs-capture");
    } else {
      document.documentElement.classList.remove("obs-capture");
    }

    // Always have a match so OBS never opens blank
    const s0 = SWHub.loadSettings();
    if (!s0.selectedMatchId) selectDemoMatch();

    main().innerHTML = `
      ${
        showTip
          ? `<div class="overlay-no-cam-tip" id="overlay-no-cam-tip" role="note">
        <strong>OBS score layer (no camera here)</strong>
        <span>Use this page as a Browser Source in OBS over your camera, then stream to YouTube.</span>
        <a class="btn btn-primary btn-sm" href="#/obs">OBS → YouTube guide</a>
        <a class="btn btn-live btn-sm" href="#/live">Phone Live cam</a>
      </div>`
          : ""
      }
      <div class="overlay-root" id="overlay-root"></div>
    `;
    const root = document.getElementById("overlay-root");
    const brand = SWHub.loadSettings().clubLabel || "Scorers Window";

    async function tick() {
      try {
        let m = await resolveActiveMatch();
        if (!m) m = SWHub.getDemoMatch();
        SWOverlay.mount(root, m, { brand: m?.demo ? "DEMO · LPCC" : brand });
        if (m?.completed) root.dataset.completed = "1";
      } catch (e) {
        const demo = SWHub.getDemoMatch();
        if (demo) SWOverlay.mount(root, demo, { brand: "DEMO · LPCC" });
        else SWOverlay.mount(root, null, { brand, extra: e.message || "hub error" });
      }
    }

    await tick();
    stopActivePoll();
    stopPoll = SWHub.poll(tick, 10_000);
  }

  /**
   * Viewer page — no setup required.
   * Share: https://scorers-window.onrender.com/#/watch
   * Optional YouTube in the link: #/watch?v=VIDEO_ID
   * Shows hub live match, else weekend demo. Auto-refreshes.
   */
  async function viewWatch() {
    setOverlayMode(false);
    setNav("watch");
    main().classList.add("main--wide");
    document.body.classList.add("watch-mode");

    const { params } = route();
    const s = SWHub.loadSettings();
    // Prefer video ID from shared URL so fans need zero localStorage setup
    const ytFromUrl = (params.get("v") || params.get("yt") || params.get("video") || "").trim();
    const yt = ytFromUrl || (s.youtubeVideoId || "").trim();

    // Ensure something is selected for scores without user action
    if (!s.selectedMatchId) {
      selectDemoMatch();
    }

    main().innerHTML = `
      <div class="watch-page">
        <header class="watch-head">
          <h1>Live score</h1>
          <p class="lead watch-lead">Scores update automatically. No login or setup.</p>
        </header>
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
              : `<div class="watch-video-placeholder card">
                  <p style="margin:0 0 6px;font-weight:700">Scoreboard only</p>
                  <p class="muted" style="margin:0;font-size:0.9rem">
                    When a stream is on, open the club’s YouTube live link, or use a shared link with
                    <span class="mono">#/watch?v=VIDEO_ID</span>.
                  </p>
                </div>`
          }
          <div class="board-score watch-score" id="board-score"></div>
          <p class="watch-footnote muted">Powered by Scorers Window · Cricket Local hub</p>
        </div>
      </div>
    `;

    const box = document.getElementById("board-score");

    async function tick() {
      try {
        const m = await resolveActiveMatch();
        // If still nothing, force demo for viewers
        const match = m || SWHub.getDemoMatch();
        SWOverlay.mount(box, match, {
          brand: match?.demo ? "DEMO · LPCC" : s.clubLabel || "Live",
        });
      } catch (e) {
        const demo = SWHub.getDemoMatch();
        if (demo) SWOverlay.mount(box, demo, { brand: "DEMO · LPCC" });
        else SWOverlay.mount(box, null, { brand: "Live", extra: e.message });
      }
    }

    await tick();
    stopActivePoll();
    stopPoll = SWHub.poll(async () => {
      const p = route().path;
      if (p !== "/watch" && p !== "/board") return;
      await tick();
    }, SWHub.POLL_MS);
  }

  /** Alias — same as watch (old links) */
  async function viewBoard() {
    return viewWatch();
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

  /** Clean browser-source URL for OBS (no tip chrome) */
  function obsBrowserSourceUrl() {
    return `${location.origin}${location.pathname}#/overlay?obs=1`;
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || "Copied");
    } catch {
      toast(text);
    }
  }

  /* ——— router ——— */

  async function render() {
    stopActivePoll();
    const { path } = route();
    document.body.classList.remove("watch-mode");
    document.documentElement.classList.remove("obs-capture");
    // Keep camera when moving between Go Live control room and Live cam composite
    if (!isCameraRoute(path)) {
      if (onAir) onAir = false;
      sessionStorage.removeItem("sw-on-air");
      SWStream?.endPublish?.();
      stopCamera();
    }

    try {
      if (path === "/" || path === "") await Promise.resolve(viewHome());
      else if (path === "/setup") viewSetup();
      else if (path === "/go-live") await viewGoLive();
      else if (path === "/live") await viewLiveCam();
      else if (path === "/obs") viewObsGuide();
      else if (path === "/overlay") await viewOverlay();
      else if (path === "/watch" || path === "/board") await viewWatch();
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
