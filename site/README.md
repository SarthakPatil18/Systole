# Landing page

Static page for the public URL. It describes the app, it does not run it —
Systole is an Electron desktop app with a native SDK, so it cannot be hosted.

Deploy (either way works):

1. **Vercel dashboard** — Project Settings → Root Directory = `site`,
   Framework Preset = `Other`, no build command. Nothing installs, nothing builds.
2. **From the repo root** — the committed `vercel.json` sets `outputDirectory`
   to `site` and overrides install/build, so a plain `vercel --prod` works too.

Keep the app's Electron dependencies out of this deploy: they are ~350 MB of
native runtimes that a static page has no use for.
