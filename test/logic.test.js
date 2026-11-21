// Logic tests for Systole's signal → music translation.
//
// These run in plain Node (no Electron, no Web Audio, no camera):
//   npm test
//
// They cover the parts most likely to be silently wrong — beat detection on a
// unitless waveform, breath normalisation, and the mapping thresholds — by
// feeding synthetic signals whose correct answers we already know.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mapping = require('../src/mapping');
const { Ring, BeatDetector, SignalEngine, ema } = require('../src/signal-engine');

// --- helpers ---------------------------------------------------------------
const SAMPLE_HZ = 30;

/** Arterial-pressure-like wave: fundamental + dicrotic harmonic. */
function pressureSample(t, bpm) {
  const phase = 2 * Math.PI * (bpm / 60) * t;
  return Math.sin(phase) + 0.35 * Math.sin(2 * phase + 1.1);
}

function breathingSample(t, brpm) {
  return Math.sin(2 * Math.PI * (brpm / 60) * t);
}

/** Build a Metrics-shaped packet the way the SDK's decoder returns one. */
function packet({ t, pulseBpm = 68, breathBrpm = 14, confidence = 80, hrv = null, expression = null }) {
  const ts = Math.round(t * 1e6);
  const metrics = {
    breathing: {
      rate: [{ value: breathBrpm, confidence, stable: true, timestamp: ts }],
      upperTrace: [{ value: breathingSample(t, breathBrpm), timestamp: ts, stable: true }],
      lowerTrace: [],
    },
    cardio: {
      pulseRate: [{ value: pulseBpm, confidence, stable: true, timestamp: ts }],
      arterialPressureTrace: [{ value: pressureSample(t, pulseBpm), timestamp: ts, stable: true }],
      hrv: hrv ? [{ ...hrv, timestamp: ts }] : [],
    },
    face: expression ? { expression: [{ timestamp: ts, scores: expression }] } : {},
  };
  return metrics;
}

// --- mapping ---------------------------------------------------------------
test('midi note 69 is concert A', () => {
  assert.equal(Math.round(mapping.midiToFreq(69)), 440);
});

test('tempo is clamped into a musical range', () => {
  assert.equal(mapping.tempoFromPulse(42), mapping.TEMPO_MIN);
  assert.equal(mapping.tempoFromPulse(71), 71);
  assert.equal(mapping.tempoFromPulse(200), mapping.TEMPO_MAX);
  assert.equal(mapping.tempoFromPulse(undefined), 72);
});

test('keys rise with pulse but stay in a warm register', () => {
  const resting = mapping.rootForPulse(52);
  const lively = mapping.rootForPulse(100);
  assert.ok(lively > resting, 'a livelier pulse should lift the key');
  for (const bpm of [40, 60, 80, 120, 200]) {
    const midi = mapping.rootForPulse(bpm);
    assert.ok(midi >= 36 && midi <= 52, `root ${midi} should stay in the low register`);
  }
});

test('stress is read relative to a personal baseline, not absolutely', () => {
  assert.equal(mapping.relativeStress(120, 120), 0);
  assert.ok(mapping.relativeStress(240, 120) > 0.9);
  assert.ok(mapping.relativeStress(60, 120) < -0.4);
  // A missing or zero baseline must not produce NaN/Infinity.
  assert.equal(mapping.relativeStress(120, 0), 0);
  assert.equal(mapping.relativeStress(undefined, 120), 0);
});

test('mode selection responds to relative stress in both directions', () => {
  assert.equal(mapping.modeForStress(0.6).name, 'charged');
  assert.equal(mapping.modeForStress(-0.5).name, 'calm');
  assert.equal(mapping.modeForStress(0.0).name, 'drift');
});

test('breath opens the filter, poor signal closes it', () => {
  const good = mapping.padFilterHz(1, mapping.MODES.drift, 1);
  const shallow = mapping.padFilterHz(0, mapping.MODES.drift, 1);
  const badSignal = mapping.padFilterHz(1, mapping.MODES.drift, 0.1);
  assert.ok(good > shallow, 'a fuller breath should open the filter');
  assert.ok(badSignal < good * 0.6, 'a weak signal should thin the pad out');
  assert.ok(mapping.padFilterHz(1, mapping.MODES.drift, 1) < 6000);
});

