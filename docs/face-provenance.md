# Bot face provenance

Hexbot's faces are its own artwork under the repository's license
(Apache-2.0, see `LICENSE` and `NOTICE`). The eight 100-unit outlines,
palette, and ball placement come from `apps/web/src/lib/avatar-builder.ts`
and now live in `lib/face-geometry.ts`. The eyes are hexagons with softened
corners (`HEX_EYE`), drawn for Hexbot to echo its name and mark. Every
expression is one pose of that hexagon: where it sits, how large it is, how
flat, how it leans, and whether it stands on a point or lies flat.

Faces move through `lib/face-motion.ts`, a small spring engine written for
Hexbot. The head sways, bobs, nods, hops or droops; the eyes blink, glance,
peer and change pose; working eyes turn a sixth of a turn and rest, the two
in opposite directions like meshed gears. Searching, working and happy
faces now and then turn all the way round, with a sweep in tints of their
own colour. A face leaving sleeping throws four-point sparks. Thinking,
writing and loading fold the face into three hexagon dots, a pencil, or a
whirl round a hexagon dot. The kind of motion follows the faces proposed
in #123, which were preferred to the CSS-only faces that replaced them;
none of #123's code, timings, curves, expression shapes, outlines, or data
is used. The springs, schedules, poses, and morph shapes were written and
tuned for Hexbot.

No external face engine, geometry, behaviour dataset, voices, sound samples,
or particle assets are included. Nothing here is taken from xAI's bot, its
Grok products, the Morph Bot reconstruction in iduu/grokbot-animation
(proposed in #123, closed), or Cursor. The earlier faces used upright white
capsule eyes; those were replaced because they resembled xAI's bot.

Sound cues (`lib/sounds.ts`) are synthesised at run time from sine notes,
with no recorded audio. They are off until the user turns on Sounds in
Settings, Appearance.

`node apps/web/scripts/face-rest.mjs` copies the geometry module to mobile,
which draws settled poses without animation. Pass `--check` to verify that
copy. PNGs use the idle pose. The web app still reads hexagon-eye, older
capsule-eye, and older flat-eye PNGs back into a live face: hexagon and
capsule eyes share their centres. Photos remain pictures.

One animation frame loop drives every visible, moving face, writes only the
attributes that changed, and stops when no face moves. Held, offscreen,
hidden-page, and reduced-motion faces do not run; reduced motion draws each
mood's rest pose, morph included. React draws every SVG node at rest, and
the engine moves those same nodes. The existing click acts are CSS and hold
the face at rest while they play.

The site logo, favicon, and desktop and mobile package icons still show the
static mark with capsule eyes. They are raster or Icon Composer artwork,
outside this change; redrawing them with hexagon eyes is a separate step.

The browser verification captures the rendered components in both themes:

![Bot expressions and shapes in the light theme](screens/faces-light.png)
![Bot expressions and shapes in the dark theme](screens/faces-dark.png)
