import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'

import type { FaceMood } from './avatar'

/**
 * Little scenes any Hexbot face can play: typing, hammering, juggling,
 * blowing a horn. The brand mark and every bot face wear them the same way:
 * `useAct` picks the act, `ActProps` lays its props over the face. A scene is
 * 170x150 units with the face at (35,40)-(135,140), so props are drawn in
 * plain coordinates around a 100-unit body. Motion comes from the few
 * `hex-a-*` keyframes in tokens.css, tuned per prop with `move`.
 */

type Motion =
  'toss' | 'drop' | 'flash' | 'grow' | 'launch' | 'orbit' | 'rise' | 'shift' | 'spin' | 'swing'

/** Class and timing for one moving prop; `vars` become `--name` properties. */
function move(kind: Motion, t: number, vars: Record<string, number | string> = {}, delay = 0) {
  const style = Object.fromEntries(Object.entries(vars).map(([key, value]) => [`--${key}`, value]))

  return {
    className: `hex-a hex-a-${kind}`,
    style: { ...style, '--t': `${t}s`, animationDelay: `${delay}s` } as CSSProperties
  }
}

/** Hexbot's hands: circles in the body's colour that show up whenever it holds something. */
function Hand({ x, y }: { x: number; y: number }) {
  return <circle className="hex-prop hex-hand" cx={x} cy={y} r="7" />
}

/** `count` copies of a small shape drifting away from (x, y) and fading. */
function Puffs({
  children,
  count = 3,
  dx = 8,
  dy = -34,
  t = 1.6,
  x,
  y
}: {
  children: ReactNode
  count?: number
  dx?: number
  dy?: number
  t?: number
  x: number
  y: number
}) {
  return Array.from({ length: count }, (_, index) => (
    <g key={index} transform={`translate(${x + index * 4} ${y})`}>
      <g {...move('rise', t, { dx: `${dx + index * 5}px`, dy: `${dy}px` }, (-t * index) / count)}>
        {children}
      </g>
    </g>
  ))
}

/** A taped parcel, 36x26, with its top-left corner at (x, y). */
function Parcel({ x, y }: { x: number; y: number }) {
  return (
    <>
      <rect className="hex-prop" height="26" rx="3" width="36" x={x} y={y} />
      <path className="hex-cut" d={`M${x + 15} ${y}h6v9h-6ZM${x + 22} ${y + 17}h9v4h-9Z`} />
    </>
  )
}

const ARROW = <path className="hex-line" d="M0-7V3M-4.5-1.5 0 3.5l4.5-5" strokeWidth="3" />
const NOTE = <path className="hex-prop" d="M4 0v12a3.5 3.5 0 1 1-2-3.2V0l8 2v4l-6-1.5Z" />
const DOT = <circle className="hex-prop" r="2.5" />
const SPARK = <path className="hex-prop" d="M0-5 1.5-1.5 5 0 1.5 1.5 0 5-1.5 1.5-5 0-1.5-1.5Z" />

/** Three rows of keys on the keyboard at (37,122). */
const KEYS = [0, 1, 2].flatMap(row =>
  Array.from({ length: row === 2 ? 5 : 9 - row }, (_, column) => ({
    delay: ((row * 5 + column * 3) % 7) * -0.09,
    width: row === 2 && column === 2 ? 34 : 7,
    x: 43 + row * 4 + (row === 2 ? [0, 9, 18, 54, 63][column]! : column * 9),
    y: 127 + row * 7
  }))
)

interface Act {
  /** Class that moves the body. */
  body: string
  mood: FaceMood
  props: ReactNode
}

