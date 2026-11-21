// renderer.js — wires the camera signal to the instrument.
//
// Bundled by esbuild into dist/renderer.bundle.js (see package.json).
//
// Three halves:
//   SignalEngine  — SmartSpectra Metrics → smoothed signal snapshot
//   AudioEngine   — snapshot + detected beats → sound
//   Visuals       — snapshot + detected beats → picture
//
// This file is the only one that knows about both the DOM and the SDK.

'use strict';

const {
  SmartSpectraSDK,
  ProcessingStatus,
  ValidationCode,
  breathingMetrics,
  cardioMetrics,
  MetricType,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');

const { SignalEngine } = require('./signal-engine');
const { AudioEngine } = require('./audio-engine');
const { Visuals } = require('./visuals');
const { Simulator } = require('./simulator');
const mapping = require('./mapping');

// The face bundle's expression code. MetricType is generated from the
// protobuf at runtime, so read it defensively and fall back to the documented
// wire value.
const EXPRESSIONS_CODE = MetricType && MetricType.EXPRESSIONS != null ? MetricType.EXPRESSIONS : 14;

const VALIDATION_HINTS = {
  [ValidationCode.kOk]: { text: 'Locked on — hold steady and let it listen.', tone: 'ok' },
  [ValidationCode.kNoFaceFound]: { text: 'No face in frame — sit in front of the camera.', tone: 'warn' },
  [ValidationCode.kMultipleFacesFound]: { text: 'More than one face — this instrument plays for one person.', tone: 'warn' },
  [ValidationCode.kFaceNotCentered]: { text: 'Move toward the middle of the frame.', tone: 'warn' },
  [ValidationCode.kFaceSizeOutOfRange]: { text: 'Move a little closer, or a little further back.', tone: 'warn' },
  [ValidationCode.kTooDark]: { text: 'Too dark — face a window or a lamp.', tone: 'bad' },
  [ValidationCode.kTooBright]: { text: 'Too bright — a glare is washing out the signal.', tone: 'bad' },
  [ValidationCode.kChestNotVisible]: { text: 'Chest not visible — sit back so your torso is in frame.', tone: 'warn' },
  [ValidationCode.kCameraTuning]: { text: 'Camera is tuning — give it a second.', tone: 'warn' },
  [ValidationCode.kFrameRateTooLow]: { text: 'Frame rate too low — close other heavy apps.', tone: 'bad' },
  [ValidationCode.kExcessiveMotion]: { text: 'Lots of motion — try to stay still.', tone: 'warn' },
  [ValidationCode.kFaceTooClose]: { text: 'A little too close to the camera.', tone: 'warn' },
  [ValidationCode.kFaceTooFar]: { text: 'A little too far from the camera.', tone: 'warn' },
  [ValidationCode.kFaceTooHigh]: { text: 'Lower the camera, or raise your seat.', tone: 'warn' },
  [ValidationCode.kFaceTooLow]: { text: 'Raise the camera to eye level.', tone: 'warn' },
  [ValidationCode.kFaceNotForward]: { text: 'Turn to face the camera.', tone: 'warn' },
};

const STATUS_NAMES = Object.fromEntries(
  Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]),
);