test('melody notes always land on the active scale', () => {
  const mode = mapping.MODES.calm;
  const scale = mapping.SCALES[mode.scale];
  for (let seed = 0; seed < 40; seed += 1) {
    const note = mapping.melodyNote(45, mode, seed);
    assert.ok(Number.isFinite(note));
    const interval = (note - 45) % 12;
    assert.ok(scale.includes(interval), `note ${note} is outside the scale`);
  }
});

test('expression scores pick the strongest confident label', () => {
  assert.equal(
    mapping.strongestExpression([{ type: 5, confidence: 70 }, { type: 6, confidence: 20 }]),
    'happy',
  );
  // Everything below the confidence floor → no label at all.
  assert.equal(mapping.strongestExpression([{ type: 5, confidence: 12 }]), null);
  assert.equal(mapping.strongestExpression([]), null);
  assert.equal(mapping.strongestExpression(undefined), null);
});

test('a smile is more likely to add a bell than a flat expression', () => {
  const happy = mapping.sparkleChance('happy', 1);
  const sad = mapping.sparkleChance('sad', 1);
  const nothingSeen = mapping.sparkleChance(null, 0);
  assert.ok(happy > sad);
  assert.equal(nothingSeen, 0);
  assert.ok(happy <= 1 && sad >= 0);
});

// --- rolling buffer --------------------------------------------------------
test('ring buffer wraps without losing order', () => {
  const ring = new Ring(4);
  for (const v of [1, 2, 3, 4, 5, 6]) ring.push(v, v * 10);
  assert.deepEqual(ring.toArray(), [3, 4, 5, 6]);
  assert.deepEqual(ring.stampsArray(), [30, 40, 50, 60]);
  assert.equal(ring.last(), 6);
  assert.deepEqual(ring.minMax(), { min: 3, max: 6 });
});

test('ring buffer ignores non-finite samples', () => {
  const ring = new Ring(4);
  ring.push(NaN, 1);
  ring.push(Infinity, 2);
  ring.push(2, 3);
  assert.equal(ring.length, 1);
  assert.equal(ring.last(), 2);
});

// --- beat detection --------------------------------------------------------
test('finds roughly one beat per second in a 60 bpm pressure wave', () => {
  const beats = [];
  const detector = new BeatDetector({ onBeat: (b) => beats.push(b) });
  const seconds = 20;
  for (let i = 0; i < seconds * SAMPLE_HZ; i += 1) {
    const t = i / SAMPLE_HZ;
    detector.push(pressureSample(t, 60), t * 1000);
  }
  // 20 s at 60 bpm ≈ 20 beats; allow for the 4 s the threshold takes to arm
  // plus one refractory window.
  assert.ok(beats.length >= 15 && beats.length <= 20, `expected ~16-20 beats, got ${beats.length}`);
  const bpm = 60000 / detector.intervalMs;
  assert.ok(Math.abs(bpm - 60) < 3, `beat-derived bpm ${bpm.toFixed(1)} should be near 60`);
});

test('tracks a faster pulse and rejects a flat line', () => {
  const fast = new BeatDetector();
  for (let i = 0; i < 20 * SAMPLE_HZ; i += 1) {
    const t = i / SAMPLE_HZ;
    fast.push(pressureSample(t, 96), t * 1000);
  }
  const bpm = 60000 / fast.intervalMs;
  assert.ok(Math.abs(bpm - 96) < 4, `expected ~96, got ${bpm.toFixed(1)}`);

  const flat = new BeatDetector();
  for (let i = 0; i < 300; i += 1) flat.push(0.5, i * 33);
  assert.equal(flat.beatCount, 0, 'a flat waveform must not produce beats');
});

