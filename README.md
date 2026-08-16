# Sync Audio Player — Owlbear Rodeo extension

Paste a YouTube link, hit **Load**, and everyone in the room hears the same
track at the same position. No build step — it's plain HTML/CSS/JS.

## How it works

- Playback state (`videoId`, playing/paused, position, loop) is saved to the
  **room metadata**, which Owlbear Rodeo automatically syncs to every
  connected player in real time.
- Each client runs its own hidden YouTube player and keeps itself lined up
  with that shared state (auto-corrects if it drifts more than ~1.5s).
- Volume is **not** synced — everyone controls their own volume locally,
  same as Discord/DJinni-style tools.
- The GM can optionally check "Only GM can control playback" to stop players
  from hijacking the queue.

## 1. Host the files

Owlbear Rodeo loads extensions from a public HTTPS URL — it can't load files
from your computer directly. The easiest free options:

**GitHub Pages**
1. Create a new GitHub repo and push everything in this folder to it.
2. Repo Settings → Pages → set source to the `main` branch (root).
3. Your extension will be live at
   `https://<your-username>.github.io/<repo-name>/manifest.json`

**Or Cloudflare Pages / Netlify / Vercel** — drag-and-drop this folder into
any of their dashboards and they'll give you a URL the same way.

## 2. Install it in Owlbear Rodeo

1. Go to owlbear.rodeo and open your profile (bottom left).
2. Click **Add Extension**.
3. Paste the URL to your hosted `manifest.json`, e.g.
   `https://you.github.io/sync-audio-player/manifest.json`
4. Open (or create) a room, and enable the extension for that room in the
   room settings / create-room dialog.
5. Click the new music-note icon in the top-left action bar — that opens the
   player for you and, once installed, for everyone else in the room too.

## 3. Use it

- Paste any YouTube video/link (`youtube.com/watch?v=...`, `youtu.be/...`,
  and Shorts links all work) and click **Load**.
- Play/Pause, seek, and loop are shared with the table.
- 🙈 hides the video box and keeps just audio playing (still counts as
  "loaded", just visually collapsed) — this is a per-device preference.
- 🔊 volume is per-device.

## Notes / limitations

- This streams from YouTube in the background, so it's subject to YouTube's
  usual embed rules (some videos disable embedding entirely).
- Very first playback in a fresh browser tab may need one click somewhere in
  the page first — that's a browser autoplay-policy thing, not a bug.
- Room metadata has a 16kB limit total across all extensions, but this
  extension only stores a tiny JSON blob, so it's effectively a non-issue.
- Want it to auto-advance through a whole playlist? That's the natural next
  step (store an array of tracks + an index) — happy to add it if you want.
