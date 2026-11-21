// audio-engine.js — the synth.
//
// Design in one line: the SmartSpectra relative arterial pressure trace fires
// the drum kit, the breathing traces open and close the pad, and pulse /
// HRV / expression data choose the key, mode and ornaments.
//
// Signal path:
//   voices ─┬─► dryGain ─────────────────┐
//           └─► convolver ─► wetGain ────┤
//                                        └─► limiter ─► master ─► destination

'use strict';

const { midiToFreq, padFilterHz, padGain, melodyNote, sparkleChance, tempoFromPulse } = require('./mapping');

const LOOKAHEAD_S = 0.12; // schedule this far into the future (Web Audio standard practice)
const TICK_MS = 25;

const PRESETS = {
  ember: {
    label: 'Ember',
    padWave: 'triangle',
    padQ: 0.8,
    wet: 0.32,
    hatGain: 0.05,
    bellGain: 0.16,
    kickGain: 0.9,
    bassGain: 0.22,
  },
  tide: {
    label: 'Tide',
    padWave: 'sine',
    padQ: 1.6,
    wet: 0.5,
    hatGain: 0.025,
    bellGain: 0.12,
    kickGain: 0.65,
    bassGain: 0.3,
  },
  glass: {
    label: 'Glass',
    padWave: 'sawtooth',
    padQ: 2.6,
    wet: 0.24,
    hatGain: 0.06,
    bellGain: 0.22,
    kickGain: 0.55,
    bassGain: 0.12,
  },
};

function makeImpulseResponse(ctx, seconds = 2.8, decay = 2.4) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

function makeNoiseBuffer(ctx, seconds = 1) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

class AudioEngine {
  /**
   * @param {object} opts
   * @param {(e: {type: string}) => void} [opts.onEvent] fired when a note is played (visuals hook)
   */
  constructor({ onEvent = null } = {}) {
    this.onEvent = onEvent;
    this.ctx = null;
    this.started = false;
    this.presetName = 'ember';
    this.preset = PRESETS.ember;
    this.volume = 0.7;
    this.muted = false;

    this.snapshot = null;
    this.mode = null;
    this.rootMidi = 43;

    this.bpm = 72;
    this._nextGridTime = 0;
    this._gridStep = 0;
    this._barCount = 0;
    this._lastRealBeatAtS = -Infinity;

    this._timer = null;
    this._scheduler = () => this._tick();
  }

  get running() {
    return this.started && this.ctx != null;
  }

  async start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeImpulseResponse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = this.preset.wet;

    this.dry.connect(this.limiter);
    this.convolver.connect(this.wet);
    this.wet.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    this.noise = makeNoiseBuffer(ctx);

    this._buildPad();
    this._setMasterGain(this.muted ? 0 : this.volume, 0.8);

