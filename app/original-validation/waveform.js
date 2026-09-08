let AC = null;
function ac() { return AC || (AC = new (window.AudioContext || window.webkitAudioContext)()); }

// A separated stem spans the WHOLE scene and is silent everywhere its source
// isn't active, so playing one from 0 usually means sitting through several
// seconds of nothing. Every stem is therefore analysed once, up front, for the
// region that actually carries signal; players seek to `audibleStart` and stop
// at `audibleEnd` instead of using the clip's nominal bounds.
//
// The analysis also produces the waveform envelope, so the decode is shared
// rather than done twice. Only the envelope + the two timestamps are kept --
// the decoded AudioBuffer (tens of MB) is released as soon as the scan is done.
const PEAK_BUCKETS = 2048;

// Silence gate, relative to the clip's own peak so it adapts to quiet sources,
// with an absolute floor so a clip of pure dither doesn't read as "audible".
const AUDIBLE_REL = 0.02;
const AUDIBLE_ABS = 1e-4;
const SCAN_BLOCK_S = 0.01;   // 10 ms resolution for the silence scan
const LEAD_IN_S = 0.03;      // keep a hair before the attack so it isn't clipped
const TAIL_S = 0.05;         // ...and a little after the last audible block

// Analyses are cached by url/key so switching back to a scene (or clicking a
// graph node whose stem the stems panel already drew) is instant. Capped so a
// long session over thousands of scenes can't grow without bound; each entry is
// only ~16 KB since the AudioBuffer itself is not retained.
const MAX_CACHED = 400;
const analysisCache = new Map();

function scanAudible(buf) {
  const n = buf.length;
  const block = Math.max(1, Math.round(buf.sampleRate * SCAN_BLOCK_S));
  const blocks = Math.max(1, Math.ceil(n / block));
  const env = new Float32Array(blocks);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let b = 0; b < blocks; b++) {
      const s = b * block, e = Math.min(n, s + block);
      let peak = env[b];
      for (let i = s; i < e; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
      env[b] = peak;
    }
  }
  let gpeak = 0;
  for (let b = 0; b < blocks; b++) if (env[b] > gpeak) gpeak = env[b];
  // A stem with no signal at all: leave the bounds wide rather than collapsing
  // them to zero, so playback still behaves like a normal (if silent) clip.
  if (gpeak <= AUDIBLE_ABS) return { audibleStart: 0, audibleEnd: buf.duration };
  const thr = Math.max(gpeak * AUDIBLE_REL, AUDIBLE_ABS);
  let first = -1, last = -1;
  for (let b = 0; b < blocks; b++) {
    if (env[b] >= thr) { if (first < 0) first = b; last = b; }
  }
  if (first < 0) return { audibleStart: 0, audibleEnd: buf.duration };
  return {
    audibleStart: Math.max(0, (first * block) / buf.sampleRate - LEAD_IN_S),
    audibleEnd: Math.min(buf.duration, ((last + 1) * block) / buf.sampleRate + TAIL_S),
  };
}

function bucketPeaks(buf) {
  const d = buf.getChannelData(0);
  const min = new Float32Array(PEAK_BUCKETS);
  const max = new Float32Array(PEAK_BUCKETS);
  const per = d.length / PEAK_BUCKETS;
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    const s = Math.floor(i * per), e = Math.max(s + 1, Math.floor((i + 1) * per));
    let lo = 1, hi = -1;
    for (let j = s; j < e && j < d.length; j++) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[i] = lo > hi ? 0 : lo;
    max[i] = lo > hi ? 0 : hi;
  }
  return { min, max };
}

async function runAnalysis(loadArrayBuffer) {
  const audio = await ac().decodeAudioData(await loadArrayBuffer());
  const { min, max } = bucketPeaks(audio);
  const { audibleStart, audibleEnd } = scanAudible(audio);
  return { min, max, duration: audio.duration, audibleStart, audibleEnd };
}

// Starts (or joins) the analysis for `key`. `loadArrayBuffer` is only called on
// a cache miss, so callers can hand over a fetch/File read without paying for
// it twice.
export function analyzeStem(key, loadArrayBuffer) {
  let p = analysisCache.get(key);
  if (!p) {
    p = runAnalysis(loadArrayBuffer);
    p.catch(() => analysisCache.delete(key)); // let a failed load be retried
    if (analysisCache.size >= MAX_CACHED) {
      analysisCache.delete(analysisCache.keys().next().value);
    }
    analysisCache.set(key, p);
  }
  return p;
}

// Synchronous peek for callers that must not await (a click handler that would
// otherwise lose its user-gesture context). Returns null until the analysis for
// `key` has resolved.
const resolved = new Map();
export function cachedAudible(key) {
  return resolved.get(key) || null;
}

function remember(key, a) {
  resolved.set(key, { audibleStart: a.audibleStart, audibleEnd: a.audibleEnd });
  if (resolved.size > MAX_CACHED) resolved.delete(resolved.keys().next().value);
}

