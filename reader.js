// src/reader.js (subtitles + optional ElevenLabs; 220 WPM; pause/resume)

// --- DOM refs ---
const bg = document.getElementById('bg');
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const titleCard = document.getElementById('titleCard');
const subtitleEl = document.getElementById('subtitle');

// Toggle to skip ElevenLabs calls (no credits)
const SUBTITLES_ONLY = true;

// --- Playback state ---
let playbackState = {
  isPlaying: false,
  startOffset: 0,
  startWallTime: null,
  totalDuration: 0,
  tickHandle: null
};
let incoming = null;
let settings = { wpm: 220 };

// --- Params + speed factor ---
const qp = new URLSearchParams(location.search);
settings.wpm = parseInt(qp.get("wpm") || "220", 10);
const BASE_WPM = 160;
const speedFactor = settings.wpm / BASE_WPM;

// --- Load payload helper (you were calling this but it was missing) ---
async function loadPayload() {
  const { adf_reader_payload } = await chrome.storage.local.get("adf_reader_payload");
  if (adf_reader_payload && adf_reader_payload.text) {
    incoming = adf_reader_payload;
    titleCard.textContent = incoming.title || "Reading";
    await chrome.storage.local.remove("adf_reader_payload");
  }
}
loadPayload();

// --- Chunking: random 2–3 words ---
function chunkTextRandom(text, minWords = 2, maxWords = 3) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const sz = Math.min(
      maxWords,
      Math.max(minWords, Math.floor(Math.random() * (maxWords - minWords + 1)) + minWords),
      words.length - i
    );
    chunks.push(words.slice(i, i + sz).join(" "));
    i += sz;
  }
  return chunks;
}

// --- Cue building ---
function makeCues(chunks, wpm) {
  const wps = Math.max(1, wpm) / 60; // words/sec
  const cues = [];
  let t = 0;
  for (const c of chunks) {
    const wc = c.split(/\s+/).filter(Boolean).length;
    const dur = Math.max(0.6, wc / wps); // a small floor so 2-word flashes aren’t too tiny
    cues.push({ start: t, end: t + dur, text: c });
    t += dur;
  }
  return { cues, total: t };
}

function drawOverlay(currentText) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  subtitleEl.textContent = currentText || "";
}

// --- ElevenLabs TTS (kept for when you flip SUBTITLES_ONLY=false) ---
async function ttsElevenLabs(text, apiKey, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.3, similarity_boost: 0.7 },
      output_format: "mp3_44100_128"
    })
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  return await res.arrayBuffer();
}

// --- Audio graph ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const mixDest = audioCtx.createMediaStreamDestination();
const playbackBus = audioCtx.createGain();
playbackBus.connect(audioCtx.destination);
playbackBus.connect(mixDest);

// --- Globals used by the ticker ---
let currentCues = null;
let lastCueIdx = -1;

// --- Main play sequence (build buffers, schedule, and start ticker) ---
async function playSequence(chunks, creds) {
  await audioCtx.resume();
  bg.playbackRate = 1.15; // optional: make gameplay snappier
  bg.play();

  const wps = settings.wpm / 60;
  const buffers = [];
  const bufferDurations = [];
  const isReal = [];

  for (const c of chunks) {
    let arrBuf = null;
    if (!SUBTITLES_ONLY && creds.elKey && creds.elVoice) {
      try {
        arrBuf = await ttsElevenLabs(c, creds.elKey, creds.elVoice);
      } catch (e) {
        console.warn("[AdFocus] TTS error; continuing with silence:", e);
      }
    }

    if (arrBuf) {
      const buf = await audioCtx.decodeAudioData(arrBuf.slice(0));
      buffers.push(buf);
      bufferDurations.push(buf.duration);
      isReal.push(true);
    } else {
      const silentSec = Math.max(1, c.split(/\s+/).filter(Boolean).length / wps);
      const silent = audioCtx.createBuffer(1, Math.round(audioCtx.sampleRate * silentSec), audioCtx.sampleRate);
      buffers.push(silent);
      bufferDurations.push(silent.duration);
      isReal.push(false);
    }
  }

  // Build preliminary cues from WPM; we’ll align to actual/planned durations below
  const cues = makeCues(chunks, settings.wpm);

  // Schedule audio buffers and align cue times
  let now = audioCtx.currentTime + 0.2;
  for (let i = 0; i < buffers.length; i++) {
    const src = audioCtx.createBufferSource();
    src.buffer = buffers[i];

    // Speed up real audio to match WPM; silent buffers already reflect WPM
    if (isReal[i]) {
      src.playbackRate.value = speedFactor;
    }

    src.connect(playbackBus);
    src.start(now);

    const baseDur = bufferDurations[i] ?? (buffers[i].duration || (cues.cues[i].end - cues.cues[i].start));
    const plannedDur = isReal[i] ? (baseDur / speedFactor) : baseDur;

    cues.cues[i].start = (i === 0) ? 0 : cues.cues[i - 1].end;
    cues.cues[i].end = cues.cues[i].start + plannedDur;
    now += plannedDur;
  }

  currentCues = cues;
  playbackState.totalDuration = cues.total;
  playbackState.startOffset = 0;
  playbackState.startWallTime = performance.now() / 1000;
  playbackState.isPlaying = true;
  lastCueIdx = -1;
  requestAnimationFrame(tick);
}

