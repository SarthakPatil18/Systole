// Stub for `@smartspectra/node-sdk/renderer`, used only by the headless smoke
// harness (test/smoke.js). The real package is bundled in normal builds.
'use strict';

class SmartSpectraSDK {
  constructor(options) {
    this.options = options || {};
    this.listeners = Object.create(null);
  }
  on(event, cb) {
    (this.listeners[event] ||= []).push(cb);
    return this;
  }
  emit(event, ...args) {
    for (const cb of this.listeners[event] || []) cb(...args);
  }
  async start() { this.emit('processingStatus', 3); }
  async stop() {}
  async reset() {}
  destroy() {}
}

const ProcessingStatus = {
  kUninitialized: 0, kIdle: 1, kStarting: 2, kRunning: 3, kStopping: 4, kError: 5,
};

const ValidationCode = {
  kOk: 0, kNoFaceFound: 1, kMultipleFacesFound: 2, kFaceNotCentered: 3,
  kFaceSizeOutOfRange: 4, kTooDark: 5, kTooBright: 6, kChestNotVisible: 7,
  kCameraTuning: 10, kFrameRateTooLow: 11, kExcessiveMotion: 12,
  kFaceTooClose: 13, kFaceTooFar: 14, kFaceTooHigh: 15, kFaceTooLow: 16,
  kFaceNotForward: 17,
};

module.exports = {
  SmartSpectraSDK,
  ProcessingStatus,
  ValidationCode,
  breathingMetrics: [0, 1, 2],
  cardioMetrics: [15, 16, 17],
  MetricType: { EXPRESSIONS: 14 },
};
