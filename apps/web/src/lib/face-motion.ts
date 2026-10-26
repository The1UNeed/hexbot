/**
 * The motion of a live bot face. Springs carry the head, the eyes and the gaze
 * toward what the mood asks for, so a face sways, bobs, hops, nods, blinks,
 * glances and now and then turns all the way round; thinking, writing and
 * loading fold the face into dots, a pencil or a whirl. Written for Hexbot,
 * with no third-party code or data (docs/face-provenance.md).
 *
 * `restFrame` is the still pose React draws; `FaceMotion` moves the same
 * elements from there. One frame loop serves every moving face and stops when
 * none is. Units are the face's 100-unit box; eyes are in the ball frame.
 */

import { EYE_GAP, EYE_MOODS, type FaceLook, type FaceMood } from './face-geometry'

/** What a face folds into for moods that are better shown than worn. */
export type MorphKind = 'dots' | 'pencil' | 'whirl'

export const MORPHS: Partial<Record<FaceMood, MorphKind>> = {
  loading: 'whirl',
  thinking: 'dots',
  writing: 'pencil'
}

export const MORPH_KINDS: readonly MorphKind[] = ['dots', 'pencil', 'whirl']

/** Where the body folds to and the morphs grow from. */
const CORE = { x: 50, y: 52 }

/** The head turns and squashes about the middle of its base. */
const PIVOT = { x: 50, y: 92 }

/** How far apart the thinking dots sit. */
const DOT_GAP = 23

/** Sparks thrown when a face wakes. */
export const SPARKS = 8

interface Eye {
  /** Tilt of the whole eye, applied before its squash. */
  lean: number
  size: number
  squash: number
  /** Turn of the capsule inside the eye; 90 lays it on its side. */
  turn: number
  x: number
  y: number
}

type Expression = readonly [Eye, Eye]

interface Head {
  r: number
  sx: number
  sy: number
  x: number
  y: number
}

const STILL_HEAD: Head = { r: 0, sx: 1, sy: 1, x: 0, y: 0 }

/** Both eyes in one pose; `lean` tips their tops toward each other. */
function pair({
  dx = 0,
  dy = 0,
  lean = 0,
  size,
  squash = 1,
  turn = 0
}: {
  dx?: number
  dy?: number
  lean?: number
  size: number
  squash?: number
  turn?: number
}): Expression {
  const eye = (side: -1 | 1): Eye => ({
    lean: -side * lean,
    size,
    squash,
    turn,
    x: (side * EYE_GAP) / 2 + dx,
    y: dy
  })

  return [eye(-1), eye(1)]
}

/** The still pose of a mood, as still pictures and mobile draw it. */
function rest(mood: FaceMood): Expression {
  return pair(EYE_MOODS[mood])
}

/** One eye peers wide while the other narrows, as if through a lens. */
function peer(side: -1 | 1): Expression {
  const [left, right] = pair({ dy: -2, size: 12.5 })

  return [
    { ...left, size: side < 0 ? 15.5 : 10 },
    { ...right, size: side > 0 ? 15.5 : 10 }
  ]
}

const WIDE = pair({ dy: -1, size: 16.5 })

interface Behaviour {
  blinks: boolean
  /** How far the gaze wanders on its own. */
  glance: number
  hopEvery?: readonly [number, number]
  poseEvery: readonly [number, number]
  poses: readonly Expression[]
  spinEvery?: readonly [number, number]
}

const BEHAVIOUR: Record<FaceMood, Behaviour> = {
  happy: {
    blinks: false,
    glance: 0,
    hopEvery: [1.5, 2.3],
    poseEvery: [1.4, 2.4],
    poses: [rest('happy'), pair({ dy: -3.5, lean: -14, size: 10, squash: 0.6, turn: 90 })],
    spinEvery: [4.5, 7]
  },
  idle: { blinks: true, glance: 5, poseEvery: [4, 4], poses: [rest('idle')] },
  listening: {
    blinks: true,
    glance: 1.5,
    poseEvery: [1.6, 2.8],
    poses: [rest('listening'), pair({ dy: 1, size: 15 })]
  },
  loading: { blinks: false, glance: 0, poseEvery: [4, 4], poses: [rest('loading')] },
  searching: {
    blinks: true,
    glance: 0,
    poseEvery: [0.9, 1.5],
    poses: [rest('searching'), peer(-1), peer(1)],
    spinEvery: [3.5, 6]
  },
  sleeping: { blinks: false, glance: 0, poseEvery: [4, 4], poses: [rest('sleeping')] },
  thinking: { blinks: false, glance: 0, poseEvery: [4, 4], poses: [rest('thinking')] },
  working: {
    blinks: true,
    glance: 2.5,
    poseEvery: [4, 4],
    poses: [rest('working')],
    spinEvery: [6, 10]
  },
  writing: { blinks: false, glance: 0, poseEvery: [4, 4], poses: [rest('writing')] }
}

