import OBR from "https://esm.sh/@owlbear-rodeo/sdk@2";

const NAMESPACE = "com.dndsync.audioplayer";
const STATE_KEY = `${NAMESPACE}/state`;
const DRIFT_TOLERANCE = 1.5; // seconds
const RESYNC_INTERVAL = 3000; // ms

const els = {
  urlInput: document.getElementById("urlInput"),
  addForm: document.getElementById("addForm"),
  addBtn: document.getElementById("addBtn"),
  syncDot: document.getElementById("syncDot"),
  lockedBanner: document.getElementById("lockedBanner"),
  statusMsg: document.getElementById("statusMsg"),
  gmLockRow: document.getElementById("gmLockRow"),
  lockCheckbox: document.getElementById("lockCheckbox"),
  channels: document.getElementById("channels"),
  channelsCount: document.getElementById("channelsCount"),
  clearAllBtn: document.getElementById("clearAllBtn"),
  playerHost: document.getElementById("playerHost"),
};

let isGM = false;
let remoteState = null; // { tracks: [...], locked: bool }
let apiPromise = null;
const players = new Map(); // trackId -> { div, player, ready, applyingRemote }

// ---------- helpers ----------

function genId() {
  return "t_" + Math.random().toString(36).slice(2, 9);
}

function extractVideoId(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1).split("/")[0] || null;
    }
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/\/(embed|shorts|live)\/([^/?]+)/);
    if (m) return m[2];
  } catch (e) {
    /* not a valid URL */
  }
  return null;
}

function expectedSeek(track) {
  if (!track) return 0;
  if (!track.playing) return track.seek;
  return track.seek + (Date.now() - track.updatedAt) / 1000;
}

async function fetchTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!res.ok) throw new Error("oembed failed");
    const data = await res.json();
    return data.title || "YouTube audio";
  } catch (e) {
    return "YouTube audio";
  }
}

async function saveState(partial) {
  const base = remoteState || {};
  const next = {
    tracks: base.tracks || [],
    locked: base.locked || false,
    ...partial,
  };
  remoteState = next;
  await OBR.room.setMetadata({ [STATE_KEY]: next });
}

function canControl() {
  return !remoteState?.locked || isGM;
}

function refreshLockUI() {
  const locked = !!remoteState?.locked;
  els.lockedBanner.classList.toggle("hidden", !(locked && !isGM));
  const disabled = locked && !isGM;
  [els.addBtn, els.urlInput, els.clearAllBtn].forEach((el) => (el.disabled = disabled));
  els.channels.classList.toggle("locked-out", disabled);
  if (isGM) {
    els.gmLockRow.classList.remove("hidden");
    els.lockCheckbox.checked = locked;
  }
}

function setStatus(msg, isError = false) {
  if (!msg) {
    els.statusMsg.classList.add("hidden");
    return;
  }
  els.statusMsg.textContent = msg;
  els.statusMsg.classList.remove("hidden");
  els.statusMsg.classList.toggle("error", isError);
}

function localSeekFor(trackId, fallbackTrack) {
  const entry = players.get(trackId);
  if (entry?.ready) {
    try {
      return entry.player.getCurrentTime();
    } catch (e) {
      /* ignore */
    }
  }
  return expectedSeek(fallbackTrack);
}

// ---------- track actions ----------

async function addTrack(rawUrl) {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    setStatus("Couldn't read a YouTube link from that.", true);
    return;
  }
  els.addBtn.disabled = true;
  const title = await fetchTitle(videoId);
  const track = {
    id: genId(),
    videoId,
    title,
    url: rawUrl.trim(),
    playing: true,
    seek: 0,
    updatedAt: Date.now(),
    loop: true, // ambience defaults to looping; flip off per-track if you want it to play once
  };
  const tracks = [...(remoteState?.tracks || []), track];
  await saveState({ tracks });
  refreshLockUI();
}

function toggleTrackPlay(id) {
  if (!canControl() || !remoteState) return;
  const tracks = remoteState.tracks.map((t) => {
    if (t.id !== id) return t;
    const nowPlaying = !t.playing;
    return { ...t, playing: nowPlaying, seek: localSeekFor(id, t), updatedAt: Date.now() };
  });
  saveState({ tracks });
}

function toggleTrackLoop(id) {
  if (!canControl() || !remoteState) return;
  const tracks = remoteState.tracks.map((t) =>
    t.id !== id ? t : { ...t, loop: !t.loop }
  );
  saveState({ tracks });
}

function removeTrack(id) {
  if (!canControl() || !remoteState) return;
  const tracks = remoteState.tracks.filter((t) => t.id !== id);
  saveState({ tracks });
}

