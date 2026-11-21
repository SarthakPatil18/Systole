# Systole

**A heartbeat you can play.** A camera-only musical instrument: your pulse plays
the drums, your breath opens the orchestra, and the app is built on the
[Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs).

No wearable, no controller, no microphone. You sit in front of a webcam, press
Start, and a generative piece of music starts keeping time with your heart.

```
webcam ──► SmartSpectra SDK ──► SignalEngine ──► AudioEngine ──► speakers
                  │                    │
                  │                    └────────► Visuals ──► canvas
                  └── pulse, breathing, HRV, waveform, expressions
```

---

## What responds to what

| SmartSpectra signal | What it does in the instrument |
| --- | --- |
| **Relative arterial pressure trace** | Beat detection on the waveform fires the kick drum and a shockwave ring. The interval between detected beats *is* the tempo. |
| **Pulse rate** | Sets the musical key, and covers tempo while the waveform is still settling. |
| **Breathing rate + chest/abdomen traces** | Breath position opens the pad's low-pass filter and lifts its volume, so you hear yourself breathe. |
| **HRV (Baevsky index)** | Read *relative to your own session baseline* to choose the musical mode: calmer than your baseline → open major pentatonic; more charged → minor pentatonic. |
| **Expressions** | A smile or look of surprise raises the chance of a bell ornament. Flat or downcast expressions leave the room quiet. Optional — the app runs without it if the plan doesn't include face metrics. |
| **Validation status** | Lighting / motion / framing problems visibly and audibly thin the music out instead of faking a reading. |

Deliberate design choice: the UI never tells you what you are feeling. It shows
pulse, breathing, signal quality and the musical mode. That's it.

---

## Requirements

| | |
| --- | --- |
| OS | macOS 14+ on Apple Silicon, Windows 10/11 x64, or Linux x64/arm64 with glibc 2.35+ |
| Node.js | 20 or newer (24 LTS recommended) |
| API key | Free from <https://physiology.presagetech.com/auth/register> |
| Camera | Any webcam. A stand or laptop lid beats a handheld phone |

macOS notes: you need Xcode Command Line Tools for the Electron toolchain
(`xcode-select --install`). The SmartSpectra **C++** SDK additionally requires an
Apple Development signing identity — that requirement does **not** apply to this
Node/Electron binding, which loads the SDK through the FFI package.

---

## Run it

```bash
git clone https://github.com/SarthakPatil18/Systole.git systole
cd systole
npm install          # pulls @smartspectra/node-sdk + its per-platform native runtime
npm start
```

Then, in the window:

1. Paste your Presage API key. (It is held in memory for the session only — see
   [PRIVACY.md](PRIVACY.md).)
2. Read the consent sheet and tick the consent box.
3. Press **Begin**.
4. Allow camera access when macOS asks. Sit about an arm's length away, face and
   upper chest in frame, decent light, and stay fairly still.
5. Press **Start**. Give it ~12 s for the first pulse reading and ~30 s before the
   first breathing-rate number appears (that's the SDK's window, not lag).

Optional convenience for demos and CI — pre-fills the key field without touching
the UI:

```bash
SMARTSPECTRA_API_KEY=your_key_here npm start
```

Optional: **Try it without a camera** on the consent sheet runs the whole
instrument on *simulated* signals, so you can explore the UI before granting
camera access. The window is badged **SIMULATED** the entire time. It is a
development aid, not a measurement.

### Try it without a Mac

Everything except the camera path is testable anywhere:

```bash
npm test        # 18 logic tests + a headless smoke run of the real renderer
```

The smoke run fakes the DOM, canvas and Web Audio, then executes the *actual*
bundled renderer in simulated mode and asserts that tempo, pulse, quality and
mode come out the other end.

---

## Voices

- **Ember** — warm triangle pad, low reverb, soft hats.
- **Tide** — sine pad, long reverb, sparse percussion.
- **Glass** — saw pad, high Q, glassy bells.

Volume and mute live in the right rail. Muting leaves the visuals running, which
is the nicer way to demo in a quiet room.

---

## How the SDK is integrated

This app uses the **renderer-side** SmartSpectra binding, which is the
recommended path for Electron:

- `main.js` calls `bindSmartSpectraIpc(win)` from
  `@smartspectra/node-sdk/main` and points `webPreferences.preload` at
  `@smartspectra/node-sdk/preload`. One SDK instance per window, torn down
  automatically on close.
