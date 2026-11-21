// signal-engine.js
//
// Turns the raw SmartSpectra Metrics payload into a small, smoothed "signal
// snapshot" that the audio engine and the visuals can both read at 60 fps.
//
// Everything here is pure data handling: no Web Audio, no DOM, no SDK import.
// That keeps it testable in plain Node (test/logic.test.js feeds it synthetic
// waveforms).

'use strict';

/** Fixed-size rolling buffer of (value, timestampUs) samples. */
class Ring {
  constructor(capacity) {
    this.capacity = capacity;
    this.values = new Float64Array(capacity);
    this.stamps = new Float64Array(capacity);
    this.size = 0;
    this.head = 0; // index of the next write
  }

  push(value, stamp) {
    if (!Number.isFinite(value)) return;
    this.values[this.head] = value;
    this.stamps[this.head] = Number.isFinite(stamp) ? stamp : 0;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  get length() {
    return this.size;
  }

  /** Oldest → newest. */
  toArray() {
    const out = new Array(this.size);
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      out[i] = this.values[(start + i) % this.capacity];
    }
    return out;
  }

  /** Oldest → newest timestamps (µs). */
  stampsArray() {
    const out = new Array(this.size);
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) {
      out[i] = this.stamps[(start + i) % this.capacity];
    }
    return out;
  }

  last() {
    if (this.size === 0) return null;
    return this.values[(this.head - 1 + this.capacity) % this.capacity];
  }

  lastStamp() {
    if (this.size === 0) return null;
    return this.stamps[(this.head - 1 + this.capacity) % this.capacity];
  }

  minMax() {
    if (this.size === 0) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.size; i += 1) {
      const v = this.values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  clear() {
    this.size = 0;
    this.head = 0;
  }
}

/**
 * Beat detector for the (uncalibrated, unitless) relative arterial pressure
 * trace.
 *
 * The SDK gives us a waveform, not beat events, so we find the systolic
 * upstroke ourselves: a sample rising above the recent mean plus a fraction of
 * the recent peak-to-peak amplitude starts a beat, and it re-arms only after
 * the wave falls back near the mean. That hysteresis is what keeps a noisy
 * baseline from firing twice on one heartbeat.
 */
class BeatDetector {
  constructor({ refractoryMs = 300, windowSamples = 120, onBeat = null } = {}) {
    this.refractoryMs = refractoryMs;
    this.recent = new Ring(windowSamples);
    this.high = false;
    this.lastBeatMs = -Infinity;
    this.onBeat = onBeat;
    this.intervals = []; // recent beat-to-beat intervals (ms)
    this.intervalMs = null; // median of this.intervals
    this.beatCount = 0;
  }

  /**
   * @param {number} value wave sample (unitless)
   * @param {number} elapsedMs milliseconds since the session started
   */
  push(value, elapsedMs) {
    if (!Number.isFinite(value)) return null;
    this.recent.push(value, elapsedMs);
    const { min, max } = this.recent.minMax();
    const amp = max - min;
    // A flat line is not a pulse. Require a real swing before we call beats.
    if (this.recent.length < 20 || amp < 1e-6) {
      this.high = false;
      return null;
    }
    const mean = (min + max) / 2;
    // Two gates have to agree before we call a beat:
    //   * the sample is high in the wave's own range (mean + a fraction of the
    //     swing), and
    //   * the sample is near the top of the range — the dicrotic notch and
    //     other secondary bumps sit well below the systolic peak, and this is
    //     what stops them from firing a second "beat" in the same cycle.
    const hi = Math.max(mean + 0.35 * amp, min + 0.72 * amp);
    const lo = mean + 0.05 * amp;

    // Hysteresis re-arm.
    if (this.high && value < lo) this.high = false;

    // Guard against the dicrotic notch being read as a second beat: once we
    // have an interval estimate, require at least 55% of it to have elapsed
    // before a new beat can fire (a notch lands ~30-40% into the cycle).
    const adaptiveMs = this.intervalMs ? Math.max(this.refractoryMs, this.intervalMs * 0.55) : this.refractoryMs;
    const quiet = elapsedMs - this.lastBeatMs >= adaptiveMs;
    if (!this.high && value >= hi && quiet) {
      this.high = true;
      const dt = elapsedMs - this.lastBeatMs;
      if (Number.isFinite(dt) && dt > 0 && dt < 3000) {
        this.intervals.push(dt);
        if (this.intervals.length > 7) this.intervals.shift();
        // Median, not mean: one spurious short gap must not rewrite the tempo.
        const sorted = [...this.intervals].sort((a, b) => a - b);
        this.intervalMs = sorted[Math.floor(sorted.length / 2)];
      }
      this.lastBeatMs = elapsedMs;
      this.beatCount += 1;
      const beat = {
        atMs: elapsedMs,
        strength: clamp01((value - min) / (amp || 1)),
        bpmFromBeats: this.intervalMs ? 60000 / this.intervalMs : null,
      };
      if (this.onBeat) this.onBeat(beat);
      return beat;
    }
    return null;
  }

