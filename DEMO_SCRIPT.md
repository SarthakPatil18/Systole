# Demo video script — 90 seconds

The judges verify SDK use from the video, so the video has to *prove* that the
music is following the live signal. That means one unbroken take where the
camera preview, the pulse number and the music are visible at the same time, plus
one moment where you make the signal fail and the music responds.

## Before you record

**Set the scene (5 min, and it decides whether this works at all)**

- Sit facing a window or a lamp. **Light your face from the front**, not from
  behind — a bright window behind you is the classic way to get `kTooDark`.
- Camera at eye level, about an arm's length away. Your **face and upper chest**
  in frame (breathing rate needs the chest; pulse needs the face).
- Prop the laptop/phone. Handheld = `kExcessiveMotion` and no breathing trace.
- Plain shirt, ideally not black, no fine stripes.
- Quiet room. The soundtrack is the app, so no music under it — or a whisper-quiet
  room tone at most.
- Have the API key on the clipboard, and use the same key you'll give the judges.

**Get a clean session first**

1. Launch, consent, **Begin**, **Start**.
2. Sit absolutely still and breathe normally for **60 seconds** before recording.
   You need ~12 s for the first pulse reading, ~30 s for breathing rate, and 60 s
   for HRV — the app is fully alive by then, and the baseline is established.

**Recording**

- Screen recording at 60 fps, plus system audio (macOS: QuickTime → New Screen
  Recording → click the arrow → select the internal microphone for narration, or
  record narration separately and lay it under the video).
- Record the whole app window, not a crop — the rails *are* the evidence.
- Keep the big tempo readout and the pulse readout in shot the whole time.

## Shot list

| Time | On screen | Do / say |
| --- | --- | --- |
| 0:00–0:06 | App idle, consent sheet visible | "This is a camera. Nothing else." Scroll the consent sheet slowly enough to read the four facts. Tick consent, press Begin. |
| 0:06–0:14 | Camera preview comes up, validation hint green | Let them hear you grant camera access on macOS. "It measures pulse and breathing from the video — on this machine." |
| 0:14–0:20 | Press Start. Preview + rails. | Sit still. Say nothing for a beat. The pad fades in as the breath trace arrives. |
| 0:20–0:34 | Tempo readout, pulse readout, caption | "First the tempo comes from the pulse rate. Watch this caption." Wait for it to flip to *"N beats heard in the pressure wave"*. "There — that's the arterial pressure waveform, and the kick is on my actual heartbeat now." Tap a finger against the tempo for two seconds so the sync is audible. |
| 0:34–0:46 | Breathe deliberately | Take two slow, deep breaths. "When I inhale, the filter opens; when I exhale it closes. That's the chest and abdomen traces, not the breathing rate." |
| 0:46–0:58 | Mode readout in right rail | "This one is HRV — Baevsky's index compared to my own baseline from the last minute, not an absolute number. It's choosing the mode: bright pentatonic when I'm under baseline, darker when I'm over." |
| 0:58–1:08 | Smile broadly at the camera | "Expression is optional — a smile raises the chance of a bell." Smile, wait for a bell. Do it twice if the first is missed. |
| 1:08–1:16 | Cover the lens with your hand | Everything thins out. "Signal gone — quality collapses, the pad closes, the bells stop. It won't play to a body it can't see." Uncover. It comes back. |
| 1:16–1:24 | Both rails visible | "Requests breathing, cardio and expression metrics. On-device measurement, nothing recorded, nothing uploaded, telemetry off unless you tick it. The only network call is the API key check." |
| 1:24–1:30 | Press Stop, camera indicator goes dark | "Stop releases the camera." End on the app idle, or on a card with the repo URL. |

## After recording

- Check the audio: the kick drum must be audible against the pad. If the pad
  buries it, re-record with the **Tide** voice (sparser) or drop the volume slider
  to ~60.
- Trim the first dead seconds. Keep the take unbroken from 0:14.
- Upload unlisted or public (YouTube, Vimeo, or a file link that judges can open
  without logging in) and put the link in the **Demo** section of the DEV post.
- Optional but strong: overlay a small caption at 0:20 and 1:08 — "kick drum = detected heartbeats" / "signal lost". Judges skim.

## Things not to do

- Don't use the **simulated** mode in the demo. It is a development aid; using it
  would misrepresent the integration.
- Don't speed up or splice the middle. The claim is "real time", so the video has
  to be real time.
- Don't claim anything medical. No "this lowers your stress" — the honest, and more
  interesting, claim is "you can hear what your body is doing".