export const HEXBOT_ACTS = {
  balloon: {
    body: 'hex-think',
    mood: 'happy',
    props: (
      <g {...move('shift', 2.6, { dy: '-7px' })}>
        <path className="hex-line" d="M136 104q10-20 14-36" strokeWidth="2" />
        <ellipse className="hex-prop" cx="151" cy="50" rx="14" ry="17" />
        <path className="hex-prop" d="m147 67 4-4 4 4Z" />
        <Hand x={136} y={106} />
      </g>
    )
  },
  catch: {
    body: 'hex-catch',
    mood: 'idle',
    props: (
      <>
        <g {...move('drop', 2.4)}>
          <Parcel x={67} y={16} />
        </g>
        <Hand x={62} y={42} />
        <Hand x={108} y={42} />
      </>
    )
  },
  coffee: {
    body: 'hex-lean',
    mood: 'happy',
    props: (
      <>
        <Puffs count={2} dx={2} dy={-24} t={2.2} x={148} y={84}>
          <path className="hex-line" d="M0 0q4-4 0-8t0-8" strokeWidth="2.5" />
        </Puffs>
        <g {...move('shift', 2.8, { dy: '-5px' })}>
          <path className="hex-line" d="M164 100h5a5 5 0 0 1 0 12h-5" />
          <path className="hex-prop" d="M138 92h28v22a6 6 0 0 1-6 6h-16a6 6 0 0 1-6-6Z" />
          <Hand x={138} y={110} />
        </g>
      </>
    )
  },
  dance: {
    body: 'hex-lean',
    mood: 'happy',
    props: (
      <>
        <path className="hex-line" d="M42 88V70a43 43 0 0 1 86 0v18" strokeWidth="5" />
        <rect className="hex-prop" height="26" rx="6" width="14" x="33" y="78" />
        <rect className="hex-prop" height="26" rx="6" width="14" x="123" y="78" />
        <Puffs count={2} dx={10} t={1.4} x={146} y={64}>
          {NOTE}
        </Puffs>
        <Puffs count={2} dx={-14} t={1.4} x={14} y={64}>
          {NOTE}
        </Puffs>
      </>
    )
  },
  download: {
    body: 'hex-think',
    mood: 'idle',
    props: (
      <>
        <path
          className="hex-prop"
          d="M134 44a10 10 0 0 1 1-20 14 14 0 0 1 27-3 11 11 0 0 1 4 23Z"
        />
        <Puffs count={2} dx={-2} dy={34} t={1.3} x={145} y={58}>
          {ARROW}
        </Puffs>
        <g {...move('shift', 0.65, { dy: '3px' })}>
          <Hand x={142} y={112} />
        </g>
      </>
    )
  },
  drum: {
    body: 'hex-tap',
    mood: 'happy',
    props: (
      <>
        <path className="hex-prop" d="M128 124v18a20 7 0 0 0 40 0v-18Z" />
        <ellipse className="hex-prop" cx="148" cy="124" rx="20" ry="7" />
        <ellipse className="hex-cut" cx="148" cy="124" rx="15" ry="4" />
        <g {...move('swing', 0.36, { a: '-22deg', b: '4deg', o: '10% 10%' })}>
          <path className="hex-line" d="m130 96 12 22" />
          <Hand x={130} y={96} />
        </g>
        <g {...move('swing', 0.36, { a: '22deg', b: '-4deg', o: '90% 10%' }, -0.18)}>
          <path className="hex-line" d="m166 96-12 22" />
          <Hand x={166} y={96} />
        </g>
      </>
    )
  },
  fish: {
    body: 'hex-think',
    mood: 'listening',
    props: (
      <>
        <path className="hex-line" d="m134 108 30-62" />
        <Hand x={134} y={108} />
        <path className="hex-line" d="M164 46v70" strokeWidth="1.5" />
        <g {...move('shift', 1.2, { dy: '5px' })}>
          <circle className="hex-prop" cx="164" cy="120" r="5" />
        </g>
        <path className="hex-line" d="M146 132q5-5 9 0t9 0 9 0" strokeWidth="2.5" />
      </>
    )
  },
  flag: {
    body: 'hex-jump',
    mood: 'happy',
    props: (
      <g {...move('swing', 0.9, { a: '-10deg', b: '12deg', o: '10% 100%' })}>
        <path className="hex-line" d="M136 110V40" />
        <path className="hex-prop" d="M137 40q9-7 17 0t16 0v26q-8 7-16 0t-17 0Z" />
        <Hand x={136} y={110} />
      </g>
    )
  },
  grow: {
    body: 'hex-lean',
    mood: 'happy',
    props: (
      <>
        <g {...move('grow', 3.4, { o: '50% 100%' })}>
          <path className="hex-line" d="M155 120V88" />
          <path
            className="hex-prop"
            d="M155 112q-13 0-14-11 13 0 14 11ZM155 104q12-1 13-11-12 0-13 11Z"
          />
          <g transform="translate(155 84) scale(1.9)">{SPARK}</g>
        </g>
        <path className="hex-prop" d="M139 118h32v7h-3l-3 21h-20l-3-21h-3Z" />
        <Hand x={136} y={128} />
      </>
    )
  },
  hammer: {
    body: 'hex-tap',
    mood: 'working',
    props: (
      <>
        <path className="hex-prop" d="M148 128h26v6h-8v8h-10v-8h-8Z" />
        <Puffs dx={8} dy={-18} t={0.6} x={160} y={122}>
          {SPARK}
        </Puffs>
        <g {...move('swing', 0.6, { a: '-20deg', b: '78deg', o: '18% 84%' })}>
          <path className="hex-line" d="m134 112 12-24" strokeWidth="4.5" />
          <rect
            className="hex-prop"
            height="14"
            rx="3"
            transform="rotate(27 147 85)"
            width="26"
            x="134"
            y="78"
          />
          <Hand x={134} y={112} />
        </g>
      </>
    )
  },
  horn: {
    body: 'hex-toot',
    mood: 'happy',
    props: (
      <>
        <g {...move('swing', 1.04, { a: '-4deg', b: '-12deg', o: '0% 50%' })}>
          <path
            className="hex-prop"
            d="M126 98h13c9 0 17-4 23-11a2 2 0 0 1 4 1v27a2 2 0 0 1-4 1c-6-7-14-11-23-11h-13Z"
          />
          <Hand x={140} y={108} />
        </g>
        <Puffs dx={6} dy={-40} x={158} y={70}>
          {NOTE}
        </Puffs>
      </>
    )
  },
  inspect: {
    body: 'hex-lean',
    mood: 'listening',
    props: (
      <g {...move('orbit', 2.8)}>
        <path
          className="hex-line"
          d="m124 100 16 16"
          stroke="var(--hex-background)"
          strokeWidth="11"
        />
        <path className="hex-line" d="m124 100 16 16" strokeWidth="6" />
        <circle className="hex-cut" cx="112" cy="88" r="21" />
        <circle className="hex-line" cx="112" cy="88" r="16" strokeWidth="4.5" />
        <ellipse cx="112" cy="88" fill="currentColor" rx="5" ry="8" />
        <Hand x={142} y={118} />
      </g>
    )
  },
  juggle: {
    body: 'hex-think',
    mood: 'idle',
    props: (
      <>
        {[0, 1, 2].map(index => (
          <g key={index} {...move('shift', 1.5, { dx: '78px' }, -0.5 * index)}>
            <g {...move('toss', 0.75, { dy: '-80px' }, -0.5 * index)}>
              <circle className="hex-prop" cx="46" cy="90" r="5" />
            </g>
          </g>
        ))}
        <g {...move('shift', 0.75, { dy: '5px' })}>
          <Hand x={46} y={102} />
        </g>
        <g {...move('shift', 0.75, { dy: '5px' }, -0.375)}>
          <Hand x={124} y={102} />
        </g>
      </>
    )
  },
  lift: {
    body: 'hex-catch',
    mood: 'working',
    props: (
      <g {...move('shift', 1.3, { dy: '-9px' })}>
        <path className="hex-line" d="M34 34h102" strokeWidth="4.5" />
        <rect className="hex-prop" height="30" rx="4" width="10" x="28" y="19" />
        <rect className="hex-prop" height="22" rx="3" width="7" x="20" y="23" />
        <rect className="hex-prop" height="30" rx="4" width="10" x="132" y="19" />
        <rect className="hex-prop" height="22" rx="3" width="7" x="143" y="23" />
        <Hand x={62} y={36} />
        <Hand x={108} y={36} />
      </g>
    )
  },
  paint: {
    body: 'hex-lean',
    mood: 'happy',
    props: (
      <>
        <path className="hex-line" d="m148 90-7 56M164 90l7 56M156 90v40" strokeWidth="2.5" />
        <rect className="hex-prop" height="42" rx="3" width="34" x="139" y="48" />
        <rect className="hex-cut" height="34" rx="1" width="26" x="143" y="52" />
        <circle cx="162" cy="61" fill="currentColor" r="4" />
        <path d="M143 86v-8l8-10 7 8 4-4 7 8v6Z" fill="currentColor" />
        <g {...move('swing', 0.9, { a: '-7deg', b: '7deg', o: '12% 92%' })}>
          <path className="hex-line" d="m130 112 9-22" />
          <path className="hex-prop" d="m137 92 3-9 6 2-3 9Z" />
          <Hand x={130} y={112} />
        </g>
      </>
    )
  },
  read: {
    body: 'hex-think',
    mood: 'listening',
    props: (
      <>
        <path className="hex-prop" d="M85 124q-16-8-34-4v26q18-4 34 4 16-8 34-4v-26q-18-4-34 4Z" />
        <path className="hex-cut" d="M84 124h2v26h-2Z" />
        <g {...move('flash', 1.8)}>
          <path className="hex-cut" d="M58 128h20v2H58ZM58 134h20v2H58ZM92 128h20v2H92Z" />
        </g>
        <g {...move('flash', 1.8, {}, -0.9)}>
          <path className="hex-cut" d="M58 140h14v2H58ZM92 134h20v2H92ZM92 140h14v2H92Z" />
        </g>
        <Hand x={48} y={138} />
        <Hand x={122} y={138} />
      </>
    )
  },
  rocket: {
    body: 'hex-think',
    mood: 'happy',
    props: (
      <>
        <g {...move('launch', 2.2)}>
          <path
            className="hex-prop"
            d="M152 96c8 8 10 20 8 34h-16c-2-14 0-26 8-34ZM144 122l-7 12h8ZM160 122l7 12h-8Z"
          />
          <circle className="hex-cut" cx="152" cy="113" r="3.5" />
        </g>
        <Puffs dx={-6} dy={14} t={0.7} x={148} y={138}>
          {DOT}
        </Puffs>
      </>
    )
  },
  sweep: {
    body: 'hex-lean',
    mood: 'working',
    props: (
      <>
        <Puffs dx={12} dy={-12} t={0.9} x={156} y={140}>
          {DOT}
        </Puffs>
        <g {...move('swing', 0.9, { a: '-12deg', b: '14deg', o: '10% 0%' })}>
          <path className="hex-line" d="m134 92 14 40" />
          <path className="hex-prop" d="m140 130 16-5 5 17-20 5Z" />
          <Hand x={134} y={92} />
        </g>
      </>
    )
  },
  tinker: {
    body: 'hex-think',
    mood: 'working',
    props: (
      <g {...move('swing', 1.1, { a: '-16deg', b: '20deg', o: '63% 30%' })}>
        {[0, 45, 90, 135].map(angle => (
          <rect
            className="hex-prop"
            height="36"
            key={angle}
            rx="2"
            transform={`rotate(${angle} 156 84)`}
            width="8"
            x="152"
            y="66"
          />
        ))}
        <circle cx="156" cy="84" fill="currentColor" r="13" />
        <path
          className="hex-line"
          d="m156 84-24 34"
          stroke="var(--hex-background)"
          strokeWidth="9"
        />
        <path className="hex-line" d="m156 84-24 34" strokeWidth="5" />
        <circle className="hex-cut" cx="156" cy="84" r="4" />
        <Hand x={132} y={118} />
      </g>
    )
  },
  type: {
    body: 'hex-tap',
    mood: 'working',
    props: (
      <>
        <rect className="hex-prop" height="28" rx="6" width="96" x="37" y="122" />
        {KEYS.map(key => (
          <rect
            key={`${key.x}-${key.y}`}
            {...move('flash', 0.63, {}, key.delay)}
            className="hex-cut hex-a hex-a-flash"
            height="4.5"
            rx="1.5"
            width={key.width}
            x={key.x}
            y={key.y}
          />
        ))}
        <g {...move('shift', 0.28, { dy: '5px' })}>
          <Hand x={62} y={119} />
        </g>
        <g {...move('shift', 0.28, { dy: '5px' }, -0.14)}>
          <Hand x={108} y={119} />
        </g>
      </>
    )
  },
  wand: {
    body: 'hex-lean',
    mood: 'happy',
    props: (
      <>
        <Puffs dx={8} dy={-30} t={1.2} x={152} y={62}>
          {SPARK}
        </Puffs>
        <g {...move('swing', 1.2, { a: '-16deg', b: '20deg', o: '10% 100%' })}>
          <path className="hex-line" d="m134 110 18-36" />
          <g transform="translate(153 71) scale(1.6)">{SPARK}</g>
          <Hand x={134} y={110} />
        </g>
      </>
    )
  }
} satisfies Record<string, Act>

