# The 30-second promo

A Remotion film: v0 → v0.7 in five days, then the app today on desktop and phone. Uses the real app's footage.

1. Record clean footage (no captions): `node scripts/pv/record.mjs desktop --clean` and `… mobile --clean`, from the repo root.
2. Here: copy `build/pv/clean-desktop.mp4`, `clean-mobile.mp4` and `app/src-tauri/icons/icon.png` into `public/`, and take two
   stills for the then/now wipe: `ffmpeg -ss 21 -i clean-desktop.mp4 -frames:v 1 public/now-desktop.png` and
   `ffmpeg -ss 19.5 -i clean-mobile.mp4 -frames:v 1 public/now-phone.png`. If a re-recording moved things, re-pick the
   cut points in `src/cuts.ts` from the `clean-*.json` beat times.
3. `npm install`, `npm run audio` (the synthesized soundtrack), `npm run render`.

`public/v0-chat.png` is v0 (commit d066e72) running its own link, captured once; it stays in git.

Remotion is free for individuals and companies of up to 3 people; see remotion.dev/license.