function drawPeaks(canvas, a) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(1, canvas.clientWidth || 240);
  const cssH = Math.max(1, canvas.clientHeight || 40);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  // Shade the silent head/tail so it is obvious that playback skips them.
  if (a.duration > 0) {
    ctx.fillStyle = "#f1f5f9";
    const x1 = (a.audibleStart / a.duration) * cssW;
    const x2 = (a.audibleEnd / a.duration) * cssW;
    if (x1 > 0) ctx.fillRect(0, 0, x1, cssH);
    if (x2 < cssW) ctx.fillRect(x2, 0, cssW - x2, cssH);
  }

  ctx.strokeStyle = "#579";
  for (let x = 0; x < cssW; x++) {
    const i = Math.min(PEAK_BUCKETS - 1, Math.floor((x / cssW) * PEAK_BUCKETS));
    ctx.beginPath();
    ctx.moveTo(x, (1 - a.max[i]) * cssH / 2);
    ctx.lineTo(x, (1 - a.min[i]) * cssH / 2);
    ctx.stroke();
  }
}

// Only one stem plays at a time across the whole stems panel: starting one
// pauses whichever other stem was playing. Module-scoped since ES modules
// are singletons, so this state naturally spans every createStemPlayer call.
let activeAudio = null, activeBtn = null;

export function createStemPlayer(container, stem) {
  const row = document.createElement("div"); row.className = "stem";
  const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "▶";
  const label = document.createElement("span"); label.className = "stem-label"; label.textContent = stem.name;
  // The canvas sits in a positioned wrapper so the playhead can be a plain
  // absolutely-positioned rule over it -- cheaper than redrawing the peaks
  // every frame, and it cannot drift out of step with them.
  const wrap = document.createElement("div"); wrap.className = "stem-wave-wrap";
  const canvas = document.createElement("canvas"); canvas.className = "stem-wave";
  const head = document.createElement("div"); head.className = "stem-playhead";
  wrap.append(canvas, head);
  const audio = new Audio(stem.url); audio.preload = "none";

  // Bounds of the region that actually carries signal. Until the analysis
  // resolves these stay wide, so an early click still plays the whole clip
  // rather than nothing.
  let from = 0, to = Infinity;

  function setPlaying(isPlaying) {
    btn.textContent = isPlaying ? "⏸" : "▶";
    btn.classList.toggle("playing", isPlaying);
  }

  function stopThis() {
    audio.pause();
    setPlaying(false);
    if (activeAudio === audio) {
      activeAudio = null; activeBtn = null;
      if (window.__app && window.__app.setClock) window.__app.setClock(null);
    }
  }

  btn.addEventListener("click", () => {
    if (audio.paused) {
      // Click plays instantly; pause whatever other stem was active first.
      if (activeAudio && activeAudio !== audio) {
        activeAudio.pause();
        if (activeBtn) { activeBtn.textContent = "▶"; activeBtn.classList.remove("playing"); }
      }
      // Jump straight to the signal: from a fresh start, from a position still
      // inside the leading silence, or from a previous play that ran past the
      // last audible sample.
      if (audio.currentTime < from || audio.currentTime >= to) audio.currentTime = from;
      audio.play();
      setPlaying(true);
      activeAudio = audio; activeBtn = btn;
      // This source is now what you hear, so it is what the map should follow.
      if (window.__app && window.__app.setClock) window.__app.setClock(() => audio.currentTime);
    } else {
      stopThis();
    }
  });
  audio.addEventListener("timeupdate", () => {
    if (to !== Infinity && audio.currentTime >= to) stopThis();
  });
  audio.addEventListener("ended", stopThis);

  row.append(btn, label, wrap); container.appendChild(row);

  // Wait a frame so the row has been laid out (CSS gives it its width/height)
  // before measuring clientWidth/clientHeight for the HiDPI backing store.
  // Total length of this stem, for placing the playhead. Every stem spans the
  // whole scene (silent outside its own part), so one x position means the
  // same instant on every row -- which is what makes the stack read like a
  // DAW arrangement rather than a set of unrelated clips.
  let spanS = 0;

  requestAnimationFrame(() => {
    analyzeStem(stem.url, () => fetch(stem.url).then((r) => r.arrayBuffer()))
      .then((a) => {
        from = a.audibleStart;
        to = a.audibleEnd;
        spanS = a.duration || 0;
        remember(stem.url, a);
        drawPeaks(canvas, a);
      })
      .catch(() => { label.textContent += " (waveform unavailable)"; });
  });

  return {
    pause() { if (!audio.paused) stopThis(); },
    update(t) {
      if (!spanS) { head.style.display = "none"; return; }
      const f = t / spanS;
      if (f < 0 || f > 1) { head.style.display = "none"; return; }
      head.style.display = "block";
      head.style.left = (f * 100).toFixed(3) + "%";
    },
  };
}