export type HexbotActName = keyof typeof HEXBOT_ACTS

export const HEXBOT_ACT_NAMES = Object.keys(HEXBOT_ACTS) as HexbotActName[]

/** How long a clicked face keeps up its act before going back to normal. */
const CLICK_ACT_MS = 3200

/**
 * The act a face is playing: a random one for a moment after `play()` (wired
 * to a click, the way hover wires the wiggle), otherwise the one it was given.
 */
export function useAct(given?: HexbotActName | null) {
  const [clicked, setClicked] = useState<HexbotActName | null>(null)

  useEffect(() => {
    if (!clicked) {
      return
    }

    const timer = setTimeout(() => setClicked(null), CLICK_ACT_MS)

    return () => clearTimeout(timer)
  }, [clicked])

  const play = () =>
    setClicked(current => {
      const others = HEXBOT_ACT_NAMES.filter(name => name !== current)

      return others[Math.floor(Math.random() * others.length)]!
    })

  const name = clicked ?? given ?? null

  return { act: name ? HEXBOT_ACTS[name] : null, name, play }
}

/**
 * The props of an act, laid over a face without moving anything around it.
 * The parent must be `relative` and exactly the size of the face.
 */
export function ActProps({ color, name }: { color?: string; name: HexbotActName }) {
  return (
    <svg
      aria-hidden
      className="hex-pop-in pointer-events-none absolute top-[-40%] left-[-35%] z-10 h-[150%] w-[170%] max-w-none overflow-visible"
      data-act={name}
      key={name}
      style={{ '--hex-hand': color } as CSSProperties}
      viewBox="0 0 170 150"
    >
      {HEXBOT_ACTS[name].props}
    </svg>
  )
}
