---
title: Systole — a heartbeat you can play (camera-only instrument with SmartSpectra)
published: false
tags: devchallenge, presagechallenge, javascript, electron
---

*This is a submission for the [Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04)*

<!--
SUBMISSION CHECKLIST — delete this block before publishing
[ ] replace [REPO_URL] and [VIDEO_URL]
[ ] record the demo (see DEMO_SCRIPT.md), upload unlisted/public, paste the link
[ ] upload the agent session at https://dev.to/agent_sessions/new, hit Make Public, embed it
[ ] add a cover image
[ ] confirm the code repo is public and `npm install && npm start` works from a clean clone
-->

## What I Built

**Systole** is a musical instrument that only knows one thing about you: what your body is doing right now.

You sit in front of a webcam, press Start, and it plays. Your **heartbeat is the drummer**. Each systolic upstroke that SmartSpectra finds in the relative arterial pressure waveform fires a kick drum and a ring of light, and the interval between your actual beats *is* the tempo of the piece. Your **breathing opens the orchestra**. As your chest rises, a low-pass filter opens and the pad swells; as you exhale it closes again. Your **HRV picks the mode** (open major pentatonic when you are calmer than your own session baseline, minor pentatonic when you are more charged), your **pulse rate picks the key**, and a **smile adds a bell**.

You sit still, slightly bored, and then the kick drum lands on the beat the SDK just heard in your face. People stop talking when that happens. Then they laugh, their pulse moves, and the music moves with it.

{% embed [VIDEO_URL] %}

## Demo

`[VIDEO_URL]`

The demo is a single unbroken take with the camera preview, the live pulse number and the music all on screen at once, so you can hear the tempo track the reading. Two things worth watching for:

- **0:20–0:45** — the kick drum locks onto the detected beats. The caption under the big tempo readout switches from *"tempo from pulse rate while the waveform settles"* to *"N beats heard in the pressure wave — the kit is on your pulse"*. That is the waveform doing it, not the average.
- **1:10** — I cover the lens for three seconds. The signal quality collapses, the pad closes down and the bells stop, because the app refuses to keep playing to a body it can no longer see. Uncovering brings it back.

## Code

**https://github.com/SarthakPatil18/Systole** — MIT licensed, public, with setup instructions in the README.

```bash
git clone https://github.com/SarthakPatil18/Systole.git systole
cd systole
npm install
npm start            # paste your Presage API key into the consent sheet
npm test             # 18 logic tests + a headless smoke run of the real renderer
```

Stack: Electron + the renderer-side `@smartspectra/node-sdk` binding, esbuild for
the renderer bundle, and hand-written Web Audio and Canvas 2D — no audio library,
no charting library, no UI framework. `npm test` runs the musical mapping and beat
detection against synthetic waveforms, then fakes the DOM/canvas/Web Audio and
executes the *actual* bundled renderer in simulated mode, so the plumbing is
verified on machines with no camera.

## How It Responds to Human Signals

Systole requests `[...breathingMetrics, ...cardioMetrics, MetricType.EXPRESSIONS]`
and uses four of the SDK's signals in genuinely different ways. The integration is
deliberately the boring, recommended one for Electron:

- `main.js` calls `bindSmartSpectraIpc(win)` and points `webPreferences.preload` at
  `@smartspectra/node-sdk/preload`; one SDK instance per window, torn down on close.
- The renderer constructs `SmartSpectraSDK` from `@smartspectra/node-sdk/renderer`,
  so the SDK owns capture and hands back a `MediaStream` via `streamAvailable` for
  the preview. Microphone is never requested.
- Metrics arrive as protobuf on the `metrics` event and are decoded with the SDK's
  own `decodeMetrics` from `@smartspectra/node-sdk/messages`.
- If the plan rejects expression metrics (`kConfigurationFailed` /
  `kMetricNotAuthorized`), the app rebuilds without them and says so instead of
  dying.

