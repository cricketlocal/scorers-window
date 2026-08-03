# Scorers Window

**Live cricket score overlay + YouTube Go Live** for club cricket.

Phone / PWA → pick match → **Go Live** → camera + **our** Play-Cricket scoreboard → YouTube.  
Viewers can also open the LIVE board (and later embed the same YouTube feed).

## Product flow

1. Open the PWA  
2. Add YouTube live credentials (stream key or OAuth later)  
3. Pick the game (home club default)  
4. Tap **Go Live**  
5. Stream **auto-ends** when the match is completed on Play-Cricket  

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
| `/#/live` | **Phone broadcast** — full-screen camera + score overlay |
| `/#/overlay` | **OBS only** — transparent score graphics (no camera) |
| `/#/watch` | **Viewers (share this)** — scores, no settings; optional `?v=YOUTUBE_ID` |
| `/#/board` | Same as Watch (legacy alias) |

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
