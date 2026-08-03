/**
 * Scorers Window — weekend demo scorecard (when hub has no live games)
 *
 * Source: Play-Cricket print scorecard
 * https://lpcc.play-cricket.com/website/results/7224658/print
 * Saturday 1 August 2026 · DCCL Division 3 South
 * Lullington Park CC 1st XI vs Brailsford & Ednaston CC 1st XI
 */
(function (global) {
  const WEEKEND_DEMO = {
    id: "7224658",
    site: "https://lpcc.play-cricket.com",
    homeTeam: "Lullington Park CC - 1st XI",
    awayTeam: "Brailsford & Ednaston CC - 1st XI",
    /** LPCC batted first */
    homeScore: "190 all out (43.3)",
    /** Brailsford chase */
    awayScore: "194/6 (35.1)",
    status: "Brailsford & Ednaston CC won",
    result: "BRAILSFORD & EDNASTON CC - 1ST XI WON",
    live: false,
    completed: true,
    demo: true,
    date: "Saturday 1 August 2026",
    competition: "Derbyshire County Cricket League — Division 3 South",
    toss: "Lullington Park CC - 1st XI won the toss and elected to bat",
    playCricketUrl: "https://lpcc.play-cricket.com/website/results/7224658",
    polledAt: "2026-08-01T18:30:00.000Z",
    board: {
      demo: true,
      label: "Weekend demo · Sat 1 Aug 2026",
    },
  };

  function getWeekendDemo() {
    return { ...WEEKEND_DEMO, board: { ...WEEKEND_DEMO.board } };
  }

  function isDemoId(id) {
    return String(id || "") === WEEKEND_DEMO.id || String(id || "") === "demo";
  }

  global.SWDemo = {
    WEEKEND_DEMO,
    getWeekendDemo,
    isDemoId,
  };
})(typeof window !== "undefined" ? window : globalThis);