function clearAll() {
  if (!canControl()) return;
  saveState({ tracks: [] });
}

function setTrackEnded(id, loop) {
  if (!remoteState) return;
  const tracks = remoteState.tracks.map((t) => {
    if (t.id !== id) return t;
    return loop
      ? { ...t, playing: true, seek: 0, updatedAt: Date.now() }
      : { ...t, playing: false, seek: 0, updatedAt: Date.now() };
  });
  saveState({ tracks });
}

// ---------- rendering ----------

function renderChannels(state) {
  const tracks = state?.tracks || [];
  els.channelsCount.textContent = tracks.length;
  els.channels.innerHTML = "";

  if (tracks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "channel-empty";
    empty.textContent = "No sounds yet — add a music or ambience link above.";
    els.channels.appendChild(empty);
    return;
  }

  tracks.forEach((track) => {
    const entry = players.get(track.id);
    const errored = entry?.error;

    const row = document.createElement("div");
    row.className =
      "channel-row" + (track.playing ? " playing" : "") + (errored ? " errored" : "");
    row.dataset.id = track.id;

    const playBtn = document.createElement("button");
    playBtn.className = "mini-btn play-toggle" + (track.playing ? " active" : "");
    playBtn.textContent = track.playing ? "⏸" : "▶";
    playBtn.title = track.playing ? "Pause" : "Play";

    const nameCol = document.createElement("div");
    nameCol.className = "name-col";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = track.title || "YouTube audio";
    name.title = track.title || "YouTube audio";
    nameCol.appendChild(name);
    if (errored) {
      const err = document.createElement("span");
      err.className = "name error-text";
      err.textContent = entry.error;
      nameCol.appendChild(err);
    }

    const loopBtn = document.createElement("button");
    loopBtn.className = "mini-btn loop-toggle" + (track.loop ? " active" : "");
    loopBtn.textContent = "🔁";
    loopBtn.title = track.loop ? "Looping (click to play once)" : "Play once (click to loop)";

    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "vol-slider volume-slider";
    volume.min = "0";
    volume.max = "100";
    const savedVol = localStorage.getItem(`${NAMESPACE}/vol/${track.videoId}`);
    volume.value = savedVol !== null ? savedVol : "70";

    const removeBtn = document.createElement("button");
    removeBtn.className = "mini-btn remove remove-track";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";

    row.append(playBtn, nameCol, loopBtn, volume, removeBtn);
    els.channels.appendChild(row);
  });
}

// event delegation for all row controls
els.channels.addEventListener("click", (e) => {
  const row = e.target.closest(".channel-row");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest(".play-toggle")) toggleTrackPlay(id);
  else if (e.target.closest(".loop-toggle")) toggleTrackLoop(id);
  else if (e.target.closest(".remove-track")) removeTrack(id);
});

els.channels.addEventListener("input", (e) => {
  if (!e.target.classList.contains("volume-slider")) return;
  const row = e.target.closest(".channel-row");
  const id = row?.dataset.id;
  const track = remoteState?.tracks?.find((t) => t.id === id);
  if (!track) return;
  const entry = players.get(id);
  if (entry?.ready) {
    try {
      entry.player.setVolume(Number(e.target.value));
    } catch (err) {
      /* ignore */
    }
  }
  localStorage.setItem(`${NAMESPACE}/vol/${track.videoId}`, e.target.value);
});

els.clearAllBtn.addEventListener("click", clearAll);

els.lockCheckbox.addEventListener("change", () => {
  if (!isGM) return;
  saveState({ locked: els.lockCheckbox.checked });
});

els.addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canControl()) return;
  const raw = els.urlInput.value;
  if (!raw.trim()) return;
  await addTrack(raw);
  els.urlInput.value = "";
  els.addBtn.disabled = !canControl();
});

// ---------- YouTube IFrame API (shared load, one script tag for all players) ----------

function loadYouTubeApiOnce() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () =>
      reject(new Error("The youtube.com/iframe_api script failed to load."));
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
  return withTimeout(
    apiPromise,
    8000,
    "Couldn't reach youtube.com. If you're using an ad blocker (uBlock, Brave Shields, AdGuard) or strict tracking protection, allow youtube.com and owlbear.rodeo, then reload this panel."
  );
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

const YT_ERROR_MESSAGES = {
  2: "Invalid link",
  5: "Can't be embedded",
  100: "Not found / private",
  101: "Embedding disabled",
  150: "Embedding disabled",
};

// ---------- per-track player lifecycle ----------

