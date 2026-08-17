import OBR from "https://esm.sh/@owlbear-rodeo/sdk@2";

const NAMESPACE = "com.dndsync.audioplayer";
const STATE_KEY = `${NAMESPACE}/state`;
const DRIFT_TOLERANCE = 1.5; // seconds
const RESYNC_INTERVAL = 3000; // ms

const els = {
  urlInput: document.getElementById("urlInput"),
  loadForm: document.getElementById("loadForm"),
  loadBtn: document.getElementById("loadBtn"),
  nowPlaying: document.getElementById("nowPlaying"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  loopBtn: document.getElementById("loopBtn"),
  hideVideoBtn: document.getElementById("hideVideoBtn"),
  seekBar: document.getElementById("seekBar"),
  curTime: document.getElementById("curTime"),
  durTime: document.getElementById("durTime"),
  volumeBar: document.getElementById("volumeBar"),
  videoWrap: document.getElementById("videoWrap"),
  noVideo: document.getElementById("noVideo"),
  syncDot: document.getElementById("syncDot"),
  lockedBanner: document.getElementById("lockedBanner"),
  statusMsg: document.getElementById("statusMsg"),
  gmLockRow: document.getElementById("gmLockRow"),
  lockCheckbox: document.getElementById("lockCheckbox"),
  playlist: document.getElementById("playlist"),
  playlistCount: document.getElementById("playlistCount"),
  clearPlaylistBtn: document.getElementById("clearPlaylistBtn"),
};

let player = null;
let playerReady = false;
let isGM = false;
let remoteState = null; // last known metadata state
let applyingRemote = false; // guard to avoid feedback loops
let seekDragging = false;

// ---------- helpers ----------

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

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function expectedSeek(state) {
  if (!state) return 0;
  if (!state.playing) return state.seek;
  return state.seek + (Date.now() - state.updatedAt) / 1000;
}

function currentTrack(state) {
  if (!state || !state.playlist) return null;
  return state.playlist[state.currentIndex] || null;
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

async function pushState(partial) {
  const base = remoteState || {};
  const next = {
    playlist: base.playlist || [],
    currentIndex: base.currentIndex ?? -1,
    playing: base.playing || false,
    seek: base.seek || 0,
    updatedAt: Date.now(),
    loop: base.loop || false,
    locked: base.locked || false,
    ...partial,
    updatedAt: Date.now(),
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
  [
    els.loadBtn,
    els.urlInput,
    els.playPauseBtn,
    els.loopBtn,
    els.seekBar,
    els.clearPlaylistBtn,
  ].forEach((el) => (el.disabled = disabled));
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

// ---------- playlist rendering + mutation ----------

function renderPlaylist(state) {
  const list = state?.playlist || [];
  els.playlistCount.textContent = list.length;
  els.playlist.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "playlist-empty";
    empty.textContent = "Queue is empty — add a link above.";
    els.playlist.appendChild(empty);
    return;
  }

  list.forEach((track, i) => {
    const row = document.createElement("div");
    row.className = "playlist-item" + (i === state.currentIndex ? " active" : "");
    row.dataset.index = String(i);

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = i === state.currentIndex ? "▶" : String(i + 1);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = track.title || "YouTube audio";
    name.title = track.title || "YouTube audio";

    const remove = document.createElement("span");
    remove.className = "remove";
    remove.textContent = "✕";

    row.append(idx, name, remove);
    els.playlist.appendChild(row);
  });
}

function removeTrack(index) {
  if (!canControl() || !remoteState) return;
  const playlist = [...(remoteState.playlist || [])];
  if (index < 0 || index >= playlist.length) return;

  let currentIndex = remoteState.currentIndex ?? -1;
  let playing = remoteState.playing;
  let seek = remoteState.seek;

  playlist.splice(index, 1);

  if (index === currentIndex) {
    if (playlist.length === 0) {
      currentIndex = -1;
      playing = false;
      seek = 0;
    } else {
      currentIndex = Math.min(index, playlist.length - 1);
      playing = true;
      seek = 0;
    }
  } else if (index < currentIndex) {
    currentIndex -= 1;
    seek = playerReady ? player.getCurrentTime() : seek;
  }

  pushState({ playlist, currentIndex, playing, seek });
}

els.playlist.addEventListener("click", (e) => {
  const row = e.target.closest(".playlist-item");
  if (!row) return;
  const index = Number(row.dataset.index);
  if (!canControl()) return;
  if (e.target.closest(".remove")) {
    removeTrack(index);
  } else {
    pushState({ currentIndex: index, playing: true, seek: 0 });
  }
});

els.clearPlaylistBtn.addEventListener("click", () => {
  if (!canControl()) return;
  pushState({ playlist: [], currentIndex: -1, playing: false, seek: 0 });
});

// ---------- YouTube IFrame API ----------

function loadYouTubeApi() {
  return new Promise((resolve, reject) => {
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
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

const YT_ERROR_MESSAGES = {
  2: "That link doesn't point to a valid video.",
  5: "This video can't be played in an embedded player.",
  100: "That video was not found — it may be private or deleted.",
  101: "The video's owner has disabled embedding for this video. Try a different link.",
  150: "The video's owner has disabled embedding for this video. Try a different link.",
};

function createPlayer() {
  return new Promise((resolve) => {
    player = new YT.Player("ytPlayer", {
      height: "100%",
      width: "100%",
      playerVars: {
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
      },
      events: {
        onReady: () => {
          playerReady = true;
          setStatus(null);
          player.setVolume(Number(els.volumeBar.value));
          resolve();
        },
        onStateChange: onPlayerStateChange,
        onError: (e) => {
          const msg =
            YT_ERROR_MESSAGES[e.data] || "The YouTube player hit an unknown error.";
          setStatus(msg, true);
        },
      },
    });
  });
}

function onPlayerStateChange(e) {
  if (applyingRemote) return; // ignore changes we caused ourselves
  if (e.data === YT.PlayerState.ENDED) {
    if (!canControl()) return;
    if (remoteState?.loop) {
      player.seekTo(0, true);
      player.playVideo();
      pushState({ seek: 0, playing: true });
      return;
    }
    const playlist = remoteState?.playlist || [];
    const nextIndex = (remoteState?.currentIndex ?? -1) + 1;
    if (nextIndex < playlist.length) {
      pushState({ currentIndex: nextIndex, playing: true, seek: 0 });
    } else {
      pushState({ playing: false, seek: 0 });
    }
  }
}

// ---------- applying remote state to the local player ----------

async function applyRemoteState(state) {
  renderPlaylist(state);
  const track = currentTrack(state);

  if (!track) {
    els.noVideo.classList.remove("hidden");
    els.nowPlaying.textContent = "—";
    els.playPauseBtn.textContent = "▶";
    return;
  }

  els.noVideo.classList.add("hidden");
  els.nowPlaying.textContent = track.title || "YouTube audio";
  els.loopBtn.classList.toggle("active", !!state.loop);
  els.playPauseBtn.textContent = state.playing ? "⏸" : "▶";

  if (!playerReady) return;

  applyingRemote = true;
  try {
    const target = expectedSeek(state);
    const current = player.getVideoData ? player.getVideoData() : null;
    const loadedId = current?.video_id;

    if (loadedId !== track.id) {
      if (state.playing) {
        player.loadVideoById({ videoId: track.id, startSeconds: Math.max(0, target) });
      } else {
        player.cueVideoById({ videoId: track.id, startSeconds: Math.max(0, target) });
      }
    } else {
      const drift = Math.abs(player.getCurrentTime() - target);
      if (drift > DRIFT_TOLERANCE) {
        player.seekTo(Math.max(0, target), true);
      }
      const playerState = player.getPlayerState();
      const isPlaying = playerState === YT.PlayerState.PLAYING;
      if (state.playing && !isPlaying) player.playVideo();
      if (!state.playing && isPlaying) player.pauseVideo();
    }
  } finally {
    setTimeout(() => (applyingRemote = false), 400);
  }
}

// ---------- UI wiring ----------

els.loadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!canControl()) return;
  const raw = els.urlInput.value;
  const videoId = extractVideoId(raw);
  if (!videoId) {
    setStatus("Couldn't read a YouTube link from that.", true);
    return;
  }
  els.loadBtn.disabled = true;
  const title = await fetchTitle(videoId);
  const playlist = [...(remoteState?.playlist || []), { id: videoId, title, url: raw.trim() }];
  const isFirst = playlist.length === 1;
  await pushState({
    playlist,
    currentIndex: isFirst ? 0 : remoteState?.currentIndex ?? -1,
    playing: isFirst ? true : remoteState?.playing ?? false,
    seek: isFirst ? 0 : remoteState?.seek ?? 0,
  });
  els.urlInput.value = "";
  refreshLockUI();
});

els.playPauseBtn.addEventListener("click", () => {
  const track = currentTrack(remoteState);
  if (!canControl() || !track || !playerReady) return;
  const nowPlaying = !remoteState.playing;
  const seek = player.getCurrentTime();
  pushState({ playing: nowPlaying, seek });
});

els.loopBtn.addEventListener("click", () => {
  if (!canControl()) return;
  pushState({ loop: !remoteState?.loop });
});

els.seekBar.addEventListener("mousedown", () => (seekDragging = true));
els.seekBar.addEventListener("touchstart", () => (seekDragging = true));
els.seekBar.addEventListener("change", () => {
  const track = currentTrack(remoteState);
  if (!canControl() || !playerReady || !track) {
    seekDragging = false;
    return;
  }
  const dur = player.getDuration() || 0;
  const seek = (Number(els.seekBar.value) / 100) * dur;
  player.seekTo(seek, true);
  pushState({ seek });
  seekDragging = false;
});

els.volumeBar.addEventListener("input", () => {
  if (playerReady) player.setVolume(Number(els.volumeBar.value));
  localStorage.setItem(`${NAMESPACE}/volume`, els.volumeBar.value);
});

els.hideVideoBtn.addEventListener("click", () => {
  const hidden = els.videoWrap.classList.toggle("hidden-video");
  els.hideVideoBtn.classList.toggle("active", hidden);
  localStorage.setItem(`${NAMESPACE}/hideVideo`, hidden ? "1" : "0");
});

els.lockCheckbox.addEventListener("change", () => {
  if (!isGM) return;
  pushState({ locked: els.lockCheckbox.checked });
});

// ---------- progress bar ticking ----------

setInterval(() => {
  const track = currentTrack(remoteState);
  if (!playerReady || seekDragging || !track) return;
  const dur = player.getDuration() || 0;
  const cur = player.getCurrentTime() || 0;
  els.curTime.textContent = formatTime(cur);
  els.durTime.textContent = formatTime(dur);
  els.seekBar.value = dur > 0 ? (cur / dur) * 100 : 0;
}, 500);

// periodic resync in case of buffering drift
setInterval(() => {
  if (remoteState) applyRemoteState(remoteState);
}, RESYNC_INTERVAL);

// sync status dot: goes stale if we haven't heard from metadata in a while
let lastMetaAt = Date.now();
setInterval(() => {
  const stale = Date.now() - lastMetaAt > 15000;
  els.syncDot.classList.toggle("stale", stale);
}, 4000);

// ---------- boot ----------

async function boot() {
  // restore local prefs
  const savedVolume = localStorage.getItem(`${NAMESPACE}/volume`);
  if (savedVolume) els.volumeBar.value = savedVolume;
  const savedHide = localStorage.getItem(`${NAMESPACE}/hideVideo`);
  if (savedHide === "1") {
    els.videoWrap.classList.add("hidden-video");
    els.hideVideoBtn.classList.add("active");
  }

  renderPlaylist(null);

  await OBR.onReady(async () => {
    const role = await OBR.player.getRole();
    isGM = role === "GM";

    setStatus("Loading YouTube player…");
    try {
      await withTimeout(
        loadYouTubeApi(),
        8000,
        "Couldn't reach youtube.com. If you're using an ad blocker (uBlock, Brave Shields, AdGuard) or strict tracking protection, allow youtube.com and owlbear.rodeo, then reload this panel."
      );
      await withTimeout(
        createPlayer(),
        8000,
        "The YouTube player didn't finish loading. Try reloading this panel — if it keeps happening, check for ad blockers or content blockers on this site."
      );
    } catch (err) {
      setStatus(err.message, true);
      return; // don't proceed to wire up metadata if the player never came up
    }

    const metadata = await OBR.room.getMetadata();
    remoteState = metadata[STATE_KEY] || null;
    lastMetaAt = Date.now();
    refreshLockUI();
    applyRemoteState(remoteState);

    OBR.room.onMetadataChange((metadata) => {
      remoteState = metadata[STATE_KEY] || null;
      lastMetaAt = Date.now();
      refreshLockUI();
      applyRemoteState(remoteState);
    });
  });
}

boot();