const $ = (id) => document.getElementById(id);
const el = {
  preview: $('preview'),
  previewWrap: document.querySelector('.preview'),
  simBadge: $('sim-badge'),
  validation: $('validation'),
  status: $('status'),
  canvas: $('stage-canvas'),
  bpmMain: $('bpm-main'),
  tempoCaption: $('tempo-caption'),
  notice: $('notice'),
  pulse: $('m-pulse'),
  breath: $('m-breath'),
  quality: $('m-quality'),
  mode: $('m-mode'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  btnMute: $('btn-mute'),
  volume: $('volume'),
  consent: $('consent'),
  consentError: $('consent-error'),
  apiKey: $('api-key'),
  optConsent: $('opt-consent'),
  optTelemetry: $('opt-telemetry'),
  btnBegin: $('btn-begin'),
  btnDemo: $('btn-demo'),
};

// --- engines ---------------------------------------------------------------
const visuals = new Visuals(el.canvas);
const audio = new AudioEngine();

const engine = new SignalEngine({
  onBeat: (beat) => {
    // One detected heartbeat → one kick, one ring.
    audio.hitBeat(beat);
    visuals.pulse(beat.strength);
  },
});

const simulator = new Simulator({ onMetrics: (metrics) => engine.update(metrics) });

// --- session state ---------------------------------------------------------
let sdk = null;
let running = false;
let source = null; // 'camera' | 'simulated'
let mode = mapping.MODES.drift;
let lastTonalityAt = 0;
let lastHudAt = 0;
let framePrev = 0;

// Optional convenience for demos and CI: `SMARTSPECTRA_API_KEY=… npm start`
// arrives here as a query param supplied by main.js. It stays in memory.
try {
  const prefilled = new URLSearchParams(window.location.search).get('apiKey');
  if (prefilled) el.apiKey.value = prefilled;
} catch { /* no query string — the person will paste a key */ }

// --- consent gate ----------------------------------------------------------
el.optConsent.addEventListener('change', () => {
  el.btnBegin.disabled = !el.optConsent.checked;
});

el.btnBegin.addEventListener('click', () => {
  const key = el.apiKey.value.trim();
  if (!key) {
    showConsentError('Paste your Presage API key first (free at physiology.presagetech.com), or try the simulated mode.');
    return;
  }
  el.consent.hidden = true;
  begin({ apiKey: key, simulated: false, telemetry: el.optTelemetry.checked });
});

el.btnDemo.addEventListener('click', () => {
  el.consent.hidden = true;
  begin({ apiKey: '', simulated: true, telemetry: false });
});

function showConsentError(message) {
  el.consentError.hidden = false;
  el.consentError.textContent = message;
}

function notice(message) {
  el.notice.hidden = !message;
  el.notice.textContent = message || '';
}

// --- start / stop ----------------------------------------------------------
async function begin({ apiKey, simulated, telemetry }) {
  source = simulated ? 'simulated' : 'camera';
  engine.reset();
  mode = mapping.MODES.drift;
  audio.setTonality({ mode, rootMidi: mapping.rootForPulse(null), chordSemitones: mode.chordSemitones });
  setStatus(simulated ? 'Simulated' : 'Starting');

  try {
    await audio.start(); // user gesture just happened, so the AudioContext may resume
  } catch (err) {
    notice(`Could not start audio: ${err && err.message ? err.message : err}`);
  }

  if (simulated) {
    el.simBadge.hidden = false;
    setHint({ text: 'Simulated signals — this is a stand-in pulse, not yours.', tone: 'warn' });
    simulator.start();
    running = true;
    setRunningUi(true);
    return;
  }

  try {
    sdk = await startSdk({ apiKey, telemetry, withFace: true });
    running = true;
    setRunningUi(true);
    setHint({ text: 'Camera starting — hold still in good light.', tone: 'warn' });
  } catch (err) {
    running = false;
    setRunningUi(false);
    audio.stop();
    setStatus('Error', 'bad');
    notice(errorMessage(err));
    console.error('[systole] start failed', err);
  }
}

async function startSdk({ apiKey, telemetry, withFace }) {
  const requestedMetrics = [...breathingMetrics, ...cardioMetrics];
  if (withFace) requestedMetrics.push(EXPRESSIONS_CODE);

  const instance = new SmartSpectraSDK({
    apiKey,
    requestedMetrics,
    enableAccumulatedOutput: false,
    // Disclosed on the consent sheet, and off unless the person opted in.
    enableTelemetry: !!telemetry,
  });

  instance.on('processingStatus', (status) => {
    setStatus(STATUS_NAMES[status] || `Status ${status}`, status === ProcessingStatus.kError ? 'bad' : '');
  });

  instance.on('validationStatus', (code, _timestampUs, hint) => {
    engine.setValidation(code, hint);
    const known = VALIDATION_HINTS[code];
    setHint(known || { text: hint || `Validation code ${code}`, tone: 'warn' });
  });

  instance.on('streamAvailable', (stream) => {
    el.preview.srcObject = stream;
    el.previewWrap.classList.add('live');
    el.preview.play().catch(() => {});
  });

  instance.on('metrics', (buf) => {
    let decoded = null;
    try {
      decoded = decodeMetrics(buf);
    } catch (err) {
      console.warn('[systole] could not decode Metrics payload', err);
      return;
    }
    if (!decoded || isBuffer(decoded)) return; // decoder not registered
    engine.update(decoded);
  });

  instance.on('error', (code, message, retryable) => {
    console.error(`[systole] SDK error ${code} (retryable=${retryable}): ${message}`);
    notice(`SDK error ${code}: ${message}${retryable ? ' — press Stop, then Start to retry.' : ''}`);
  });

  try {
    await instance.start();
    return instance;
  } catch (err) {
    try { instance.destroy(); } catch { /* nothing to release */ }
    // Face metrics can be gated by plan. If that is all that failed, run the
    // pulse + breathing instrument instead of failing the whole session.
    const optionalFaceFailure = withFace && (err.code === 3 || err.code === 13);
    if (optionalFaceFailure) {
      notice('Expression metrics are not available on this Presage plan — running with pulse and breathing only. Everything else still works.');
      return startSdk({ apiKey, telemetry, withFace: false });
    }
    throw err;
  }
}

async function stop() {
  running = false;
  simulator.stop();
  setRunningUi(false);
  setStatus('Idle');
  setHint({ text: 'Camera is off.', tone: '' });
  el.simBadge.hidden = true;
  if (sdk) {
    try { await sdk.stop(); } catch (err) { console.warn('[systole] stop() failed', err); }
    try { sdk.destroy(); } catch { /* already destroyed */ }
    sdk = null;
  }
  if (el.preview.srcObject) {
    el.preview.srcObject = null;
  }
  el.previewWrap.classList.remove('live');
  audio.stop();
  el.bpmMain.textContent = '—';
  el.tempoCaption.textContent = 'waiting for a pulse';
  el.pulse.textContent = '—';
  el.breath.textContent = '—';
  el.quality.textContent = '—';
  el.mode.textContent = '—';
}

function setRunningUi(isRunning) {
  el.btnStart.disabled = isRunning;
  el.btnStop.disabled = !isRunning;
}

function setStatus(label, tone) {
  el.status.textContent = label;
  el.status.className = `status ${tone ? `status-${tone}` : ''}`;
}

function setHint({ text, tone }) {
  el.validation.textContent = text;
  el.validation.className = `hint ${tone || ''}`;
}

function isBuffer(value) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(value);
}

