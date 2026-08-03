/**
 * Scorers Window — scoreboard overlay renderer (OBS browser source / stream kit)
 * Teams + score, batters, bowler, last-ball strip (1, 2, Wd, Lb, …)
 */
(function (global) {
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Normalise ball codes for display chips */
  function ballChip(code) {
    const raw = String(code ?? "").trim();
    if (!raw || raw === "·" || raw === "." || raw === "0") {
      return { text: "·", cls: "dot", title: "Dot ball" };
    }
    const u = raw.toUpperCase();
    if (u === "W" || u === "WK" || u === "OUT") {
      return { text: "W", cls: "wicket", title: "Wicket" };
    }
    if (u === "WD" || u === "WIDE" || u.startsWith("WD")) {
      return { text: u.startsWith("WD+") || u.match(/WD\d/) ? raw.replace(/wide/i, "Wd") : "Wd", cls: "extra", title: "Wide" };
    }
    if (u === "NB" || u === "NOBALL" || u.startsWith("NB")) {
      return { text: "Nb", cls: "extra", title: "No ball" };
    }
    if (u === "LB" || u === "LEGBYE" || u.startsWith("LB")) {
      return { text: "Lb", cls: "extra", title: "Leg bye" };
    }
    if (u === "B" || u === "BYE" || (u.startsWith("B") && !u.startsWith("BO"))) {
      if (u === "B" || u === "BYE" || u.startsWith("B+")) {
        return { text: "B", cls: "extra", title: "Bye" };
      }
    }
    if (u === "4" || raw === "4") return { text: "4", cls: "boundary", title: "Four" };
    if (u === "6" || raw === "6") return { text: "6", cls: "six", title: "Six" };
    if (/^[1-3]$/.test(raw)) return { text: raw, cls: "runs", title: `${raw} run${raw === "1" ? "" : "s"}` };
    if (/^[1-6]$/.test(raw)) return { text: raw, cls: "runs", title: `${raw} runs` };
    return { text: raw.slice(0, 4), cls: "other", title: raw };
  }

  function shortName(name) {
    const n = String(name || "").trim();
    if (!n) return "—";
    // "Duncan Player" → "D. Player"; keep single tokens
    const parts = n.replace(/\*|&dagger;|†/g, "").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || "—";
    const last = parts[parts.length - 1];
    const first = parts[0];
    return `${first.charAt(0)}. ${last}`;
  }

  function extractDetail(match) {
    if (!match) return null;
    if (match.detail && (match.detail.batters || match.detail.bowler || match.detail.lastBalls)) {
      return match.detail;
    }
    const board = match.board || {};
    // Common hub / PC shapes
    const step = board.step || board.live || board.snapshot || board.detail || {};
    const batters =
      step.batsmen ||
      step.batters ||
      board.batsmen ||
      board.batters ||
      match.batsmen ||
      match.batters ||
      null;
    const bowler = step.bowler || board.bowler || match.bowler || null;
    const lastBalls =
      step.lastBalls ||
      step.recentOvers ||
      step.recentBalls ||
      board.lastBalls ||
      board.recentOvers ||
      match.lastBalls ||
      null;
    if (!batters && !bowler && !lastBalls) return null;
    return {
      batters: batters || [],
      bowler: bowler || null,
      lastBalls: lastBalls || [],
      lastBall: step.lastBall || board.lastBall || match.lastBall || (lastBalls && lastBalls[lastBalls.length - 1]) || "",
      lastBallLabel: step.lastBallLabel || board.lastBallLabel || "",
      partnership: step.partnership || board.partnership || null,
      situation: step.situation || board.situation || match.status || "",
    };
  }

  function renderBatters(detail, compact) {
    const batters = (detail?.batters || []).slice(0, 2);
    if (!batters.length) {
      return `<div class="ob-players ob-players--empty"><span class="ob-muted">Batters — waiting for live scoring</span></div>`;
    }
    return `
      <div class="ob-players" aria-label="Batters">
        ${batters
          .map((b, i) => {
            const on = !!(b.onStrike || b.striker || b.on_strike);
            const runs = b.runs != null ? b.runs : "—";
            const balls = b.balls != null && b.balls !== "" ? b.balls : null;
            const label = on ? "Striker" : i === 0 ? "Batter" : "Non-striker";
            return `
            <div class="ob-batter${on ? " on-strike" : ""}">
              <span class="ob-role">${esc(label)}${on ? " *" : ""}</span>
              <span class="ob-pname" title="${esc(b.name || "")}">${esc(compact ? shortName(b.name) : b.name || "—")}</span>
              <span class="ob-pruns"><strong>${esc(String(runs))}</strong>${balls != null ? `<span class="ob-balls">(${esc(String(balls))})</span>` : ""}</span>
            </div>`;
          })
          .join("")}
      </div>`;
  }

  function renderBowler(detail, compact) {
    const b = detail?.bowler;
    if (!b || !b.name) {
      return `<div class="ob-bowler ob-players--empty"><span class="ob-muted">Bowler —</span></div>`;
    }
    const figs =
      b.wickets != null && b.runs != null
        ? `${b.wickets}/${b.runs}`
        : b.figures || "";
    const overs = b.overs != null && b.overs !== "" ? `${b.overs} ov` : "";
    return `
      <div class="ob-bowler" aria-label="Bowler">
        <span class="ob-role">Bowler</span>
        <span class="ob-pname" title="${esc(b.name)}">${esc(compact ? shortName(b.name) : b.name)}</span>
        <span class="ob-pruns">${figs ? `<strong>${esc(String(figs))}</strong>` : ""}${overs ? ` <span class="ob-balls">${esc(overs)}</span>` : ""}</span>
      </div>`;
  }

  function renderLastBalls(detail) {
    const balls = Array.isArray(detail?.lastBalls) ? detail.lastBalls.slice(-8) : [];
    const last = detail?.lastBall || (balls.length ? balls[balls.length - 1] : "");
    const lastLabel = detail?.lastBallLabel || "";
    if (!balls.length && !last) {
      return `<div class="ob-balls-row ob-players--empty"><span class="ob-muted">Last ball —</span></div>`;
    }
    const chips = (balls.length ? balls : [last]).map((c, i, arr) => {
      const chip = ballChip(c);
      const isLast = i === arr.length - 1;
      return `<span class="ob-ball ${chip.cls}${isLast ? " last" : ""}" title="${esc(chip.title)}">${esc(chip.text)}</span>`;
    });
    const callout = last
      ? (() => {
          const c = ballChip(last);
          const label = lastLabel || c.title;
          return `<span class="ob-last-callout"><em>Last</em> <strong>${esc(c.text)}</strong> <span>${esc(label)}</span></span>`;
        })()
      : "";
    return `
      <div class="ob-balls-row" aria-label="Recent balls">
        <span class="ob-role">Balls</span>
        <div class="ob-balls">${chips.join("")}</div>
        ${callout}
      </div>`;
  }

  /**
   * @param {object|null} match - normaliseMatch() result
   * @param {object} opts
   * @param {boolean} [opts.compact]
   * @param {string} [opts.brand]
   * @param {string} [opts.extra]
   */
  function renderBar(match, opts = {}) {
    const compact = !!opts.compact;
    const brand = opts.brand || "Scorers Window";
    const extra = opts.extra || "";

    if (!match) {
      return `
        <div class="overlay-bar waiting${compact ? " compact" : ""}" data-sw-overlay>
          <div class="ob-top">
            <span class="ob-live">WAITING</span>
            <span class="ob-status">${esc(brand)}</span>
          </div>
          <div class="ob-teams">
            <div class="ob-team">
              <div class="ob-name">Select a match</div>
              <div class="ob-score">—</div>
            </div>
            <div class="ob-vs">VS</div>
            <div class="ob-team away">
              <div class="ob-name">Hub idle</div>
              <div class="ob-score">—</div>
            </div>
          </div>
          <div class="ob-detail">
            <div class="ob-players ob-players--empty"><span class="ob-muted">Batters —</span></div>
            <div class="ob-bowler ob-players--empty"><span class="ob-muted">Bowler —</span></div>
            <div class="ob-balls-row ob-players--empty"><span class="ob-muted">Last ball —</span></div>
          </div>
          <div class="ob-foot">
            <span>Open Go Live to pick a fixture</span>
            <span>${esc(extra)}</span>
          </div>
        </div>`;
    }

    const liveLabel = match.demo ? "DEMO" : match.completed ? "RESULT" : match.live ? "LIVE" : "MATCH";
    const status = match.status || (match.completed ? "Completed" : "In progress");
    const polled = match.demo
      ? match.date || "Weekend demo"
      : match.polledAt
        ? `Updated ${formatAgo(match.polledAt)}`
        : "";
    const detail = extractDetail(match);

    return `
      <div class="overlay-bar${compact ? " compact" : ""}${match.completed && !match.demo ? " waiting" : ""}${match.demo ? " demo" : ""}" data-sw-overlay data-match-id="${esc(match.id)}">
        <div class="ob-top">
          <span class="ob-live${match.demo ? " ob-demo" : ""}">${esc(liveLabel)}</span>
          <span class="ob-status">${esc(detail?.situation || status)}</span>
        </div>
        <div class="ob-teams">
          <div class="ob-team">
            <div class="ob-name" title="${esc(match.homeTeam)}">${esc(match.homeTeam)}</div>
            <div class="ob-score">${esc(match.homeScore)}</div>
          </div>
          <div class="ob-vs">VS</div>
          <div class="ob-team away">
            <div class="ob-name" title="${esc(match.awayTeam)}">${esc(match.awayTeam)}</div>
            <div class="ob-score">${esc(match.awayScore)}</div>
          </div>
        </div>
        <div class="ob-detail">
          ${renderBatters(detail, compact)}
          ${renderBowler(detail, compact)}
          ${renderLastBalls(detail)}
        </div>
        <div class="ob-foot">
          <span>${esc(brand)}</span>
          <span>${esc(polled || extra || (match.id ? `ID ${match.id}` : ""))}</span>
        </div>
      </div>`;
  }

  function formatAgo(iso) {
    try {
      const t = new Date(iso).getTime();
      if (!t) return "";
      const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (sec < 60) return `${sec}s ago`;
      const min = Math.round(sec / 60);
      if (min < 60) return `${min}m ago`;
      return new Date(iso).toLocaleTimeString();
    } catch {
      return "";
    }
  }

  function mount(el, match, opts) {
    if (!el) return;
    el.innerHTML = renderBar(match, opts);
  }

  global.SWOverlay = {
    renderBar,
    mount,
    formatAgo,
    ballChip,
    extractDetail,
    shortName,
  };
})(typeof window !== "undefined" ? window : globalThis);