**1. Beats, not averages.** The SDK gives a waveform, not beat events, so
`src/signal-engine.js` finds the systolic upstroke itself: a sample has to clear
both the recent mean plus 35% of the swing *and* 72% of the recent peak-to-peak
range, then fall back near the mean before it can re-arm. That amplitude gate is
what stops the **dicrotic notch** being counted as a second heartbeat — the bug
that doubles your tempo. (There's a regression test for exactly that.) The
resulting beat-to-beat intervals go through a 7-sample median, so one bad frame
can't rewrite the groove, and the median interval is the tempo.

**2. Breath as a continuous control.** Chest and abdomen traces are normalised
against an 8-second rolling min/max into a `breathPhase` (0 = exhaled, 1 =
inhaled), smoothed, and mapped to filter cutoff and pad gain. You can hear yourself
breathe within the first two seconds, long before the 30-second breathing-rate
window completes.

**3. HRV relative to you.** Baevsky's stress index is only meaningful against a
personal baseline, so the app builds one from your own session (a slow 2% EMA) and
compares. Crossing +25% of your baseline shifts the mode toward the darker
pentatonic; sitting 15% under it opens up the bright one. Nobody's absolute number
decides anything.

**4. Quality is audible.** A `quality` value from the SDK's own confidence scores
and `validationStatus` controls pad brightness and volume, and suppresses new
notes. Bad light, motion, or no face = a thinner, quieter piece, with the SDK's
validation hint shown as plain language ("Too dark — face a window or a lamp").
The instrument degrades honestly rather than inventing a reading.

Everything is scheduled with Web Audio lookahead scheduling (25 ms tick, 120 ms
ahead) so the music never stutters when a frame is slow, and the audio graph is
built once — retuning, not reallocating — on every chord change.

## Prize Categories

Entering **both** — I think the honest fit is somewhere in between.

**Most Creative or Delightful Use.** A pulse is something you cannot normally
perceive without a device touching you, and music is the one medium where "here
is what your body is doing" needs no explanation. The kick is scheduled from your
beats. The same 90 seconds of demo makes people lean in, go quiet, then start
tapping.

**Best Thoughtful Real-World Use.** What I removed on purpose points at who this
is for. There is **no wearable and no hands** — nothing to strap on, hold, tap or
charge — so the instrument is playable by people who can't grip a controller, can't
wear a watch on their wrist, or find both sensory-hostile, and by anyone who simply
won't wear a heart-rate sensor. It also shows the signal without interpreting it:
no scores, no "stress level", no "you seem anxious", no diagnosis. For someone prone
to over-monitoring their own body, "listen to this and breathe" is a much kinder
interface than a number that judges them. And because the mapping only ever nudges
*between* gentle pentatonic modes, nothing the app detects can produce an alarming
sound — the worst case of a wild reading is slightly odd music, which is the right
failure mode for a wellness toy.

## Consent and Data Handling

Full detail in [PRIVACY.md](PRIVACY.md) in the repo; the summary:

**Consent gate.** Nothing touches the camera until the person has read a plain-language
sheet, ticked an explicit consent checkbox ("my camera will be used to measure my
pulse and breathing while Systole is running") and pressed **Begin**. The tick is
per-session and is not stored — the next launch asks again. `main.js` grants the
camera only for a **video-only** permission request and only from the app's own
bundled `file://` page; audio requests and any non-local origin are denied, and
navigation and popups are blocked so the window can't be steered somewhere else.
macOS's own prompt and camera indicator remain in force, and **Stop** releases the
camera immediately.

**Processing.** Frames go from the renderer to the SmartSpectra SDK in the app's
main process; measurement is on-device. Systole itself records nothing: no video,
no audio, no vitals history, no session log, no analytics, no account, no
identifiers. The API key is held in memory for the session and never written to
disk; it is sent only to Presage's authenticated API.

**Network.** The only traffic Systole causes is the SDK's API-key authentication and
subscription check — no video and no measured values in that request. There is no
cloud service, no LLM call, and no optional AI feature in this app.

**SDK telemetry — reversed default, disclosed.** Presage's SDK telemetry is on by
default; Systole sets `enableTelemetry` from an **unchecked** box on the consent sheet,
so it is off unless the person opts in. If enabled, the SDK sends aggregate
measurement-session summaries (SDK build, platform/device/arch, session shape,
throughput and startup timings, counts of quality warnings, coarse error codes, a
timestamp) and full device-readiness diagnostic reports; **no raw frames and no
measured physiological values**. Those requests are authenticated, so they can be
correlated with an account and should not be called anonymous. Readiness reports live
in Presage's private diagnostic storage with no automatic expiry; deletion follows
Presage's policies. Turning it off means the SDK starts no telemetry session at all.

**Retention and deletion.** There is nothing to retain: quit the app and the session is
gone, no server-side copy of measurements exists, and no files are written. For
Presage-side diagnostic records, contact support@presagetech.com.

**Not a medical device.** Pulse, breathing, HRV and expression signals here are used
for wellness and entertainment. Systole makes no diagnosis or treatment claims, takes
no medical decisions, has no alerting or emergency behaviour, and is not for covert or
non-consensual monitoring — it measures only the person who consented, in front of
their own camera, with a visible indicator, and it never runs hidden or in the
background. The consent sheet and the rail both say so, in the app, not just here.

## Agent Session

<!-- Upload at https://dev.to/agent_sessions/new, Make Public, embed here. -->
<!-- Suggested slice: the beat-detection iteration — the first detector double-counting
     the dicrotic notch, the amplitude gate added to fix it, and the regression test that
     now pins it. That conversation is the most honest bit of engineering in the project. -->