/** The head's own motion in a mood, before springs and kicks. */
function ambient(mood: FaceMood, t: number, side: number): Head {
  const wave = (speed: number, phase = 0) => Math.sin(speed * t + phase)

  switch (mood) {
    case 'idle':
      return {
        r: 1.8 * wave(0.47) + 0.7 * wave(0.19, 2),
        sx: 1,
        sy: 1 + 0.012 * wave(1.05, 0.6),
        x: 0.8 * wave(0.31),
        y: 1.2 * wave(1.05)
      }

    case 'listening':
      return { r: 6 * side, sx: 1, sy: 1 + 0.015 * wave(1.6), x: side, y: 1.5 + wave(1.6) }

    case 'searching':
      return { r: 3 * side + wave(1.7), sx: 1, sy: 1, x: 2.5 * side, y: -1 + 0.8 * wave(2.1) }

    case 'working':
      return {
        r: 1.4 * wave(1.55),
        sx: 1,
        sy: 1 + 0.025 * Math.cos(6.2 * t),
        x: 0,
        y: -2.2 * Math.abs(wave(3.1))
      }

    case 'happy':
      return { r: 2.5 * wave(1.3), sx: 1, sy: 1, x: 0, y: 0.8 * wave(2) }

    case 'sleeping':
      return {
        r: 5 + 1.2 * wave(0.42),
        sx: 1,
        sy: 1 + 0.018 * wave(0.8),
        x: -1.5,
        y: 5 + 1.6 * wave(0.8)
      }

    default:
      return STILL_HEAD
  }
}

/** Where the head rests in a mood: upright, or nodded off. */
function restHead(mood: FaceMood): Head {
  return mood === 'sleeping' ? { ...STILL_HEAD, r: 5, x: -1.5, y: 5 } : STILL_HEAD
}

const LOOK_TURN = 9

/** A head turned toward the neighbour on `side`. */
function turned(head: Head, side: number): Head {
  return { ...head, r: head.r + LOOK_TURN * side, x: head.x + 3 * side }
}

function lookSide(look?: FaceLook | null): number {
  return look === 'left' ? -1 : look === 'right' ? 1 : 0
}

const round = (value: number) => Math.round(value * 100) / 100

function headTransform({ r, sx, sy, x, y }: Head): string {
  return (
    `translate(${round(PIVOT.x + x)} ${round(PIVOT.y + y)}) rotate(${round(r)}) ` +
    `scale(${round(sx)} ${round(sy)}) translate(${-PIVOT.x} ${-PIVOT.y})`
  )
}

function eyeTransform(eye: Eye, width = 1, open = 1): string {
  return (
    `translate(${round(eye.x)} ${round(eye.y)}) rotate(${round(eye.lean)}) ` +
    `scale(${round(eye.size * width)} ${round(eye.size * eye.squash * open)}) rotate(${round(eye.turn)})`
  )
}

/** Scales a part about the core, where the body folds and the morphs grow. */
export function coreTransform(scale: number): string {
  return `translate(${CORE.x} ${CORE.y}) scale(${round(scale)}) translate(${-CORE.x} ${-CORE.y})`
}

/** How high thinking dot `index` is lifted, from 0 to 1, `since` seconds into the morph. */
export function dotLift(index: number, since: number): number {
  return 0.5 + 0.5 * Math.sin(Math.PI * 2 * (since / 1.1) - index * 0.95)
}

/** A thinking dot at `index`, lifted by `lift` from 0 to 1. */
export function dotTransform(index: number, lift: number): string {
  const x = CORE.x + (index - 1) * DOT_GAP

  return `translate(${x} ${round(CORE.y - 8 * lift)}) scale(${round(8 + 2 * lift)})`
}

export function pencilTransform(t: number): string {
  const x = CORE.x + 5 * Math.sin(Math.PI * 2 * 1.4 * t)
  const y = CORE.y + 2.5 * Math.sin(Math.PI * 2 * 2.8 * t)

  return `translate(${round(x)} ${round(y)}) rotate(${round(28 + 7 * Math.sin(Math.PI * 2 * 1.4 * t + 1))})`
}

