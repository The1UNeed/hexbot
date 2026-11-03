// Every face on the page moves with the app's own face engine
// (apps/web/src/lib/face-motion.ts), so it blinks, glances, bobs and changes
// mood exactly as it does in Hexbot, and its eyes turn toward the pointer.
// A face moves only while it is on screen, and not at all with reduced
// motion. The one motion the site allows itself.
import type { FaceLook, FaceMood } from '../../../web/src/lib/face-geometry'
import { FaceMotion } from '../../../web/src/lib/face-motion'

const faces = Array.from(document.querySelectorAll<SVGSVGElement>('svg[data-face]'))
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

if (faces.length && !reduced) {
  const motions = new Map<Element, FaceMotion>()
  const timers = new Map<Element, number>()

  for (const svg of faces) {
    const look = (svg.dataset.look as FaceLook | undefined) ?? null
    motions.set(svg, new FaceMotion(svg, { look, mood: svg.dataset.mood as FaceMood }))
  }

  // A face with several moods goes through them in turn while it is on screen.
  const cycle = (svg: SVGSVGElement) => {
    const moods = svg.dataset.moods?.split(',') as FaceMood[] | undefined
    if (!moods || moods.length < 2) return
    let index = 0
    timers.set(svg, window.setInterval(() => {
      index = (index + 1) % moods.length
      motions.get(svg)?.set({ look: (svg.dataset.look as FaceLook | undefined) ?? null, mood: moods[index]! })
    }, 2600))
  }

  const seen = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const svg = entry.target as SVGSVGElement
      const motion = motions.get(svg)
      if (entry.isIntersecting) {
        motion?.start()
        if (!timers.has(svg)) cycle(svg)
      } else {
        motion?.stop()
        clearInterval(timers.get(svg))
        timers.delete(svg)
      }
    }
  })
  for (const svg of faces) seen.observe(svg)

  // The eyes slide toward the pointer and stay inside the face; a face looks
  // straight at a pointer right on it, and further across the farther it is.
  let frame = 0
  const look = (x: number, y: number) => {
    frame = 0
    for (const svg of faces) {
      const box = svg.getBoundingClientRect()
      const dx = x - (box.left + box.width / 2)
      const dy = y - (box.top + box.height / 2)
      const distance = Math.hypot(dx, dy) || 1
      const reach = 10 * Math.min(1, distance / 320)
      motions.get(svg)?.follow({ x: (dx / distance) * reach, y: (dy / distance) * reach })
    }
  }
  addEventListener('pointermove', event => {
    if (frame) return
    frame = requestAnimationFrame(() => look(event.clientX, event.clientY))
  }, { passive: true })
  // Without a pointer on the page, the faces glance around on their own again.
  document.documentElement.addEventListener('pointerleave', () => {
    cancelAnimationFrame(frame)
    frame = 0
    for (const motion of motions.values()) motion.follow(null)
  })
}
