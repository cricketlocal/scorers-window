/**
 * Open Moblin and import YouTube RTMP + scoreboard URL.
 * Moblin only accepts moblin://?<urlencoded JSON> (see MoblinSettingsUrl.swift).
 */
(function (global) {
  const YT_RTMP = "rtmp://a.rtmp.youtube.com/live2";
  const APP_STORE = "https://apps.apple.com/app/moblin/id6466745933";

  function isIos() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function isStandalone() {
    return (
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  }

  function payload({ clubLabel, streamKey, overlayUrl, rtmpBase }) {
    const name = String(clubLabel || "Lullington Live").trim() || "Lullington Live";
    const key = String(streamKey || "").trim();
    const base = String(rtmpBase || YT_RTMP).replace(/\/+$/, "");
    const out = {
      webBrowser: { home: String(overlayUrl || "") },
    };
    // Skip streams when there is no key — Moblin rejects an invalid RTMP URL
    // and then the whole import (including the scoreboard) fails.
    if (key) {
      out.streams = [
        {
          name,
          url: `${base}/${key}`,
          selected: true,
          video: { codec: "H.264/AVC" },
        },
      ];
    }
    return out;
  }

  function deepLink(data) {
    return `moblin://?${encodeURIComponent(JSON.stringify(data))}`;
  }

  /**
   * Must run inside a user tap. <a href="#"> is what previously blocked iOS.
   */
  function launch(url) {
    if (!url || url.indexOf("moblin://") !== 0) return false;
    try {
      const a = document.createElement("a");
      a.setAttribute("href", url);
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* fall through */
    }
    try {
      window.location.href = url;
      return true;
    } catch {
      return false;
    }
  }

  function drawQr(el, text) {
    if (!el) return;
    el.innerHTML = "";
    if (!text || typeof QRCode === "undefined") {
      el.textContent = "QR unavailable";
      return;
    }
    try {
      new QRCode(el, {
        text,
        width: 196,
        height: 196,
        colorDark: "#052e16",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (e) {
      el.textContent = "Could not draw QR";
    }
  }

  global.SWMoblin = {
    YT_RTMP,
    APP_STORE,
    isIos,
    isStandalone,
    payload,
    deepLink,
    launch,
    drawQr,
  };
})(window);
