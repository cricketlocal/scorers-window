/**
 * Scorers Window — scoreboard overlay renderer (OBS browser source / stream kit)
 */
(function (global) {
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
          <div class="ob-foot">
            <span>Open Go Live to pick a fixture</span>
            <span>${esc(extra)}</span>
          </div>
        </div>`;
    }

    const liveLabel = match.completed ? "RESULT" : match.live ? "LIVE" : "MATCH";
    const status = match.status || (match.completed ? "Completed" : "In progress");
    const polled = match.polledAt
      ? `Updated ${formatAgo(match.polledAt)}`
      : "";

    return `
      <div class="overlay-bar${compact ? " compact" : ""}${match.completed ? " waiting" : ""}" data-sw-overlay data-match-id="${esc(match.id)}">
        <div class="ob-top">
          <span class="ob-live">${esc(liveLabel)}</span>
          <span class="ob-status">${esc(status)}</span>
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
  };
})(typeof window !== "undefined" ? window : globalThis);
