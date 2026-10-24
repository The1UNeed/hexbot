# Hexbot face provenance

Hexbot's `<hexbot-face>` Web Component is adapted from **Morph Bot**, the
`<morph-bot>` component in [iduu/grokbot-animation](https://github.com/iduu/grokbot-animation).
The source is `component/`, package `morph-bot-element` 0.6.0, pinned at
[6c27d9640c37e02e1eab0c4f7d98fa01196c66b8](https://github.com/iduu/grokbot-animation/tree/6c27d9640c37e02e1eab0c4f7d98fa01196c66b8).
Upstream describes an independent, unofficial animation study inspired by
x.ai/bot. Hexbot is the product name here; renaming this adaptation does not
change its origin or establish rights to upstream code or reference assets.

## Local patches

- The vendor directory and `morph-bot.js` / `morph-bot.d.ts` are renamed to
  `hexbot-face`; `grok-bot-engine.js` becomes `hexbot-face-engine.js`.
  `MorphBot*`, `MORPH_BOT_*` and `GrokBotEngine` become `HexbotFace*`,
  `HEXBOT_FACE_*` and `HexbotFaceEngine`. The custom element, component IDs,
  size CSS variable, SVG `grok-bot-mark*` classes and engine ID fallbacks use
  `hexbot-face*`. Imports, declarations, selectors and the still-face generator
  follow those names. The default accessible label uses Hexbot.
- `hexbot-face.js` and `hexbot-face.d.ts`: the dialogue director, its sampled
  voices (`animalese-tts`, `pinyin-pro`) and the speech analyzer are left out,
  with the `performDialogue`, `pauseDialogue`, `resumeDialogue` and
  `stopDialogue` methods and the dialogue exports that needed them.
- `hexbot-face-engine.js`: `frame()` returns early while the simulation is
  paused and no step is pending, so a face off screen or held for reduced
  motion does no DOM work. Upstream keeps rendering every frame while paused.
- `hexbot-face-engine.js`: the window pointer listeners are added only when the
  face follows the pointer (`follow-pointer` at connect). Upstream adds them
  to every face.
- `hexbot-face-engine.js`: destroying an engine clears its particles, trails
  and gradients before a custom element reconnects with the same SVG.
- `runtime/physics-system.js`: reduced motion snaps every spring to its
  target and clears its velocity, so a paused face renders its full pose.
- `runtime/state-behavior-system.js`: a state's `motionScale` also scales
  its impulses and scale pulses, and at 0 the ambient spins, bounces and
  gestures do not start and any already in flight are dropped, so a head
  held for an act stays put. Upstream scales only the head's position and
  tilt.
- The editor, docs, demo and download bundles are left out.

## License evidence

Checked on 2026-10-22. Upstream `main` still resolves to the pinned commit
above. The tracked tree contains no project or component license file, and
neither the root nor component `package.json` declares a license. No license
grant was found in the copied engine/runtime source or component guide.
Public source availability alone does not document an open-source grant.

The upstream [README, Status and disclaimer](https://github.com/iduu/grokbot-animation/blob/6c27d9640c37e02e1eab0c4f7d98fa01196c66b8/README.md#status-and-disclaimer)
says the geometry and behavioral data derive from a publicly delivered frontend
snapshot. It explicitly says, "No open-source license is granted for third-party
reference assets by this README." `original-data.js` retains its original x.ai
geometry-source comment. [ANALYSIS.md](https://github.com/iduu/grokbot-animation/blob/6c27d9640c37e02e1eab0c4f7d98fa01196c66b8/ANALYSIS.md)
identifies x.ai/bot as the investigated reference. Neither documents a grant
for those assets. This also affects the generated web and mobile still faces.

The only tracked upstream `LICENSE` / `NOTICE.md` files are under
`component/runtime/vendor/animalese-tts/` and `component/runtime/vendor/pinyin-pro/`.
They document MIT licenses for those speech dependencies, which this adaptation
omits. They do not license the copied face engine or reference-derived data.
The README also credits [Open Props](https://github.com/argyleink/open-props/blob/main/LICENSE)
and [WebGradients](https://github.com/itmeo/webgradients/blob/master/LICENSE) for
the material preset format. Both reference projects document MIT licenses. The
README describes the palettes and layered glass as upstream additions. Those
reference licenses do not establish a license for Morph Bot's implementation.

The missing grant for the engine and the missing permission for reference-derived
data remain unresolved. Hexbot's own license does not supply those grants. Keep
this evidence and source credit when reviewing redistribution; no ownership or
license for the copied files is asserted here.

These files are not linted, formatted or type-checked by this repository.
`apps/web/src/lib/face.ts` loads the component; `apps/web/scripts/face-rest.mjs`
also imports its data and renderer to generate web and mobile still faces.
