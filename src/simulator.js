// simulator.js — SIMULATED signals, for developing the instrument without a
// camera and for judges who want to poke at the UI before granting camera
// access. It fabricates a plausible Metrics-shaped object on a timer; it does
// NOT measure anything and the UI labels it loudly ("SIMULATED").
//
// Never use this to demo the challenge entry: the point of the entry is the
// live SmartSpectra signal.

'use strict';

class Simulator {
  constructor({ onMetrics = null, fps = 30 } = {}) {
    this.onMetrics = onMetrics;
    this.interval = 1000 / fps;
    this.timer = null;
    this.t = 0;
    this.pressureCarry = [];
    this.chestCarry = [];
    this.hrvCountdown = 0;
  }

  start() {
    if (this.timer) return;
    this.t = 0;
    this.timer = setInterval(() => this._emit(), this.interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _emit() {
    this.t += this.interval / 1000;
    const t = this.t;
    // breathing: ~13-16 breaths / min, with a slow slow drift
    const breathFreq = (13.5 + Math.sin(t / 47) * 1.8) / 60;
    const pulseFreq = (70 + Math.sin(t / 23) * 4) / 60;
    const nowUs = Date.now() * 1000;
    const n = 1;

    const chest = [];
    const pressure = [];
    for (let i = 0; i < n; i += 1) {
      const ts = nowUs - (n - 1 - i) * (this.interval * 1000);
      chest.push({ value: Math.sin(2 * Math.PI * breathFreq * t), timestamp: ts, stable: true });
      // crude arterial pressure wave: fundamental + dicrotic notch harmonic
      const phase = 2 * Math.PI * pulseFreq * t;
      pressure.push({
        value:
          Math.sin(phase) +
          0.35 * Math.sin(2 * phase + 1.1) +
          0.12 * Math.sin(3 * phase + 0.4),
        timestamp: ts,
        stable: true,
      });
    }

    this.chestCarry = this.chestCarry.concat(chest).slice(-240);
    this.pressureCarry = this.pressureCarry.concat(pressure).slice(-240);

    const metrics = {
      breathing: {
        rate: [{
          value: breathFreq * 60,
          confidence: 82,
          stable: true,
          timestamp: nowUs,
        }],
        upperTrace: this.chestCarry.slice(-1),
        lowerTrace: [],
      },
      cardio: {
        pulseRate: [{
          value: pulseFreq * 60,
          confidence: 88,
          stable: true,
          timestamp: nowUs,
        }],
        arterialPressureTrace: this.pressureCarry.slice(-1),
        hrv: [],
      },
      face: {},
    };

    this.hrvCountdown -= 1;
    if (this.hrvCountdown <= 0) {
      this.hrvCountdown = 60; // roughly every 2 s at 30 fps
      metrics.cardio.hrv = [{
        rmssd: 42 + Math.sin(t / 31) * 8,
        meanNn: 860,
        sdnn: 51,
        baevsky: 120 + Math.sin(t / 17) * 40,
        confidence: 70,
        stable: true,
        timestamp: nowUs,
      }];
      if (Math.sin(t / 19) > 0.6) {
        metrics.face = {
          expression: [{
            stable: true,
            timestamp: nowUs,
            scores: [
              { type: 5, confidence: 62 }, // happy
              { type: 6, confidence: 33 }, // neutral
            ],
          }],
        };
      }
    }

    if (this.onMetrics) this.onMetrics(metrics, nowUs);
  }
}

module.exports = { Simulator };