/** Three tints of a face colour for its trails, from a cooler hue to a warmer one. */
export function tints(color: string): { color: string; opacity: number }[] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)

  if (!hex) {
    return [0.3, 1, 0.6].map(opacity => ({ color, opacity }))
  }

  const [r, g, b] = hex.slice(1).map(part => parseInt(part, 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const light = (max + min) / 2
  const chroma = max - min
  const saturation = chroma ? chroma / (1 - Math.abs(2 * light - 1)) : 0

  const hue = !chroma
    ? 0
    : max === r
      ? 60 * (((g - b) / chroma + 6) % 6)
      : max === g
        ? 60 * ((b - r) / chroma + 2)
        : 60 * ((r - g) / chroma + 4)

  // Light colours draw darker trails so they still show on a light page.
  const l = Math.round(Math.min(0.62, Math.max(0.4, light)) * 100)
  const s = Math.round(saturation * 100)

  return [-40, 0, 50].map(shift => ({
    color: `hsl(${Math.round((hue + shift + 360) % 360)} ${s}% ${l}%)`,
    opacity: 1
  }))
}

/** Every attribute the engine writes, at rest: what React draws. */
export interface FaceFrame {
  body: string
  bodyShown: boolean
  eyes: [string, string]
  gaze: string
  head: string
  morph: MorphKind | null
  morphScale: string
}

export function restFrame(mood: FaceMood, look?: FaceLook | null): FaceFrame {
  const side = lookSide(look)
  const [left, right] = BEHAVIOUR[mood].poses[0]!
  const morph = MORPHS[mood] ?? null

  return {
    body: coreTransform(morph ? 0 : 1),
    bodyShown: !morph,
    eyes: [eyeTransform(left), eyeTransform(right)],
    gaze: `translate(${4 * side} 0)`,
    head: headTransform(turned(restHead(mood), side)),
    morph,
    morphScale: coreTransform(morph ? 1 : 0)
  }
}

class Spring {
  value: number
  target: number
  velocity = 0
  private readonly stiffness: number
  private readonly damping: number

  constructor(value: number, stiffness: number, damping: number) {
    this.value = value
    this.target = value
    this.stiffness = stiffness
    this.damping = damping
  }

  step(dt: number) {
    const force = this.stiffness * (this.target - this.value) - this.damping * this.velocity
    this.velocity += force * dt
    this.value += this.velocity * dt
  }

  snap() {
    this.value = this.target
    this.velocity = 0
  }
}

type Springs<T> = { [K in keyof T]: Spring }

function springs<T extends object>(start: T, stiffness: number, damping: number): Springs<T> {
  return Object.fromEntries(
    Object.entries(start).map(([key, value]) => [
      key,
      new Spring(value as number, stiffness, damping)
    ])
  ) as Springs<T>
}

function aim<T extends object>(group: Springs<T>, target: T) {
  for (const key in target) {
    group[key].target = target[key] as number
  }
}

function read<T extends object>(group: Springs<T>): T {
  return Object.fromEntries(
    Object.entries(group).map(([key, spring]) => [key, (spring as Spring).value])
  ) as T
}

function each(group: Springs<object>, act: (spring: Spring) => void) {
  for (const spring of Object.values(group)) {
    act(spring as Spring)
  }
}

const between = ([low, high]: readonly [number, number]) => low + Math.random() * (high - low)

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)

const BLINK = 0.17
const SPIN = 0.85
const WAKE = 1
const SPARK_LIFE = 0.8
/** Ball-frame radius the eyes travel round when the face turns. */
const SPIN_RADIUS = 40

/** Draws only what changed since the last frame. */
class Writer {
  private written = new Map<string, string>()

  set(element: Element | null | undefined, name: string, value: string, key: string) {
    if (element && this.written.get(key) !== value) {
      this.written.set(key, value)
      element.setAttribute(name, value)
    }
  }

  /** React drew over some attributes; write them all again. */
  forget() {
    this.written.clear()
  }
}

interface Parts {
  body: SVGGElement | null
  dots: SVGGElement[]
  eyes: SVGGElement[]
  gaze: SVGGElement | null
  head: SVGGElement | null
  morphs: Map<MorphKind, SVGGElement>
  pencil: SVGGElement | null
  sparks: SVGGElement[]
  sparksGroup: SVGGElement | null
  trail: SVGGElement | null
  trailBands: SVGElement[]
  whirl: SVGElement[]
}