async function ensureTrackPlayer(track) {
  if (players.has(track.id)) return;

  const div = document.createElement("div");
  div.id = `yt-${track.id}`;
  els.playerHost.appendChild(div);

  const entry = { div, player: null, ready: false, applyingRemote: false, error: null };
  players.set(track.id, entry);

  try {
    await loadYouTubeApiOnce();
  } catch (err) {
    entry.error = "Player failed to load";
    setStatus(err.message, true);
    renderChannels(remoteState);
    return;
  }

  // track may have been removed while we were awaiting the API load
  if (!remoteState?.tracks?.some((t) => t.id === track.id)) {
    div.remove();
    players.delete(track.id);
    return;
  }

  entry.player = new YT.Player(div.id, {
    height: "1",
    width: "1",
    videoId: track.videoId,
    playerVars: { controls: 0, disablekb: 1, autoplay: 0, playsinline: 1 },
    events: {
      onReady: () => {
        entry.ready = true;
        const savedVol = localStorage.getItem(`${NAMESPACE}/vol/${track.videoId}`);
        entry.player.setVolume(savedVol !== null ? Number(savedVol) : 70);
        const latest = remoteState?.tracks?.find((t) => t.id === track.id);
        if (latest) applyTrackState(latest);
        renderChannels(remoteState);
      },
      onStateChange: (e) => {
        if (entry.applyingRemote) return;
        if (e.data === YT.PlayerState.ENDED) {
          const latest = remoteState?.tracks?.find((t) => t.id === track.id);
          if (!canControl()) return;
          setTrackEnded(track.id, !!latest?.loop);
        }
      },
      onError: (e) => {
        entry.error = YT_ERROR_MESSAGES[e.data] || "Playback error";
        renderChannels(remoteState);
      },
    },
  });
}

function destroyTrackPlayer(id) {
  const entry = players.get(id);
  if (!entry) return;
  try {
    entry.player?.destroy();
  } catch (e) {
    /* ignore */
  }
  entry.div?.remove();
  players.delete(id);
}

function applyTrackState(track) {
  const entry = players.get(track.id);
  if (!entry || !entry.ready) return;

  entry.applyingRemote = true;
  try {
    const target = expectedSeek(track);
    const current = entry.player.getVideoData ? entry.player.getVideoData() : null;
    const loadedId = current?.video_id;

    if (loadedId !== track.videoId) {
      if (track.playing) {
        entry.player.loadVideoById({ videoId: track.videoId, startSeconds: Math.max(0, target) });
      } else {
        entry.player.cueVideoById({ videoId: track.videoId, startSeconds: Math.max(0, target) });
      }
    } else {
      const drift = Math.abs(entry.player.getCurrentTime() - target);
      if (drift > DRIFT_TOLERANCE) {
        entry.player.seekTo(Math.max(0, target), true);
      }
      const isPlaying = entry.player.getPlayerState() === YT.PlayerState.PLAYING;
      if (track.playing && !isPlaying) entry.player.playVideo();
      if (!track.playing && isPlaying) entry.player.pauseVideo();
    }
  } finally {
    setTimeout(() => (entry.applyingRemote = false), 400);
  }
}

function reconcilePlayers(state) {
  const tracks = state?.tracks || [];
  const currentIds = new Set(tracks.map((t) => t.id));

  for (const id of [...players.keys()]) {
    if (!currentIds.has(id)) destroyTrackPlayer(id);
  }
  for (const track of tracks) {
    if (!players.has(track.id)) ensureTrackPlayer(track);
    else applyTrackState(track);
  }
}

// periodic resync in case of buffering drift
setInterval(() => {
  if (remoteState) reconcilePlayers(remoteState);
}, RESYNC_INTERVAL);

// sync status dot: goes stale if we haven't heard from metadata in a while
let lastMetaAt = Date.now();
setInterval(() => {
  const stale = Date.now() - lastMetaAt > 15000;
  els.syncDot.classList.toggle("stale", stale);
}, 4000);

// ---------- boot ----------

async function boot() {
  renderChannels(null);

  await OBR.onReady(async () => {
    const role = await OBR.player.getRole();
    isGM = role === "GM";

    const metadata = await OBR.room.getMetadata();
    remoteState = metadata[STATE_KEY] || { tracks: [], locked: false };
    lastMetaAt = Date.now();
    refreshLockUI();
    renderChannels(remoteState);
    reconcilePlayers(remoteState);

    OBR.room.onMetadataChange((metadata) => {
      remoteState = metadata[STATE_KEY] || { tracks: [], locked: false };
      lastMetaAt = Date.now();
      refreshLockUI();
      renderChannels(remoteState);
      reconcilePlayers(remoteState);
    });
  });
}

boot();