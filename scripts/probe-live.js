const https = require("https");
const { URL } = require("url");

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html",
      },
    };
    https
      .get(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : `https://${u.hostname}${res.headers.location}`;
          res.resume();
          return resolve(get(next, redirects + 1));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, finalUrl: url, body, redirects })
        );
      })
      .on("error", reject);
  });
}

(async () => {
  const start = "https://www.youtube.com/@LullingtonLive/live";
  const r = await get(start);
  console.log("status", r.status, "finalUrl", r.finalUrl, "len", r.body.length);
  const html = r.body;

  const fromUrl = String(r.finalUrl).match(/(?:v=|\/live\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  console.log("idFromFinalUrl", fromUrl && fromUrl[1]);

  const channelIds = [...html.matchAll(/"(?:channelId|externalId)":"(UC[^"]+)"/g)].map((m) => m[1]);
  console.log("channelIds", [...new Set(channelIds)].slice(0, 8));

  const liveNowIds = [];
  const re1 = /"isLiveNow":true[\s\S]{0,400}?"videoId":"([a-zA-Z0-9_-]{11})"/g;
  const re2 = /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,400}?"isLiveNow":true/g;
  let m;
  while ((m = re1.exec(html))) liveNowIds.push(m[1]);
  while ((m = re2.exec(html))) liveNowIds.push(m[1]);
  console.log("liveNow videoIds", [...new Set(liveNowIds)]);

  const vd = html.match(/"videoDetails":\{"videoId":"([a-zA-Z0-9_-]{11})"/);
  console.log("videoDetails", vd && vd[1]);

  const title = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
  console.log("title", title && title[1]);

  // ytInitialPlayerResponse
  const pr = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (pr) {
    try {
      const j = JSON.parse(pr[1].slice(0, 500000));
      console.log(
        "playerResponse videoId",
        j?.videoDetails?.videoId,
        "isLive",
        j?.videoDetails?.isLive,
        "isLiveContent",
        j?.videoDetails?.isLiveContent
      );
    } catch (e) {
      console.log("playerResponse parse fail", e.message);
    }
  } else {
    console.log("no ytInitialPlayerResponse");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