function parts(svg: SVGSVGElement): Parts {
  const one = <T extends Element>(name: string) => svg.querySelector<T>(`[data-part="${name}"]`)

  const all = <T extends Element>(name: string) => [
    ...svg.querySelectorAll<T>(`[data-part="${name}"]`)
  ]

  return {
    body: one('body'),
    dots: all('dot'),
    eyes: all('eye'),
    gaze: one('gaze'),
    head: one('head'),
    morphs: new Map(
      all<SVGGElement>('morph').map(element => [element.dataset.morph as MorphKind, element])
    ),
    pencil: one('pencil'),
    sparks: all('spark'),
    sparksGroup: one('sparks'),
    trail: one('trail'),
    trailBands: all('trail-band'),
    whirl: all('whirl')
  }
}

export interface FaceState {
  look?: FaceLook | null
  mood: FaceMood
}

const running = new Set<FaceMotion>()
let frame = 0
let last = 0

function tick(now: number) {
  // Frame times only, so a face's clock is the frame clock; a long gap is one short step.
  const dt = last < 0 ? 0 : Math.min(Math.max((now - last) / 1000, 0), 1 / 15)
  last = now

  for (const face of running) {
    face.advance(dt)
  }

  frame = running.size ? requestAnimationFrame(tick) : 0
}

/** The motion of one face's elements; see the module comment. */
export class FaceMotion {
  private readonly parts: Parts
  private readonly writer = new Writer()
  private state: FaceState
  private t = 0

  private head = springs<Head>(STILL_HEAD, 120, 11)
  private squash = springs({ sx: 1, sy: 1 }, 260, 10)
  private gaze = springs({ x: 0, y: 0 }, 110, 15)
  private eyes: Springs<Eye>[]
  private fold = new Spring(1, 150, 15)

  private side = 1
  private pose = 0
  private nextPose = 0
  private gazeTarget = { x: 0, y: 0 }
  private nextGlance = 0
  private blinkAt = -1
  private nextBlink = 0
  private spinAt = -1
  private nextSpin = Infinity
  private nextHop = Infinity
  private wokeAt = -1
  private morph: MorphKind | null
  private morphAt = 0

  constructor(svg: SVGSVGElement, state: FaceState) {
    this.parts = parts(svg)
    this.state = state
    this.morph = MORPHS[state.mood] ?? null
    this.fold.value = this.fold.target = this.morph ? 0 : 1
    this.eyes = BEHAVIOUR[state.mood].poses[0]!.map(eye => springs(eye, 240, 20))
    this.schedule()
  }

  /** Takes a new mood, look or shape; a face that is not moving settles at once. */
  set(state: FaceState) {
    const before = this.state
    this.state = state
    this.writer.forget()

    if (before.mood !== state.mood) {
      if (before.mood === 'sleeping') {
        this.wokeAt = this.t
        this.head.y.velocity -= 55
        this.squash.sy.velocity += 1.4
      }

      this.pose = 0
      this.spinAt = -1
      this.schedule()
    }

    if (running.has(this)) {
      this.aim()
      this.draw()
    } else {
      this.settle()
    }
  }

  start() {
    if (running.has(this)) {
      return
    }

    running.add(this)

    if (!frame && typeof requestAnimationFrame === 'function') {
      last = -1
      frame = requestAnimationFrame(tick)
    }
  }

  /** Stops moving where it is; `settle` also returns it to rest. */
  stop(settle = false) {
    running.delete(this)

    if (!running.size && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }

    if (settle) {
      this.settle()
    }
  }

  /** Every spring at its target and nothing in flight, drawn. */
  settle() {
    this.wokeAt = -1
    this.spinAt = -1
    this.blinkAt = -1
    this.gazeTarget = { x: 0, y: 0 }
    this.pose = 0
    this.morph = MORPHS[this.state.mood] ?? null
    this.morphAt = this.t
    this.aim(true)
    each(this.head, spring => spring.snap())
    each(this.squash, spring => spring.snap())
    each(this.gaze, spring => spring.snap())
    this.eyes.forEach(eye => each(eye, spring => spring.snap()))
    this.fold.snap()
    this.draw()
  }

