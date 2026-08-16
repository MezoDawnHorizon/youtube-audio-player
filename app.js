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
  gmLockRow: document.getElementById("gmLockRow"),
  lockCheckbox: document.getElementById("lockCheckbox"),
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
    url: base.url || "",
    videoId: base.videoId || null,
    title: base.title || "",
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
  ].forEach((el) => (el.disabled = disabled));
  if (isGM) {
    els.gmLockRow.classList.remove("hidden");
    els.lockCheckbox.checked = locked;
  }
}

// ---------- YouTube IFrame API ----------

function loadYouTubeApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => resolve();
  });
}

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
          player.setVolume(Number(els.volumeBar.value));
          resolve();
        },
        onStateChange: onPlayerStateChange,
      },
    });
  });
}

function onPlayerStateChange(e) {
  if (applyingRemote) return; // ignore changes we caused ourselves
  if (e.data === YT.PlayerState.ENDED) {
    if (remoteState?.loop && canControl()) {
      pushState({ seek: 0, playing: true });
      player.seekTo(0, true);
      player.playVideo();
    } else if (canControl()) {
      pushState({ playing: false, seek: 0 });
    }
  }
}

// ---------- applying remote state to the local player ----------

async function applyRemoteState(state) {
  if (!state || !state.videoId) {
    els.noVideo.classList.remove("hidden");
    els.nowPlaying.textContent = "—";
    return;
  }
  els.noVideo.classList.add("hidden");
  els.nowPlaying.textContent = state.title || "YouTube audio";
  els.loopBtn.classList.toggle("active", !!state.loop);
  els.playPauseBtn.textContent = state.playing ? "⏸" : "▶";

  if (!playerReady) return;

  applyingRemote = true;
  try {
    const target = expectedSeek(state);
    const current = player.getVideoData ? player.getVideoData() : null;
    const loadedId = current?.video_id;

    if (loadedId !== state.videoId) {
      if (state.playing) {
        player.loadVideoById({ videoId: state.videoId, startSeconds: Math.max(0, target) });
      } else {
        player.cueVideoById({ videoId: state.videoId, startSeconds: Math.max(0, target) });
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
    els.nowPlaying.textContent = "Couldn't read a YouTube link from that.";
    return;
  }
  const title = await fetchTitle(videoId);
  await pushState({
    url: raw.trim(),
    videoId,
    title,
    playing: true,
    seek: 0,
    loop: remoteState?.loop || false,
  });
  els.urlInput.value = "";
});

els.playPauseBtn.addEventListener("click", () => {
  if (!canControl() || !remoteState?.videoId || !playerReady) return;
  const nowPlaying = !remoteState.playing;
  const seek = nowPlaying ? player.getCurrentTime() : player.getCurrentTime();
  pushState({ playing: nowPlaying, seek });
});

els.loopBtn.addEventListener("click", () => {
  if (!canControl()) return;
  pushState({ loop: !remoteState?.loop });
});

els.seekBar.addEventListener("mousedown", () => (seekDragging = true));
els.seekBar.addEventListener("touchstart", () => (seekDragging = true));
els.seekBar.addEventListener("change", () => {
  if (!canControl() || !playerReady || !remoteState?.videoId) {
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
  if (!playerReady || seekDragging || !remoteState?.videoId) return;
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

  await OBR.onReady(async () => {
    const role = await OBR.player.getRole();
    isGM = role === "GM";

    await loadYouTubeApi();
    await createPlayer();

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
