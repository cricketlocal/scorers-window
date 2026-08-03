/**
 * Scorers Window — weekend demo scorecard (when hub has no live games)
 *
 * Source: Play-Cricket print scorecard
 * https://lpcc.play-cricket.com/website/results/7224658/print
 * Saturday 1 August 2026 · DCCL Division 3 South
 * Lullington Park CC 1st XI vs Brailsford & Ednaston CC 1st XI
 *
 * Snapshot styled as late 2nd-innings chase for overlay testing
 * (batters / bowler / last-ball strip).
 */
(function (global) {
  const WEEKEND_DEMO = {
    id: "7224658",
    site: "https://lpcc.play-cricket.com",
    homeTeam: "Lullington Park CC - 1st XI",
    awayTeam: "Brailsford & Ednaston CC - 1st XI",
    /** LPCC batted first */
    homeScore: "190 all out (43.3)",
    /** Brailsford chase — final card; live-style detail below */
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
    /** Live-style graphics (not outs at end of chase + last LPCC bowler) */
    detail: {
      battingTeam: "Brailsford & Ednaston CC - 1st XI",
      bowlingTeam: "Lullington Park CC - 1st XI",
      innings: 2,
      situation: "Chase complete — Brailsford won by 4 wickets",
      batters: [
        {
          name: "Duncan Player",
          runs: 9,
          balls: 6,
          fours: 2,
          sixes: 0,
          onStrike: false,
        },
        {
          name: "Rupert Sanderson",
          runs: 4,
          balls: 5,
          fours: 1,
          sixes: 0,
          onStrike: true,
        },
      ],
      bowler: {
        name: "Alfie Tyers",
        overs: "5.1",
        maidens: 0,
        runs: 27,
        wickets: 3,
        economy: 5.23,
      },
      partnership: { runs: 10, balls: 7 },
      /**
       * Most recent ball last in the array (rightmost on overlay).
       * Codes: 0/· dot, 1–6 runs, 4, 6, W wicket, Wd wide, Nb no-ball,
       * Lb leg-bye, B bye, + runs on extras e.g. Wd+1
       */
      lastBalls: ["1", "·", "Wd", "2", "Lb", "4", "1", "4"],
      lastBall: "4",
      lastBallLabel: "FOUR",
    },
    board: {
      demo: true,
      label: "Weekend demo · Sat 1 Aug 2026",
    },
  };

  function getWeekendDemo() {
    return {
      ...WEEKEND_DEMO,
      board: { ...WEEKEND_DEMO.board },
      detail: {
        ...WEEKEND_DEMO.detail,
        batters: WEEKEND_DEMO.detail.batters.map((b) => ({ ...b })),
        bowler: { ...WEEKEND_DEMO.detail.bowler },
        partnership: { ...WEEKEND_DEMO.detail.partnership },
        lastBalls: [...WEEKEND_DEMO.detail.lastBalls],
      },
    };
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