- The renderer imports `SmartSpectraSDK` from `@smartspectra/node-sdk/renderer`,
  so the SDK owns camera capture and emits `streamAvailable` with a `MediaStream`
  the app attaches to a `<video>` for the preview.
- Metrics arrive as protobuf packets on the `metrics` event and are decoded with
  `decodeMetrics` from `@smartspectra/node-sdk/messages` — the decoder the SDK
  itself ships, so there is no `pbjs` step in this repo.
- Requested metrics: `[...breathingMetrics, ...cardioMetrics, MetricType.EXPRESSIONS]`.
  If the account's plan rejects expression metrics, the app notices
  (`kConfigurationFailed` / `kMetricNotAuthorized`), rebuilds the SDK without
  them and keeps going.
- Camera permission is granted by Electron's permission handler **only** for a
  video-only request **only** from the bundled `file://` page; anything else is
  denied.
- macOS entitlements (`build/entitlements.mac.plist`) and
  `NSCameraUsageDescription` are set for packaged builds.

Key files:

| File | Job |
| --- | --- |
| `main.js` | Window, IPC bridge, camera permission, packaged native-library path |
| `src/renderer.js` | Consent gate, SDK lifecycle, wiring, UI |
| `src/signal-engine.js` | Metrics → smoothed snapshot + beat detection (pure, tested) |
| `src/mapping.js` | Signal → musical decisions (pure, tested) |
| `src/audio-engine.js` | Web Audio synth and scheduler |
| `src/visuals.js` | Canvas stage |
| `src/simulator.js` | Synthetic signals for the no-camera mode |
| `test/` | Logic tests + headless smoke harness |

---

## Packaging

```bash
npm run dist:mac     # → dist/Systole-*.dmg (arm64)
npm run dist:win
npm run dist:linux
```

The native runtime closure is copied out of `app.asar` into
`resources/smartspectra/` (a `.dylib` can't be loaded from inside an asar), and
`main.js` points `SMARTSPECTRA_CAPI_PATH` at it before the binding loads.

For distribution you will want to set `CSC_LINK` / `CSC_KEY_PASSWORD` and your
own `appId` / team ID. The bundled SmartSpectra dylibs are ad-hoc signed; the
entitlements file grants `com.apple.security.cs.disable-library-validation` so
the hardened runtime will load them. The stricter alternative is re-signing each
dylib with your identity before packaging.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| App exits immediately in a VS Code terminal | VS Code exports `ELECTRON_RUN_AS_NODE=1`. Run `env -u ELECTRON_RUN_AS_NODE npm start` or use another terminal. |
| "Presage rejected the API key" | Re-copy the key from the portal; watch for trailing whitespace. |
| "Out of credits" | The challenge runs on Presage's free trial; ask in the Presage Discord. |
| No camera prompt on macOS | System Settings → Privacy & Security → Camera, enable the app (or Electron during `npm start`), then relaunch. |
| Breathing rate stays `—` | It needs a 30 s window with your **chest** in frame and no talking. Pulse appears first. |
| Tempo looks wrong | Beat detection needs a visible face and steady light; until it locks, tempo falls back to the SDK's pulse rate. |
| Expression metrics note | Your plan may not include face metrics. Pulse + breathing continue normally. |
| Linux: `GLIBC_2.35 not found` | The native runtime is built on Ubuntu 22.04; use that or newer. |

Logs: `SYSTOLE_DIAGNOSTICS=1 npm start` opens DevTools; SDK verbosity can be
raised with the `logLevel` constructor option.

---

## Privacy and consent

Short version: frames are processed on your device, nothing is recorded, nothing
is uploaded, and the only network call is the SDK authenticating your API key.
SDK diagnostics are **off** unless you tick the box. Full detail, including what
Presage's SDK telemetry would contain if you enable it and how to erase
everything: [PRIVACY.md](PRIVACY.md).

## Not a medical device

Pulse, breathing, HRV and expression signals are used for wellness and
entertainment only. Systole does not diagnose, treat, monitor or predict any
condition, and it must not be used for medical decisions. SmartSpectra's metrics
are not FDA-cleared.

## License

MIT — see [LICENSE](LICENSE). The SmartSpectra SDK itself is proprietary and
governed by Presage's own terms.
