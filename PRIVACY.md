# Privacy, consent and data handling

This file describes exactly what Systole does with your camera, your signals and
your data. It is written to match the code in this repository; if they ever
disagree, the code is the bug.

## What Systole asks for, and when

Systole does nothing with the camera until you have:

1. read the consent sheet, and
2. ticked **"I understand and consent to my camera being used to measure my pulse
   and breathing while Systole is running"**, and
3. pressed **Begin**.

The consent tick is per session. Nothing about it is stored. Closing the window
ends the session; the next launch asks again.

macOS shows its own camera permission prompt the first time, and the green camera
indicator stays lit for as long as capture is running. **Stop** releases the
camera immediately.

The microphone is never requested. Electron's permission handler in `main.js`
grants a request only when it is video-only and only from the bundled page;
audio requests are denied.

## What happens to video

Video frames are read inside this app's renderer, passed to the SmartSpectra SDK
running in the app's main process, and turned into metrics on your machine.

- Systole itself writes no video to disk, and no frame leaves your device.
- The camera preview in the left rail is the same live stream, drawn to a
  `<video>` element. It exists only while the app is running.
- Turning the preview off is not currently a separate control — press **Stop** and
  capture and processing both stop.

## What is stored

**Nothing.** Systole writes no files: no video, no audio, no vitals history, no
session log, no usage analytics, no account, no identifiers. The API key you
paste lives in memory for the session; it is never written to disk and never sent
anywhere except to Presage's authenticated API when the SDK starts.

The only persistence is whatever the operating system does on its own (Electron's
own cache directories). Deleting the app and its Application Support folder
removes all of it.

## What is sent over the network

One thing: **SDK authentication**. When a session starts, the SmartSpectra SDK
authenticates your API key and validates the subscription with Presage's servers
over a TLS-pinned, authenticated channel. That request contains credential and
subscription information, not your video and not your measured values.

The music, the visuals and the beat detection are all local. There is no cloud
service, no AI API, no LLM call, no analytics endpoint in this app.

## SDK telemetry — off unless you opt in

Presage's SmartSpectra SDK has an opt-out telemetry feature that is **on by
default** in the SDK. Systole deliberately reverses that default: the consent
sheet has an unchecked box, **"Share aggregate SDK diagnostics with Presage"**,
and the SDK is constructed with `enableTelemetry` set to whatever that box says.
Leave it unchecked and the SDK starts no telemetry session and transmits nothing.

If you do tick it, Presage's
[telemetry documentation](https://smartspectra.presagetech.com/docs/telemetry-and-privacy)
says the following is sent:

- **Session summaries**: SDK build and package origin; platform, OS version,
  device model, CPU architecture, binding; session shape (camera / video file /
  custom input, outcome, number of metrics requested); performance counters (frame
  throughput, input frame-rate statistics, startup latency, produced-metric
  counts); counts of on-device validation states such as lighting or motion
  warnings; a coarse error code for a failed session; and a wall-clock timestamp.
- **Device readiness reports**, if a readiness check runs: verdict and reason,
  device and SDK identification, requested metrics, input dimensions and frame
  rate, camera selection information, throughput/resource checks and thresholds,
  and free-text diagnostic messages that may contain paths or platform errors.

What is *not* included: raw video frames and measured physiological values.
Requests use SDK account authentication and device-authentication headers, so
although no account ID is added as a report field, requests can be correlated
with your account — this collection should not be described as anonymous.
Presage keeps readiness reports in private diagnostic storage with no automatic
expiry configured; deletion is governed by their policies. See Presage's
[privacy policy](https://api.physiology.presagetech.com/privacypolicy).

Systole's own code sends nothing extra on top of that.

## Third parties

- **Presage Technologies** — the SmartSpectra SDK: on-device measurement,
  API-key authentication, and the telemetry described above if you opt in.
- No analytics, no crash reporting, no ads, no data brokers. The app loads no
  remote content, and `main.js` blocks navigation and popups so it cannot be
  steered into any.

## Erasure

Stop the session, quit the app: in-memory data is gone. There is no server-side
copy of your measurements to delete because none was ever created. If you opted
into telemetry and want Presage to remove diagnostic records associated with your
API key, contact <support@presagetech.com>.

## Limits on what this app will do

Systole is an instrument for wellness and entertainment. On purpose, it:

- makes **no diagnosis or treatment claims** and gives no medical advice;
- makes **no medical decisions** and has no alerting or emergency behaviour;
- only measures people who have consented, in front of their own camera — it is
  not for monitoring anyone else, and it never runs hidden (no background mode, no
  autostart, no silent capture);
- shows signal-quality guidance rather than hiding it, and thins out the music
  rather than pretending to read you when the camera can't.
