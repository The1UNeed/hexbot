# morph-bot

The `<morph-bot>` Web Component from iduu/grokbot-animation
(https://github.com/iduu/grokbot-animation, `component/`, package
`morph-bot-element` 0.6.0, commit 6c27d9640c37e02e1eab0c4f7d98fa01196c66b8),
an unofficial reconstruction of the Grok bot animation on x.ai/bot.

Copied as it is, except:

- `morph-bot.js` and `morph-bot.d.ts`: the dialogue director, its sampled
  voices (`animalese-tts`, `pinyin-pro`) and the speech analyzer are left out,
  with the `performDialogue`, `pauseDialogue`, `resumeDialogue` and
  `stopDialogue` methods and the dialogue exports that needed them.
- `grok-bot-engine.js`: `frame()` returns early while the simulation is
  paused and no step is pending, so a face off screen or held for reduced
  motion does no DOM work. Upstream keeps rendering every frame while paused.
- `grok-bot-engine.js`: the window pointer listeners are added only when the
  face follows the pointer (`follow-pointer` at connect). Upstream adds them
  to every face.
- `grok-bot-engine.js`: destroying an engine clears its particles, trails
  and gradients before a custom element reconnects with the same SVG.
- `runtime/physics-system.js`: reduced motion snaps every spring to its
  target and clears its velocity, so a paused face renders its full pose.
- `runtime/state-behavior-system.js`: a state's `motionScale` also scales
  its impulses and scale pulses, and at 0 the ambient spins, bounces and
  gestures do not start and any already in flight are dropped, so a head
  held for an act stays put. Upstream scales only the head's position and
  tilt.
- The editor, docs, demo and download bundles are left out.

The upstream repository carries no licence file. Its README says that the
geometry and behaviour data in `original-data.js` derive from a publicly
delivered x.ai frontend snapshot and that no open-source licence is granted
for those reference assets. Review that before redistributing a build.

These files are not linted, formatted or type-checked by this repository.
`apps/web/src/lib/face.ts` is the only module that imports them.
