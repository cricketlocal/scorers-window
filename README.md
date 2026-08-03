# Scorers Window

**Live cricket score overlay + YouTube Go Live** for club cricket.

Phone / PWA → pick match → **Go Live** → camera + **our** Play-Cricket scoreboard → YouTube.  
Viewers can also open the LIVE board (and later embed the same YouTube feed).

## Product flow (phone)

1. Open the PWA on the broadcast phone  
2. **Setup once** — paste YouTube **stream key** (reused every week)  
3. **Go Live** → select game (or demo)  
4. Tap **Go Live** → full-screen camera + score composite  
5. Fans: `#/watch` (scores) and/or the YouTube link  

**Note:** Browsers cannot open YouTube RTMP directly. The phone builds a **camera+score composite** and stores the stream key for a cloud publish step. Until that relay is live, use **OBS on a PC** (`#/obs`) to burn the overlay into YouTube.  

## Advanced

- `#/obs` — OBS → YouTube checklist (PC encoder)  
- `#/overlay?obs=1` — Browser Source URL  


## Local

```bash
cd scorers-window
npm run dev
# → http://localhost:5173
```

## Render

1. Create a GitHub repo and push this folder (root = project root)  
2. Render → **New → Blueprint** (uses `render.yaml`) **or** **Static Site**:
   - **Publish directory:** `public`
   - **Build command:** none (or `echo ok`)
   - Rewrite `/*` → `/index.html` (already in `render.yaml`)
3. Service name suggestion: **scorers-window**
4. After deploy, open the site → **Setup** → confirm hub URL  

Default hub: `https://cricket-local-v5-1.onrender.com`  
Settings (stream key, video ID, selected match) are stored in the browser (`localStorage`).

## Weekend demo score

When the live hub has no matches, the app uses a real weekend result for overlay testing:

| | |
|--|--|
| **Date** | Saturday 1 August 2026 |
| **Match** | Lullington Park CC 1st XI vs Brailsford & Ednaston CC 1st XI |
| **Scores** | LPCC **190 all out (43.3)** · Brailsford **194/6 (35.1)** |
| **Result** | Brailsford & Ednaston won |
| **Play-Cricket** | `#7224658` · [print scorecard](https://lpcc.play-cricket.com/website/results/7224658/print) |

Home → **Use demo on overlay**, or open `/#/overlay` (default selection).

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Home — weekend demo + setup checklist + Go Live / Overlay |
| `/#/setup` | YouTube stream key + hub URL (localStorage for now) |
| `/#/go-live` | Pick match (or demo), camera preview, Go Live |
| `/#/live` | **Phone** — full-screen camera + score (local only) |
| `/#/obs` | **OBS → YouTube** guided setup (burn scores into live + VOD) |
| `/#/overlay?obs=1` | **OBS Browser Source** URL — transparent score graphics |
| `/#/watch` | **Viewers** — scores, no settings; optional `?v=YOUTUBE_ID` |
| `/#/board` | Same as Watch (legacy alias) |

### YouTube live with overlay (OBS)

1. Open **https://scorers-window.onrender.com/#/obs**
2. Copy the **Browser Source** URL  
3. OBS: Camera + Browser source (1920×1080, above camera)  
4. OBS Stream → YouTube stream key → **Start Streaming**  
5. Overlay is **inside** the YouTube video (live and watch later) |

## Roadmap

- [x] Project shell + Render config  
- [x] Live hub client + scoreboard overlay  
- [x] Match picker from hub  
- [ ] RTMP / YouTube Live publish from device  
- [ ] Google OAuth “Connect YouTube”  
- [ ] Auto-end stream on match complete  
- [ ] Embed live YouTube on Cricket Local LIVE tab  

## Licence

Private — Cricket Local / Scorers Window.