  advance(dt: number) {
    this.t += dt
    this.react()
    this.aim()

    for (let left = dt; left > 0; left -= 1 / 120) {
      const step = Math.min(left, 1 / 120)
      each(this.head, spring => spring.step(step))
      each(this.squash, spring => spring.step(step))
      each(this.gaze, spring => spring.step(step))
      this.eyes.forEach(eye => each(eye, spring => spring.step(step)))
      this.fold.step(step)
    }

    this.draw()
  }

  private get behaviour(): Behaviour {
    return BEHAVIOUR[this.state.mood]
  }

  private get waking(): boolean {
    return this.wokeAt >= 0 && this.t - this.wokeAt < WAKE
  }

  private schedule() {
    const { hopEvery, poseEvery, spinEvery } = this.behaviour
    this.nextPose = this.t + between(poseEvery)
    this.nextGlance = this.t + 0.6 + Math.random()
    this.nextBlink = this.t + 1 + Math.random() * 2
    this.nextSpin = spinEvery ? this.t + between(spinEvery) : Infinity
    this.nextHop = hopEvery ? this.t + 0.3 : Infinity
  }

  /** Decides what happens next: a new pose, a glance, a blink, a turn or a hop. */
  private react() {
    const { blinks, glance, hopEvery, poseEvery, poses, spinEvery } = this.behaviour
    const t = this.t

    if (t >= this.nextPose) {
      this.nextPose = t + between(poseEvery)
      this.side = -this.side

      if (poses.length > 1) {
        this.pose =
          this.state.mood === 'searching' ? (this.side < 0 ? 1 : 2) : (this.pose + 1) % poses.length
      }
    }

    if (glance && t >= this.nextGlance) {
      this.nextGlance = t + 0.8 + Math.random() * 2.4
      const angle = Math.random() * Math.PI * 2
      const reach = Math.random() < 0.3 ? 0 : glance * (0.5 + Math.random() / 2)
      this.gazeTarget = { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach * 0.6 }
    }

    if (!glance) {
      this.gazeTarget = { x: 0, y: 0 }
    }

    if (blinks && t >= this.nextBlink && this.spinAt < 0) {
      this.blinkAt = t
      this.nextBlink = t + (Math.random() < 0.2 ? 0.28 : 2.2 + Math.random() * 3.4)
    }

    if (spinEvery && t >= this.nextSpin && !this.waking) {
      this.spinAt = t
      this.nextSpin = t + between(spinEvery)
    }

    if (this.spinAt >= 0 && t - this.spinAt > SPIN) {
      this.spinAt = -1
    }

    if (hopEvery && t >= this.nextHop) {
      this.nextHop = t + between(hopEvery)
      this.head.y.velocity -= 85
      this.squash.sy.velocity += 1.8
      this.head.r.velocity += (Math.random() - 0.5) * 60
    }
  }

  /** Points every spring at where the mood wants it now. */
  private aim(resting = false) {
    const { look, mood } = this.state
    const side = lookSide(look)
    const head = resting ? restHead(mood) : ambient(mood, this.t, this.side)

    aim(this.head, turned(head, side))
    aim(this.squash, { sx: head.sx, sy: head.sy })
    aim(this.gaze, { x: this.gazeTarget.x + 4 * side, y: this.gazeTarget.y })

    const pose = this.waking ? WIDE : (this.behaviour.poses[this.pose] ?? this.behaviour.poses[0]!)
    this.eyes.forEach((eye, index) => aim(eye, pose[index]!))

    // A face folds into a morph while the morph grows out of it; leaving one,
    // the face unfolds first and the next morph, if any, follows.
    const wanted = MORPHS[mood] ?? null

    if (this.morph === null && wanted !== null) {
      this.morph = wanted
      this.morphAt = this.t
    } else if (this.morph !== wanted && this.fold.value > 0.97) {
      this.morph = wanted
      this.morphAt = this.t
    }

    this.fold.target = this.morph !== null && this.morph === wanted ? 0 : 1
  }

