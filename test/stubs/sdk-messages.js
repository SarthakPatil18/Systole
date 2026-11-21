'use strict';

// Stub for `@smartspectra/node-sdk/messages` — the smoke harness never feeds a
// real protobuf buffer, it drives the simulator instead.
function decodeMetrics(buf) {
  return buf;
}

module.exports = { decodeMetrics };
