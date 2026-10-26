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
      // The eyes slide a little toward the pointer and stay inside the face.
      const eyes = pupils[index]
      if (eyes) eyes.style.transform = `translate(${ux * 10 * turn}px, ${uy * 10 * turn}px)`
    })
  }
  addEventListener('pointermove', event => {
    if (frame) return
    frame = requestAnimationFrame(() => look(event.clientX, event.clientY))
  }, { passive: true })
}
