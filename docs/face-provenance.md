# Bot face provenance

Hexbot's faces are its own artwork under the repository's license
(Apache-2.0, see `LICENSE` and `NOTICE`). The eight 100-unit outlines,
palette, and ball placement come from `apps/web/src/lib/avatar-builder.ts`
and now live in `lib/face-geometry.ts`. The eyes are the upright capsules of
the Hexbot icon (`CAPSULE_EYE`; at the idle size, the icon's 11.7 by 27
eye). Every expression is one pose of that capsule: where it sits, how large
it is, how flat, how it leans, and whether it stands or lies on its side.

Faces move through `lib/face-motion.ts`, a small spring engine written for
Hexbot. The head sways, bobs, nods, hops or droops; the eyes blink, glance,
peer and change pose; working eyes narrow on a steady beat, as if
concentrating. Searching, working and happy
faces now and then turn all the way round, with a sweep in tints of their
own colour. A face leaving sleeping throws four-point sparks. Thinking,
writing and loading fold the face into three round dots, a pencil, or a
whirl round a dot. Ten emotions (curious, surprised, shy, confused,
frustrated, sad, proud, celebrating, bored, drowsy) are further poses and
motions of the same capsules, and `lib/emotions.ts` decides them from the
conversation with rules written for Hexbot. The kind of motion follows the
faces proposed in #123, which were preferred to the CSS-only faces that replaced them;
none of #123's code, timings, curves, expression shapes, outlines, or data
is used. The springs, schedules, poses, and morph shapes were written and
tuned for Hexbot.

No external face engine, geometry, behaviour dataset, voices, sound samples,
or particle assets are included. Nothing here is taken from xAI's bot, its
Grok products, the Morph Bot reconstruction in iduu/grokbot-animation
(proposed in #123, closed), or Cursor. The capsule eyes are the ones
Hexbot's icon and faces already had, with Hexbot's own proportions, spacing,
and poses; they are not #123's eye outlines or poses.

Sound cues (`lib/sounds.ts`) are synthesised at run time from sine notes,
with no recorded audio. They are off until the user turns on Sounds in
Settings, Appearance.

`node apps/web/scripts/face-rest.mjs` copies the geometry module to mobile,
which draws settled poses without animation. Pass `--check` to verify that
copy. PNGs use the idle pose. The web app still reads capsule-eye and older
flat-eye PNGs back into a live face. Photos remain pictures.

One animation frame loop drives every visible, moving face, writes only the
attributes that changed, and stops when no face moves. Held, offscreen,
hidden-page, and reduced-motion faces do not run; reduced motion draws each
mood's rest pose, morph included. React draws every SVG node at rest, and
the engine moves those same nodes. The existing click acts are CSS and hold
the face at rest while they play.

The site logo, favicon, and desktop and mobile package icons show the same
capsule eyes as the faces.

The browser verification captures the rendered components in both themes:

![Bot expressions and shapes in the light theme](screens/faces-light.png)
![Bot expressions and shapes in the dark theme](screens/faces-dark.png)