  reset() {
    this.recent.clear();
    this.high = false;
    this.lastBeatMs = -Infinity;
    this.intervals = [];
    this.intervalMs = null;
    this.beatCount = 0;
  }
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function ema(prev, next, alpha) {
  if (prev == null || !Number.isFinite(prev)) return next;
  if (!Number.isFinite(next)) return prev;
  return prev * (1 - alpha) + next * alpha;
}

function latestValue(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const last = arr[arr.length - 1];
  if (!last || !Number.isFinite(last.value)) return null;
  return last;
}

/**
 * Collects everything Systole needs to play. One instance per session.
 */
class SignalEngine {
  constructor({ onBeat = null, now = () => Date.now() } = {}) {
    this.now = now;
    this.startedAtMs = null;

    // traces
    this.chest = new Ring(2400);
    this.abdomen = new Ring(2400);
    this.pressure = new Ring(2400);

    // derived, smoothed
    this.pulseBpm = null;
    this.breathBpm = null;
    this.pulseConfidence = 0;
    this.breathConfidence = 0;
    this.breathPhase = 0.5;
    this.breathDirection = 0; // -1 exhaling, +1 inhaling
    this.quality = 0; // 0..1, has the camera actually got a usable read on you
    this.hrv = null;
    this.stressBaseline = null;
    this.relativeStress = 0;
    this.expression = null;
    this.blinking = null;
    this.talking = null;
    this.validation = { code: 0, hint: '' };
    this.lastMetricsAtMs = null;
    this.metricsPackets = 0;

    this.beats = new BeatDetector({ onBeat });
    this._lastBreathPhase = 0.5;
  }

  /** Reset per-session state (called on Start). */
  reset() {
    this.startedAtMs = null;
    this.chest.clear();
    this.abdomen.clear();
    this.pressure.clear();
    this.pulseBpm = null;
    this.breathBpm = null;
    this.pulseConfidence = 0;
    this.breathConfidence = 0;
    this.breathPhase = 0.5;
    this.breathDirection = 0;
    this.quality = 0;
    this.hrv = null;
    this.stressBaseline = null;
    this.relativeStress = 0;
    this.expression = null;
    this.blinking = null;
    this.talking = null;
    this.validation = { code: 0, hint: '' };
    this.lastMetricsAtMs = null;
    this.metricsPackets = 0;
    this.beats.reset();
  }

  setValidation(code, hint) {
    this.validation = { code, hint: hint || '' };
  }

  elapsedMs() {
    if (this.startedAtMs == null) return 0;
    return this.now() - this.startedAtMs;
  }

