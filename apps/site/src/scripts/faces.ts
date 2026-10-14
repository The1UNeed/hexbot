// Every face on the page looks toward the pointer. Cheap, and the one moment of motion the site allows itself.
const faces = Array.from(document.querySelectorAll<SVGSVGElement>('svg[data-face]'))
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

if (faces.length && !reduced) {
  let frame = 0
  const pupils = faces.map(face => face.querySelector<SVGGElement>('.pupils'))
  const look = (x: number, y: number) => {
    frame = 0
    // Read every box before writing any transform, so the frame lays out once.
    const boxes = faces.map(face => face.getBoundingClientRect())
    boxes.forEach((box, index) => {
      const dx = x - (box.left + box.width / 2)
      const dy = y - (box.top + box.height / 2)
      const distance = Math.hypot(dx, dy) || 1
      const turn = Math.min(1, distance / 320)
      const ux = dx / distance
      const uy = dy / distance
      // The eyes are painted on a ball: they slide toward the pointer, roll with the surface, and shrink as it turns away.
      const eyes = pupils[index]
      if (eyes) eyes.style.transform = `translate(${ux * 16 * turn}px, ${uy * 16 * turn}px) rotate(${ux * 24 * turn}deg) scale(${1 - 0.18 * turn})`
    })
  }
  addEventListener('pointermove', event => {
    if (frame) return
    frame = requestAnimationFrame(() => look(event.clientX, event.clientY))
  }, { passive: true })
}
