import type { ReactNode } from 'react'

import type { InstallOption } from './api'

/**
 * One small diagram per option, in one grammar: a laptop is the app, the
 * hexagon is the daemon, and whatever sits on another computer is faded.
 */

const HEX =
  'M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z'

function Daemon({ size, x, y }: { size: number; x: number; y: number }) {
  return (
    <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 100})`}>
      <path d={HEX} fill="currentColor" />
      <rect fill="var(--hex-background)" height="34.8" rx="7.75" width="15.5" x="24.3" y="32.7" />
      <rect fill="var(--hex-background)" height="34.8" rx="7.75" width="15.5" x="60.2" y="32.7" />
    </g>
  )
}

function Laptop({ children, x }: { children?: ReactNode; x: number }) {
  return (
    <g>
      <rect
        fill="none"
        height="30"
        rx="4"
        stroke="currentColor"
        strokeWidth="2"
        width="44"
        x={x}
        y="11"
      />
      <path d={`M${x - 5} 46h54`} stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
      {children}
    </g>
  )
}

function Server({ children, x }: { children?: ReactNode; x: number }) {
  return (
    <g>
      <rect
        fill="none"
        height="38"
        rx="6"
        stroke="currentColor"
        strokeWidth="2"
        width="32"
        x={x}
        y="8"
      />
      <path d={`M${x + 8} 38h16`} stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      {children}
    </g>
  )
}

function Link({ from, to }: { from: number; to: number }) {
  return (
    <path
      d={`M${from} 27H${to}`}
      opacity="0.5"
      stroke="currentColor"
      strokeDasharray="1 4"
      strokeLinecap="round"
      strokeWidth="2"
    />
  )
}

function WindowLines({ x }: { x: number }) {
  return (
    <path
      d={`M${x + 9} 21h18M${x + 9} 27h26M${x + 9} 33h12`}
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    />
  )
}

export function OptionIllustration({ option }: { option: InstallOption }) {
  return (
    <svg aria-hidden className="h-[52px] w-[120px] text-foreground" viewBox="0 0 120 52">
      {option === 'full' ? (
        <Laptop x={38}>
          <Daemon size={18} x={60} y={26} />
        </Laptop>
      ) : option === 'client' ? (
        <>
          <Laptop x={8}>
            <WindowLines x={8} />
          </Laptop>
          <Link from={62} to={76} />
          <g opacity="0.4">
            <Server x={82}>
              <Daemon size={16} x={98} y={23} />
            </Server>
          </g>
        </>
      ) : (
        <>
          <Server x={6}>
            <Daemon size={16} x={22} y={23} />
          </Server>
          <Link from={46} to={60} />
          <g opacity="0.4">
            <Laptop x={70}>
              <WindowLines x={70} />
            </Laptop>
          </g>
        </>
      )}
    </svg>
  )
}