  /**
   * Feed one decoded Metrics object (the output of decodeMetrics()).
   */
  update(metrics, receivedAtMs = this.now()) {
    if (!metrics) return null;
    if (this.startedAtMs == null) this.startedAtMs = receivedAtMs;
    this.lastMetricsAtMs = receivedAtMs;
    this.metricsPackets += 1;

    const breathing = metrics.breathing || null;
    const cardio = metrics.cardio || null;
    const face = metrics.face || null;

    // --- breathing ---------------------------------------------------------
    if (breathing) {
      const rate = latestValue(breathing.rate);
      if (rate) {
        this.breathBpm = ema(this.breathBpm, rate.value, 0.25);
        this.breathConfidence = ema(this.breathConfidence, clamp01((rate.confidence || 0) / 100), 0.2);
      }
      this._append(breathing.upperTrace, this.chest);
      this._append(breathing.lowerTrace, this.abdomen);
    }

    // --- cardio ------------------------------------------------------------
    if (cardio) {
      const pulse = latestValue(cardio.pulseRate);
      if (pulse) {
        this.pulseBpm = ema(this.pulseBpm, pulse.value, 0.25);
        this.pulseConfidence = ema(this.pulseConfidence, clamp01((pulse.confidence || 0) / 100), 0.2);
      }
      this._append(cardio.arterialPressureTrace, this.pressure);

      const hrv = Array.isArray(cardio.hrv) && cardio.hrv.length ? cardio.hrv[cardio.hrv.length - 1] : null;
      if (hrv && Number.isFinite(hrv.baevsky)) {
        this.hrv = hrv;
        // Slow personal baseline (≈ the first minute and a half of a session
        // dominates it, after which it tracks drift).
        this.stressBaseline = this.stressBaseline == null
          ? hrv.baevsky
          : this.stressBaseline * 0.98 + hrv.baevsky * 0.02;
        this.relativeStress = this.stressBaseline > 0
          ? Math.min(1, Math.max(-1, (hrv.baevsky - this.stressBaseline) / this.stressBaseline))
          : 0;
      }
    }

    // --- face (optional bundle) -------------------------------------------
    if (face) {
      const expression = Array.isArray(face.expression) && face.expression.length
        ? face.expression[face.expression.length - 1]
        : null;
      if (expression && Array.isArray(expression.scores)) {
        this.expression = expression.scores;
      }
      const blink = Array.isArray(face.blinking) && face.blinking.length
        ? face.blinking[face.blinking.length - 1]
        : null;
      if (blink) this.blinking = !!blink.detected;
      const talking = Array.isArray(face.talking) && face.talking.length
        ? face.talking[face.talking.length - 1]
        : null;
      if (talking) this.talking = !!talking.detected;
    }

    this._updateBreathPhase();
    this._updateQuality();

    // Drive the beat detector in "session time" (ms since first packet).
    const pressure = this.pressure.last();
    if (pressure != null) {
      this.beats.push(pressure, this.elapsedMs());
    }
    return this.snapshot();
  }

  _append(samples, ring) {
    if (!Array.isArray(samples)) return;
    for (const s of samples) {
      if (!s) continue;
      const ts = typeof s.timestamp === 'bigint' ? Number(s.timestamp) : s.timestamp;
      ring.push(s.value, ts);
    }
  }

  _updateBreathPhase() {
    const source = this.chest.length > 30 ? this.chest : (this.abdomen.length > 30 ? this.abdomen : null);
    if (!source) return;
    const { min, max } = source.minMax();
    const span = max - min;
    if (span < 1e-6) return;
    const last = source.last();
    const raw = (last - min) / span;
    // Smoothing keeps the pad from zippering on every sample.
    this.breathPhase = ema(this._lastBreathPhase, Math.min(1, Math.max(0, raw)), 0.12);
    const direction = this.breathPhase - this._lastBreathPhase;
    this.breathDirection = Math.abs(direction) < 1e-4 ? 0 : Math.sign(direction);
    this._lastBreathPhase = this.breathPhase;
  }

  _updateQuality() {
    // Confidence is our best proxy for "the numbers are trustworthy right
    // now", and the SDK's own validation status tells us whether the camera
    // can see the person at all.
    const conf = Math.min(
      this.pulseConfidence || 0,
      this.breathConfidence || 0,
    );
    const verdict = this.validation.code === 0 ? 1 : 0.15;
    const target = Math.min(1, conf * 1.4) * verdict;
    this.quality = ema(this.quality, target, 0.08);
  }

  /** Snapshot handed to the audio engine + canvas each frame. */
  snapshot() {
    return {
      elapsedMs: this.elapsedMs(),
      pulseBpm: this.pulseBpm,
      pulseConfidence: this.pulseConfidence,
      breathBpm: this.breathBpm,
      breathConfidence: this.breathConfidence,
      breathPhase: this.breathPhase,
      breathDirection: this.breathDirection,
      quality: this.quality,
      hrv: this.hrv,
      relativeStress: this.relativeStress,
      expression: this.expression,
      blinking: this.blinking,
      talking: this.talking,
      validation: this.validation,
      beats: this.beats.beatCount,
      bpmFromBeats: this.beats.intervalMs ? 60000 / this.beats.intervalMs : null,
      chest: this.chest.toArray(),
      pressure: this.pressure.toArray(),
      hasChest: this.chest.length > 0,
      hasPressure: this.pressure.length > 0,
      metricsPackets: this.metricsPackets,
    };
  }
}

module.exports = { Ring, BeatDetector, SignalEngine, ema, clamp01 };