function errorMessage(err) {
  if (!err) return 'Something went wrong starting the camera.';
  if (err.code === 'SMARTSPECTRA_IPC_TIMEOUT') return 'The measurement process stopped responding. Press Start again.';
  if (err.code === 2) return 'Presage rejected the API key. Check it at physiology.presagetech.com and try again.';
  if (err.code === 4) return 'This Presage API key is out of credits.';
  if (err.code === 7) return 'No camera available — check that nothing else is using it.';
  return `${err.message || err}${err.code != null ? ` (code ${err.code})` : ''}`;
}

// --- controls --------------------------------------------------------------
el.btnStart.addEventListener('click', () => {
  // A Stop tears the SDK down (requestedMetrics is fixed at construction), so
  // Start rebuilds it with the consent choices already made.
  const key = el.apiKey.value.trim();
  if (!key && source !== 'simulated') {
    el.consent.hidden = false;
    showConsentError('Paste your Presage API key to start the camera again.');
    return;
  }
  begin({
    apiKey: key,
    simulated: source === 'simulated',
    telemetry: el.optTelemetry.checked,
  });
});

el.btnStop.addEventListener('click', stop);

for (const btn of document.querySelectorAll('.preset')) {
  btn.addEventListener('click', () => {
    const name = btn.dataset.preset;
    audio.setPreset(name);
    visuals.setPreset(name);
    for (const other of document.querySelectorAll('.preset')) {
      const active = other === btn;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  });
}

el.volume.addEventListener('input', () => {
  audio.setVolume(Number(el.volume.value) / 100);
});

el.btnMute.addEventListener('click', () => {
  const muted = el.btnMute.getAttribute('aria-pressed') !== 'true';
  audio.setMuted(muted);
  el.btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  el.btnMute.textContent = muted ? 'Unmute music' : 'Mute music';
});

audio.setVolume(Number(el.volume.value) / 100);

window.addEventListener('resize', () => visuals.resize());

// --- render loop -----------------------------------------------------------
function loop(now) {
  const dt = framePrev ? Math.min(0.06, (now - framePrev) / 1000) : 0.016;
  framePrev = now;

  if (running) {
    const snapshot = engine.snapshot();

    if (now - lastTonalityAt > 400) {
      lastTonalityAt = now;
      updateTonality(snapshot);
    }

    audio.update(snapshot);
    visuals.frame(snapshot, dt);

    if (now - lastHudAt > 200) {
      lastHudAt = now;
      updateHud(snapshot);
    }
  } else {
    visuals.frame(null, dt);
  }

  requestAnimationFrame(loop);
}

function updateTonality(snapshot) {
  // Key follows the measured pulse; mode follows stress *relative to your own
  // session baseline* (Baevsky's index is meaningless as an absolute number).
  const nextMode = mapping.modeForStress(snapshot.relativeStress);
  const rootMidi = mapping.rootForPulse(snapshot.pulseBpm);
  if (nextMode.name !== mode.name) {
    mode = nextMode;
  }
  audio.setTonality({ mode, rootMidi, chordSemitones: mode.chordSemitones });
}

function updateHud(snapshot) {
  const qualityPct = Math.round((snapshot.quality || 0) * 100);
  el.pulse.textContent = snapshot.pulseBpm ? Math.round(snapshot.pulseBpm) : '—';
  el.breath.textContent = snapshot.breathBpm ? Math.round(snapshot.breathBpm) : '—';
  el.quality.textContent = snapshot.metricsPackets ? String(qualityPct) : '—';
  el.mode.textContent = snapshot.metricsPackets ? mode.name : '—';

  const tempoBpm = snapshot.bpmFromBeats || snapshot.pulseBpm;
  el.bpmMain.textContent = tempoBpm ? Math.round(tempoBpm) : '—';

  if (snapshot.bpmFromBeats) {
    el.tempoCaption.textContent = `${snapshot.beats} beats heard in the pressure wave — the kit is on your pulse`;
    el.validation.classList.add('ok');
  } else if (snapshot.pulseBpm) {
    el.tempoCaption.textContent = 'tempo from pulse rate while the waveform settles';
  } else {
    el.tempoCaption.textContent = 'waiting for a pulse';
  }
}

requestAnimationFrame(loop);

// Clean shutdown: release the camera and the audio graph if the window closes.
window.addEventListener('beforeunload', () => {
  simulator.stop();
  try { if (sdk) sdk.destroy(); } catch { /* already gone */ }
  try { audio.stop(); } catch { /* already stopped */ }
});