  private draw() {
    const { parts, writer } = this
    const t = this.t
    const head = read(this.head)
    const squash = read(this.squash)
    const gaze = read(this.gaze)

    // A turn: the eyes travel round the ball and come back from the other side.
    const spinning = this.spinAt >= 0 ? (t - this.spinAt) / SPIN : -1
    const turn = spinning >= 0 ? easeInOut(Math.min(spinning, 1)) * Math.PI * 2 : 0

    writer.set(
      parts.head,
      'transform',
      headTransform({ ...head, sx: squash.sx * (1 - 0.05 * Math.sin(turn / 2)), sy: squash.sy }),
      'head'
    )
    writer.set(parts.gaze, 'transform', `translate(${round(gaze.x)} ${round(gaze.y)})`, 'gaze')

    const blink = this.blinkAt >= 0 ? (t - this.blinkAt) / BLINK : 1
    const open = blink < 1 ? 1 - 0.88 * Math.sin(Math.PI * blink) : 1

    // Working eyes narrow on each beat, as if concentrating, and open again.
    const beat = (t / 1.2) % 1

    const focus =
      this.state.mood === 'working' && !this.waking && beat < 0.5 ? Math.sin(Math.PI * beat * 2) : 0

    this.eyes.forEach((springsOf, index) => {
      const eye = read(springsOf)
      let width = 1

      if (turn) {
        const home = Math.asin(Math.max(-1, Math.min(1, eye.x / SPIN_RADIUS)))
        const angle = home + turn
        eye.x = SPIN_RADIUS * Math.sin(angle)
        width = Math.max(0, Math.cos(angle)) / Math.cos(home)
      }

      writer.set(
        parts.eyes[index],
        'transform',
        eyeTransform(eye, width, open * (1 - 0.3 * focus)),
        `eye${index}`
      )
    })

    this.drawTrail(spinning)

    const fold = Math.max(0, this.fold.value)
    writer.set(parts.body, 'transform', coreTransform(fold), 'body')
    writer.set(parts.body, 'display', fold < 0.02 ? 'none' : 'inline', 'body-display')

    for (const [kind, element] of parts.morphs) {
      const shown = kind === this.morph && fold < 0.98
      writer.set(element, 'display', shown ? 'inline' : 'none', `morph-${kind}`)

      if (shown) {
        writer.set(element, 'transform', coreTransform(1 - fold), `morph-${kind}-scale`)
      }
    }

    const since = t - this.morphAt

    if (this.morph === 'dots') {
      parts.dots.forEach((dot, index) => {
        const lift = dotLift(index, since)
        writer.set(dot, 'transform', dotTransform(index, lift), `dot${index}`)
        writer.set(dot, 'opacity', String(round(0.45 + 0.55 * lift)), `dot${index}-opacity`)
      })
    }

    if (this.morph === 'pencil') {
      writer.set(parts.pencil, 'transform', pencilTransform(since), 'pencil')
    }

    if (this.morph === 'whirl') {
      parts.whirl.forEach((band, index) => {
        const speed = index ? 0.8 : 1.1
        writer.set(
          band,
          'stroke-dashoffset',
          String(round((since * speed * 110) % 100)),
          `whirl${index}`
        )
      })
    }

    this.drawSparks()
  }

  /** A sweep round the face while it turns, in tints of its colour. */
  private drawTrail(spinning: number) {
    const { parts, writer } = this
    const shown = spinning >= 0 && spinning <= 1
    writer.set(parts.trail, 'display', shown ? 'inline' : 'none', 'trail')

    if (!shown) {
      return
    }

    const progress = easeInOut(spinning)
    writer.set(parts.trail, 'opacity', String(round(Math.sin(Math.PI * spinning))), 'trail-opacity')
    parts.trailBands.forEach((band, index) => {
      writer.set(
        band,
        'stroke-dashoffset',
        String(round(-progress * 100 - 25 + index * 9)),
        `trail${index}`
      )
    })
  }

  private drawSparks() {
    const { parts, writer } = this
    const age = this.wokeAt >= 0 ? this.t - this.wokeAt : SPARK_LIFE
    const shown = age < SPARK_LIFE
    writer.set(parts.sparksGroup, 'display', shown ? 'inline' : 'none', 'sparks')

    if (!shown) {
      return
    }

    parts.sparks.forEach((spark, index) => {
      const angle = (-90 + (index - (SPARKS - 1) / 2) * 26) * (Math.PI / 180)
      const speed = 80 + (index % 2) * 22
      const x = 50 + Math.cos(angle) * speed * age
      const y = 34 + Math.sin(angle) * speed * age + 80 * age * age
      const size = 5 * Math.sin(Math.PI * Math.min(1, (age / SPARK_LIFE) * 1.15 + 0.08))
      writer.set(
        spark,
        'transform',
        `translate(${round(x)} ${round(y)}) scale(${round(size)})`,
        `spark${index}`
      )
    })
  }
}