test('a dicrotic notch does not get counted as a second heartbeat', () => {
  // Real arterial waveforms have a secondary bump (the dicrotic notch) roughly
  // a third of a cycle after the systolic peak, at a fraction of its height.
  // Counting those as beats would double the tempo, so this is the regression
  // test for the amplitude gate in BeatDetector.
  const detector = new BeatDetector({ refractoryMs: 300 });
  const beats = [];
  detector.onBeat = (b) => beats.push(b);
  const cycles = 10;
  for (let i = 0; i < cycles * SAMPLE_HZ; i += 1) {
    const t = i / SAMPLE_HZ;
    detector.push(pressureSample(t, 60), t * 1000);
  }
  assert.ok(
    detector.beatCount <= cycles + 1,
    `expected about ${cycles} beats for ${cycles} cycles, got ${detector.beatCount}`,
  );
  const bpm = 60000 / detector.intervalMs;
  assert.ok(Math.abs(bpm - 60) < 4, `interval-derived bpm ${bpm.toFixed(1)} should be near 60`);
  assert.ok(beats.every((b) => Number.isFinite(b.strength)));
});

// --- full engine -----------------------------------------------------------
test('engine produces a usable snapshot from SDK-shaped packets', () => {
  const beats = [];
  const engine = new SignalEngine({ onBeat: (b) => beats.push(b) });
  let nowMs = 1_000_000;
  const now = () => nowMs;
  engine.now = now;

  for (let i = 0; i < 30 * SAMPLE_HZ; i += 1) {
    const t = i / SAMPLE_HZ;
    nowMs += 1000 / SAMPLE_HZ;
    engine.update(packet({
      t,
      pulseBpm: 72,
      breathBrpm: 15,
      hrv: i % 90 === 0 ? { baevsky: 140, rmssd: 40, sdnn: 50, meanNn: 850, confidence: 70, stable: true } : null,
    }), nowMs);
  }

  const snap = engine.snapshot();
  assert.ok(Math.abs(snap.pulseBpm - 72) < 1, `pulse should converge on 72, got ${snap.pulseBpm}`);
  assert.ok(Math.abs(snap.breathBpm - 15) < 1, `breath should converge on 15, got ${snap.breathBpm}`);
  assert.ok(snap.breathPhase >= 0 && snap.breathPhase <= 1, 'breath phase must be normalised');
  assert.ok(snap.beats > 15, `expected >15 beats over 30 s, got ${snap.beats}`);
  assert.ok(snap.quality > 0.3, `quality should rise on a clean signal, got ${snap.quality}`);
  assert.equal(snap.hasPressure, true);
  assert.equal(snap.hasChest, true);
  assert.ok(beats.length > 15);
  assert.ok(snap.hrv && snap.relativeStress >= -1 && snap.relativeStress <= 1);
});

test('validation failures pull quality down so the music thins out', () => {
  const engine = new SignalEngine();
  let nowMs = 5_000;
  const now = () => nowMs;
  engine.now = now;
  for (let i = 0; i < 10 * SAMPLE_HZ; i += 1) {
    nowMs += 1000 / SAMPLE_HZ;
    engine.update(packet({ t: i / SAMPLE_HZ }), nowMs);
  }
  const good = engine.snapshot().quality;
  engine.setValidation(1 /* kNoFaceFound */, 'no face');
  for (let i = 0; i < 10 * SAMPLE_HZ; i += 1) {
    nowMs += 1000 / SAMPLE_HZ;
    engine.update(packet({ t: (i + 300) / SAMPLE_HZ }), nowMs);
  }
  const bad = engine.snapshot().quality;
  assert.ok(bad < good * 0.5, `quality should collapse when the face is lost (${good} → ${bad})`);
});

test('ema handles missing history and bad input', () => {
  assert.equal(ema(null, 4, 0.5), 4);
  assert.equal(ema(4, NaN, 0.5), 4);
  assert.equal(ema(0, 10, 0.5), 5);
});

test('reset clears the session without throwing', () => {
  const engine = new SignalEngine();
  let nowMs = 0;
  engine.now = () => nowMs;
  for (let i = 0; i < 5 * SAMPLE_HZ; i += 1) {
    nowMs += 1000 / SAMPLE_HZ;
    engine.update(packet({ t: i / SAMPLE_HZ }), nowMs);
  }
  engine.reset();
  const snap = engine.snapshot();
  assert.equal(snap.pulseBpm, null);
  assert.equal(snap.hasChest, false);
  assert.equal(snap.metricsPackets, 0);
});
