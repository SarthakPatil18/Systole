// mapping.js — the musical brain of Systole.
//
// Pure functions only: given a signal snapshot, decide which notes, chords,
// timbres and visual parameters the instrument should use. No Web Audio, no
// DOM, no SDK — which is what lets this file be unit tested in plain Node
// (see test/logic.test.js).

'use strict';

// --- note tables ------------------------------------------------------------
// MIDI note numbers. 69 = A4 = 440 Hz.
const SCALES = {
  // "settled" — open, bright, no leading tone pulling anywhere
  majorPentatonic: [0, 2, 4, 7, 9],
  // "charged" — softer, more inward
  minorPentatonic: [0, 3, 5, 7, 10],
  // airy middle ground
  suspended: [0, 2, 5, 7, 10],
};

const MODES = {
  calm: { name: 'calm', scale: 'majorPentatonic', chordSemitones: [0, 7, 12, 16], padCutoff: 1.0, detune: 3 },
  drift: { name: 'drift', scale: 'suspended', chordSemitones: [0, 7, 10, 14], padCutoff: 0.8, detune: 6 },
  charged: { name: 'charged', scale: 'minorPentatonic', chordSemitones: [0, 7, 10, 15], padCutoff: 0.55, detune: 9 },
};

const ROOT_BY_PULSE = [
  // resting pulse sits low and warm; a livelier pulse lifts the key.
  { max: 60, midi: 41 }, // F2
  { max: 72, midi: 43 }, // G2
  { max: 84, midi: 45 }, // A2
  { max: 96, midi: 47 }, // B2
  { max: Infinity, midi: 48 }, // C3
];

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function rootForPulse(pulseBpm) {
  if (!Number.isFinite(pulseBpm)) return 43;
  for (const row of ROOT_BY_PULSE) {
    if (pulseBpm < row.max) return row.midi;
  }
  return 48;
}

// Baevsky's stress index is reported without a unit and is only meaningful
// relative to your own baseline, so we compare the current value with a
// slow-moving personal baseline rather than using an absolute threshold.
function relativeStress(baevsky, baseline) {
  if (!Number.isFinite(baevsky) || !Number.isFinite(baseline) || baseline <= 0) return 0;
  // -1 = calmer than your own baseline, +1 = more charged than your baseline
  return clamp((baevsky - baseline) / baseline, -1, 1);
}

function modeForStress(stress) {
  if (stress >= 0.25) return MODES.charged;
  if (stress <= -0.15) return MODES.calm;
  return MODES.drift;
}

// The breathing trace swings between two extremes; breathPhase is where we
// are in that swing (0 = relaxed, 1 = full inhale).
function breathPhaseFrom(normalized) {
  return clamp(Number.isFinite(normalized) ? normalized : 0.5, 0, 1);
}

// Second line of response: the breath physically opens the filter and the
// pad volume, so you can hear yourself breathing even before the numbers
// settle.
function padFilterHz(breathPhase, mode, quality) {
  const open = clamp(breathPhase, 0, 1);
  const base = 320 + open * 2100;
  const shaped = base * (mode ? mode.padCutoff : 1);
  // When the camera can't see you well the pad closes down — the music
  // audibly "thins out" instead of guessing.
  return clamp(shaped * (0.35 + 0.65 * clamp(quality, 0, 1)), 180, 6000);
}

function padGain(breathPhase, quality) {
  return clamp(0.035 + 0.075 * clamp(breathPhase, 0, 1), 0, 0.14) * (0.25 + 0.75 * clamp(quality, 0, 1));
}

// Pick a melody note from the active scale. `seed` keeps it deterministic so
// the same signal snapshot always produces the same note (nice for tests and
// for replaying a demo).
function melodyNote(rootMidi, mode, seed) {
  const scale = SCALES[mode && mode.scale] || SCALES.majorPentatonic;
  const s = Math.abs(Math.floor(seed || 0));
  const degree = s % scale.length;
  const octave = 12 * (1 + (s % 5 === 4 ? 1 : 0));
  return rootMidi + scale[degree] + octave;
}

// Expression → a gentle tilt of the palette. Deliberately *not* an emotion
// classifier in the UI: the app never tells you how you feel, it just lets a
// smile add a little sparkle and a flat expression leave the room quiet.
const EXPRESSION_TYPES = {
  0: 'unspecified',
  1: 'angry',
  2: 'contempt',
  3: 'disgust',
  4: 'fear',
  5: 'happy',
  6: 'neutral',
  7: 'sad',
  8: 'surprise',
};

function strongestExpression(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return null;
  let best = null;
  for (const s of scores) {
    if (!s) continue;
    const conf = Number(s.confidence);
    if (!Number.isFinite(conf)) continue;
    if (!best || conf > best.confidence) best = { confidence: conf, type: s.type };
  }
  if (!best || best.confidence < 40) return null;
  return EXPRESSION_TYPES[best.type] || null;
}

// Sparkle budget: how likely a bell is allowed to ring on the next bar.
function sparkleChance(expression, quality) {
  const q = clamp(quality, 0, 1);
  switch (expression) {
    case 'happy':
    case 'surprise':
      return 0.85 * q;
    case 'neutral':
      return 0.35 * q;
    case 'sad':
    case 'angry':
    case 'fear':
      return 0.12 * q;
    default:
      return 0.3 * q;
  }
}

// Tempo: we trust the measured pulse, but keep it inside a range where the
// music still sounds like music (a 40 BPM pulse as a kick drum is a dirge).
const TEMPO_MIN = 52;
const TEMPO_MAX = 132;

function tempoFromPulse(pulseBpm) {
  if (!Number.isFinite(pulseBpm) || pulseBpm <= 0) return 72;
  return clamp(pulseBpm, TEMPO_MIN, TEMPO_MAX);
}

module.exports = {
  SCALES,
  MODES,
  clamp,
  midiToFreq,
  rootForPulse,
  relativeStress,
  modeForStress,
  breathPhaseFrom,
  padFilterHz,
  padGain,
  melodyNote,
  strongestExpression,
  sparkleChance,
  tempoFromPulse,
  TEMPO_MIN,
  TEMPO_MAX,
};
