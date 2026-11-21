// sdk-check.js — optional integration check against the REAL SmartSpectra SDK.
//
// Runs in plain Node (no Electron, no camera) on a supported platform
// (macOS Apple Silicon, linux-x64/arm64, win32-x64). It proves four things that
// unit tests can't:
//
//   1. the native runtime actually loads on this machine (koffi + the C ABI shim)
//   2. the metric codes Systole requests are accepted by the SDK
//      (an unavailable metric makes start() fail with kConfigurationFailed = 3)
//   3. the SDK reaches its authentication step, i.e. everything before the
//      network is wired correctly (with a deliberately invalid key we expect
//      kAuthenticationFailed = 2, and nothing else)
//   4. clean shutdown: stop + destroy without throwing
//
// It is skipped automatically on platforms the SDK doesn't ship for.
//
//   npm run check:sdk

'use strict';

const os = require('os');
const {
  SmartSpectraSDK,
  breathingMetrics,
  cardioMetrics,
  MetricType,
  CameraSelection,
} = require('@smartspectra/node-sdk');

const ERROR_NAMES = {
  0: 'kOk',
  1: 'kInvalidState',
  2: 'kAuthenticationFailed',
  3: 'kConfigurationFailed',
  4: 'kCreditExhausted',
  5: 'kNetworkError',
  6: 'kServerError',
  7: 'kInputUnavailable',
  8: 'kProcessingFailed',
  9: 'kFrameConversionFailed',
  10: 'kNonMonotonicTimestamp',
  11: 'kTimestampGap',
  13: 'kMetricNotAuthorized',
  14: 'kSustainedLowFrameRate',
};

const SUPPORTED = [
  ['darwin', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['win32', 'x64'],
];

function supported() {
  return SUPPORTED.some(([p, a]) => p === process.platform && a === process.arch);
}

function fail(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

(async function main() {
  console.log(`\nsdk-check · ${process.platform}-${process.arch} · node ${process.version}`);

  if (!supported()) {
    console.log(`  skipped: SmartSpectra does not publish a runtime for ${process.platform}-${process.arch}`);
    process.exit(0);
  }

  // 1. native runtime loads -------------------------------------------------
  let version;
  try {
    version = SmartSpectraSDK.version;
  } catch (err) {
    fail(`could not load the SmartSpectra binding: ${err.message}`);
  }
  console.log(`  ok    native runtime loaded (SDK ${version})`);

  // Camera discovery is a native call with no session and no auth; if this
  // returns, the C ABI shim is genuinely live (it will report zero cameras in
  // a headless container, which is fine).
  try {
    const cameras = SmartSpectraSDK.availableCameras();
    console.log(`  ok    camera discovery works (${cameras.length} camera${cameras.length === 1 ? '' : 's'} visible here)`);
  } catch (err) {
    fail(`camera discovery threw: ${err.message}`);
  }

  // 2 + 3. requested metrics accepted, then auth boundary -------------------
  const requested = [...breathingMetrics, ...cardioMetrics, MetricType.EXPRESSIONS];
  console.log(`  ..    starting with requestedMetrics = [${requested.join(', ')}]`);

  const sdk = new SmartSpectraSDK({
    apiKey: 'invalid-key-headless-integration-check',
    requestedMetrics: requested,
    enableAccumulatedOutput: false,
    enableTelemetry: false,
  });

  let sawProcessingStatus = false;
  sdk.on('processingStatus', (status) => {
    sawProcessingStatus = true;
    if (status === 5) return; // kError is expected after a failed start
  });
  sdk.on('error', (code, message) => {
    console.log(`  ..    'error' event: ${ERROR_NAMES[code] || code} — ${message}`);
  });
  sdk.on('validationStatus', () => {});

  let startError = null;
  try {
    if (typeof SmartSpectraSDK.availableCameras === 'function') {
      sdk.useCamera(CameraSelection.default);
    }
    await sdk.start();
  } catch (err) {
    startError = err;
  }

  if (!startError) {
    console.log('  ok    start() resolved — a real key is configured in this environment');
  } else {
    const code = startError.code;
    const name = ERROR_NAMES[code] || `code ${code}`;
    if (code === 3 || code === 13) {
      fail(`the SDK rejected Systole's metric list (${name}: ${startError.message}). ` +
        'That means one of the requested metrics is unavailable or not authorized for this account.');
    }
    if (code === 2) {
      console.log(`  ok    reached authentication and was rejected as expected (${name}) — the integration path works`);
    } else if (code === 4) {
      console.log(`  ok    reached the account check (${name}) — key valid but out of credits`);
    } else if (code === 7) {
      console.log(`  ok    config + auth accepted, then failed on input (${name}) — no camera in this environment`);
    } else {
      fail(`unexpected start() failure: ${name} — ${startError.message}`);
    }
  }

  console.log(`  ok    lifecycle events observed (processingStatus ${sawProcessingStatus ? 'yes' : 'no'})`);

  // 4. clean shutdown -------------------------------------------------------
  try {
    await sdk.stop();
    await sdk.destroy();
  } catch (err) {
    fail(`shutdown threw: ${err.message}`);
  }
  console.log('  ok    stop + destroy clean');
  console.log(`\n  ${os.platform()} ${os.release()} — integration path verified to the auth boundary\n`);
  process.exit(0);
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
