# Bot face provenance

The live faces use Hexbot's own eight 100-unit outlines, palette, ball
placement, and capsule eyes from `apps/web/src/lib/avatar-builder.ts` on
`main` at `e44f26c8`. They are now in `lib/face-geometry.ts`, under the
repository's existing AGPL-3.0 licence, as recorded in `LICENSE` and
`NOTICE`. New activity expressions change capsule sizes and positions. CSS moves the eyes slightly while a bot thinks,
searches, writes, or works. No external face engine, geometry, behaviour
dataset, voices, or particle assets are included.

This replaces the proposal in PR #123. That proposal included an unlicensed
reconstruction and data derived from an x.ai frontend snapshot. Neither is
used here, and this document makes no claim to rights in that material.
Starting from current main keeps that vendor tree and its generated rest
poses out of both the branch history and the shipped bundle.

`node apps/web/scripts/face-rest.mjs` copies the original geometry module to
mobile, which draws settled poses without animation. Pass `--check` to
verify that copy. PNGs use the original idle pose and format. The web app
still reads both the current capsule-eye PNGs and older flat-eye PNGs back
into a live face. Photos remain pictures.

Idle, listening, happy, sleeping, held, offscreen, and reduced-motion faces
have no continuous face animation. React owns every SVG node, including the
existing click acts. Visibility observers and act timers disconnect on
unmount. There are no face animation frame callbacks, springs, custom
elements, or detached particle layers.

The site logo, favicon, and desktop package icons intentionally keep the
original static Hexbot mark. The in-app mark keeps the same outline and
colours and changes its eyes with activity. Saved avatar pictures are also
intentionally static.

The browser verification captures the rendered components in both themes:

![Original bot expressions and shapes in the light theme](screens/original-faces-light.png)
![Original bot expressions and shapes in the dark theme](screens/original-faces-dark.png)