    this.started = true;
    this._nextGridTime = ctx.currentTime + 0.15;
    this._timer = setInterval(this._scheduler, TICK_MS);
    await ctx.resume();
  }

  _buildPad() {
    const ctx = this.ctx;
    // Pad: filter + volume are driven continuously by the breath signal.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 600;
    this.padFilter.Q.value = this.preset.padQ;

    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.0001;

    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.dry);
    this.padGain.connect(this.convolver);

    // Four chord voices, each a detuned pair. Retuned (never re-created) when
    // the chord changes, so there is no allocation in the audio path.
    this.padVoices = [];
    for (let i = 0; i < 4; i += 1) {
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.type = this.preset.padWave;
      b.type = this.preset.padWave;
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 0.22;
      a.connect(voiceGain);
      b.connect(voiceGain);
      voiceGain.connect(this.padFilter);
      a.start();
      b.start();
      this.padVoices.push({ a, b, gain: voiceGain });
    }
    this._tunePad(this.rootMidi, [0, 7, 12, 16], 0.01);
  }

  _tunePad(rootMidi, chordSemitones, glide = 0.25) {
    const ctx = this.ctx;
    if (!ctx || !this.padVoices) return;
    const now = ctx.currentTime;
    const detune = this.mode ? this.mode.detune : 4;
    this.padVoices.forEach((voice, i) => {
      const midi = rootMidi + (chordSemitones[i] ?? 12);
      const f = midiToFreq(midi);
      voice.a.frequency.setTargetAtTime(f, now, glide);
      voice.b.frequency.setTargetAtTime(f * Math.pow(2, detune / 1200), now, glide);
    });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (!this.ctx) return;
    const ctx = this.ctx;
    this._setMasterGain(0, 0.25);
    this.started = false;
    // Let the tail ring out, then close the context.
    setTimeout(() => {
      if (this.ctx === ctx) {
        ctx.close().catch(() => {});
        this.ctx = null;
      }
    }, 500);
  }

  setPreset(name) {
    if (!PRESETS[name]) return;
    this.presetName = name;
    this.preset = PRESETS[name];
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.padFilter.Q.setTargetAtTime(this.preset.padQ, now, 0.2);
    this.wet.gain.setTargetAtTime(this.preset.wet, now, 0.2);
    for (const voice of this.padVoices) {
      voice.a.type = this.preset.padWave;
      voice.b.type = this.preset.padWave;
    }
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx && !this.muted) this._setMasterGain(this.volume, 0.1);
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.ctx) this._setMasterGain(this.muted ? 0 : this.volume, 0.15);
  }

  _setMasterGain(value, tau) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(Math.max(0.0001, value), now, tau);
  }

  /** Called ~60 fps from the render loop with the current signal snapshot. */
  update(snapshot) {
    this.snapshot = snapshot;
    if (!this.ctx || !snapshot) return;

    const now = this.ctx.currentTime;
    const quality = snapshot.quality ?? 0;
    const phase = snapshot.breathPhase ?? 0.5;

    const targetCutoff = padFilterHz(phase, this.mode, quality);
    this.padFilter.frequency.setTargetAtTime(targetCutoff, now, 0.12);
    this.padGain.gain.setTargetAtTime(Math.max(0.0001, padGain(phase, quality)), now, 0.15);

    const bpm = tempoFromPulse(snapshot.bpmFromBeats || snapshot.pulseBpm);
    this.bpm = bpm;
    const halo = bpm / (snapshot.pulseBpm || bpm);
    // Only stretch the pad if the beat-derived tempo went out of range.
    this._bpmScale = Math.min(1.25, Math.max(0.8, halo));
  }

  /** Musical mode + key changed (called by the render loop when it changes). */
  setTonality({ mode, rootMidi, chordSemitones }) {
    const modeChanged = !this.mode || this.mode.name !== mode.name;
    this.mode = mode;
    if (this.ctx && modeChanged) {
      this.rootMidi = rootMidi;
      this._tunePad(rootMidi, chordSemitones || mode.chordSemitones);
    } else if (modeChanged) {
      this.rootMidi = rootMidi;
    }
  }

  /** A real heartbeat was detected in the pressure waveform. */
  hitBeat(beat) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    this._lastRealBeatAtS = t;
    const strength = Math.min(1, Math.max(0.25, beat && beat.strength ? 0.45 + beat.strength * 0.55 : 0.8));
    this._kick(t, strength);
    if (this.onEvent) this.onEvent({ type: 'beat', strength, source: 'waveform' });
  }

  // --- scheduling ---------------------------------------------------------

  _tick() {
    if (!this.ctx || !this.started) return;
    const now = this.ctx.currentTime;
    const tempo = this.bpm || 72;
    const step = 60 / tempo / 2; // eighth notes
    if (this._nextGridTime < now) this._nextGridTime = now + 0.02;

    while (this._nextGridTime < now + LOOKAHEAD_S) {
      this._scheduleGridStep(this._nextGridTime, this._gridStep, step);
      this._nextGridTime += step;
      this._gridStep = (this._gridStep + 1) % 8;
    }
  }

  _scheduleGridStep(t, stepIndex, step) {
    const snap = this.snapshot;
    const quality = snap ? snap.quality ?? 0 : 0;
    if (quality <= 0.05) return; // nothing to play to: stay silent rather than invent

    const realBeats = (this.ctx.currentTime - this._lastRealBeatAtS) < 4;
    const onBeat = stepIndex % 2 === 0;

    // Hats: the "air" of the loop. Quieter when the signal is weak.
    if (this.preset.hatGain > 0) {
      this._hat(t, this.preset.hatGain * (0.4 + 0.6 * quality) * (onBeat ? 1 : 0.55));
    }

    // When the waveform is driving the kick, don't double up with a
    // metronome — that would smear the groove. When it isn't (first seconds,
    // weak trace), the grid keeps time instead so the app is never silent.
    if (!realBeats && onBeat) {
      this._kick(t, this.preset.kickGain * (0.5 + 0.5 * quality));
    }

    if (stepIndex === 0) {
      this._barCount += 1;
      this._bass(t, this.preset.bassGain * (0.5 + 0.5 * quality));

      const chance = sparkleChance(expressionName(snap), quality);
      if (Math.random() < chance) {
        const seed = this._barCount * 7 + (snap && snap.breathDirection === 1 ? 3 : 0);
        const note = melodyNote(this.rootMidi, this.mode, seed);
        this._bell(t + 0.02, note, this.preset.bellGain);
        if (this.onEvent) this.onEvent({ type: 'bell' });
      }
    }
  }

  // --- one-shot voices ----------------------------------------------------

  _kick(t, gain) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    osc.connect(g);
    g.connect(this.dry);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  _hat(t, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0005, gain), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.dry);
    src.start(t);
    src.stop(t + 0.12);
  }

  _bass(t, gain) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = midiToFreq(this.rootMidi - 12);
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(lp);
    lp.connect(g);
    g.connect(this.dry);
    osc.start(t);
    osc.stop(t + 1.0);
  }

  _bell(t, midi, gain) {
    const ctx = this.ctx;
    const f = midiToFreq(midi);
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc2.type = 'triangle';
    osc.frequency.value = f;
    osc2.frequency.value = f * 2.004; // slightly stretched octave = glassy
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    osc.connect(g);
    osc2.connect(g);
    g.connect(this.dry);
    g.connect(this.convolver);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + 1.7);
    osc2.stop(t + 1.7);
  }
}

function expressionName(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.expression)) return null;
  let best = null;
  for (const s of snapshot.expression) {
    if (!s || !Number.isFinite(s.confidence)) continue;
    if (!best || s.confidence > best.confidence) best = s;
  }
  if (!best || best.confidence < 40) return null;
  const names = { 1: 'angry', 2: 'contempt', 3: 'disgust', 4: 'fear', 5: 'happy', 6: 'neutral', 7: 'sad', 8: 'surprise' };
  return names[best.type] || null;
}

module.exports = { AudioEngine, PRESETS, expressionName, makeImpulseResponse, makeNoiseBuffer };