// --- Subtitle ticker (driven by wall clock + state) ---
function tick() {
  const t = Math.min(
    (performance.now() / 1000) - playbackState.startWallTime + playbackState.startOffset,
    playbackState.totalDuration
  );

  if (!currentCues) return;

  let currentCueIdx = 0;
  while (currentCueIdx < currentCues.cues.length && t >= currentCues.cues[currentCueIdx].end) {
    currentCueIdx++;
  }

  const current = currentCues.cues[currentCueIdx];
  if (currentCueIdx !== lastCueIdx) {
    lastCueIdx = currentCueIdx;
    drawOverlay(current ? current.text : "");
  }

  if (playbackState.isPlaying && currentCueIdx < currentCues.cues.length) {
    playbackState.tickHandle = requestAnimationFrame(tick);
  }
}

// ---- UI: ensure a Play button exists and wire it ----
function ensurePlayButton() {
  let btn = document.getElementById('play');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'play';
    btn.textContent = '▶️';
    btn.setAttribute('aria-label', 'Play');
    Object.assign(btn.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      width: '100px', height: '100px', borderRadius: '50%',
      background: 'rgba(0,0,0,.7)', color: '#fff', fontSize: '32px', border: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', zIndex: 3
    });
    document.body.appendChild(btn);
  }
  return btn;
}

function wirePlayButton() {
  const playBtn = ensurePlayButton();
  playBtn.replaceWith(playBtn.cloneNode(true)); // drop old handlers if any
  const btn = document.getElementById('play');

  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // don’t trigger body pause/resume
    btn.classList.add('fade-out');
    setTimeout(() => { try { btn.remove(); } catch(_){} }, 250);

    await loadPayload();
    if (!incoming || !incoming.text) {
      alert("No text payload received. Please click Start from the popup on a content page.");
      return;
    }

    await audioCtx.resume();

    const chunks = chunkTextRandom(incoming.text, 2, 3);
    titleCard.textContent = incoming.title || "Reading";
    await playSequence(chunks, { elKey: null, elVoice: null }); // creds ignored when SUBTITLES_ONLY=true
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wirePlayButton, { once: true });
} else {
  wirePlayButton();
}

// --- initial paint ---
drawOverlay("");

// --- global click to pause/resume ---
document.body.addEventListener('click', () => {
  if (!playbackState.totalDuration) return; // not started

  if (playbackState.isPlaying) {
    playbackState.isPlaying = false;
    playbackState.startOffset += (performance.now() / 1000) - playbackState.startWallTime;
    cancelAnimationFrame(playbackState.tickHandle);
    bg.pause();
    console.log("[AdFocus] Paused at", playbackState.startOffset.toFixed(2), "s");
  } else {
    playbackState.isPlaying = true;
    playbackState.startWallTime = performance.now() / 1000;
    bg.play();
    console.log("[AdFocus] Resumed from", playbackState.startOffset.toFixed(2), "s");
    playbackState.tickHandle = requestAnimationFrame(tick);
  }
});
