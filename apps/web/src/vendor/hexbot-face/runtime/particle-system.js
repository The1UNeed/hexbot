import { HEAD_C, STAR_GOLD, STAR_PATH } from "../original-data.js";

const COLORS = ["#f9705c", "#5b95f0", "#3fbe86", "#f5b13f", "#9a72ee", "#35c3bd"];
const SVG_NS = "http://www.w3.org/2000/svg";
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const random = (min, max) => min + Math.random() * (max - min);

export class ParticleSystem {
  constructor(back, front, { idPrefix, reduceMotion, radius }) {
    this.back = back;
    this.front = front;
    this.idPrefix = idPrefix;
    this.reduceMotion = reduceMotion;
    this.radius = radius;
    this.particles = [];
    this.spinAngle = random(0, Math.PI * 2);
    this.lastSpinAngle = 0;
    this.angularVelocity = 0;
    this.trailActive = false;
    this.emissionQueue = [];
    this.gradientIndex = 0;
    this.orbitLayouts = [];
    this.hue = 0;
    this.orbitCount = 4;
    this.sizeScale = 1;
    this.wideStyle = false;
  }

  clear() {
    for (const particle of this.particles) {
      particle.element?.remove();
      particle.trailElement?.remove();
      particle.trailFrontElement?.remove();
      particle.gradientElement?.remove();
    }
    this.particles = [];
  }

  resetOrbitStyle(layoutCount = 1) {
    const roll = random(-0.85, 0.85);
    this.orbitLayouts = Array.from({ length: layoutCount }, (_, index) => ({
      tilt: random(0.16, 0.5),
      roll: roll + index * Math.PI / layoutCount + random(-0.12, 0.12),
    }));
    this.orbitCount = layoutCount > 1 ? 3 * layoutCount : Math.round(random(3, 5));
    this.hue = random(0, 360);
  }

  spawnOrbitParticle(angle, direction, index) {
    if (this.particles.length > 110) return;
    if (!this.orbitLayouts.length) this.resetOrbitStyle();
    const layout = this.orbitLayouts[index % this.orbitLayouts.length];
    const countPerLayout = Math.max(Math.ceil(this.orbitCount / this.orbitLayouts.length) - 1, 1);
    const baseRadius = 116 * (this.radius() / HEAD_C);
    this.particles.push({
      x: HEAD_C,
      y: HEAD_C,
      vx: 0,
      vy: 0,
      returnAmount: 0,
      life: 0,
      max: 9,
      radius: (this.orbitCount <= 3 ? random(8, 10.5) : this.orbitCount === 4 ? random(6.6, 8.6) : random(5.6, 7.4)),
      rotation: random(0, 360),
      rotationSpeed: random(-240, 240),
      curl: 0,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      round: true,
      isStar: false,
      hue: this.hue + 360 * index / Math.max(this.orbitCount, 1) + random(-14, 14),
      hueSpan: random(45, 95) * (Math.random() < 0.5 ? 1 : -1),
      hueVelocity: random(18, 42) * (Math.random() < 0.5 ? 1 : -1),
      orbit: {
        angle,
        angularVelocity: direction * random(0.5, 1.1),
        tilt: layout.tilt + random(-0.04, 0.04),
        roll: layout.roll + random(-0.05, 0.05),
        radius: baseRadius + Math.floor(index / this.orbitLayouts.length) * (38 / countPerLayout) + random(-1.5, 1.5),
        radiusVelocity: random(0, 2.5),
        follow: random(0.74, 0.94),
        carry: 0,
        arc: random(2.2, 3.4),
      },
      history: [],
      element: null,
    });
  }

  burst(count = 20, force = 1, curl = 0) {
    if (this.reduceMotion() || !this.back || this.particles.length > 120) return;
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2 + random(-0.35, 0.35);
      const distance = random(96, 116) * (this.radius() / HEAD_C);
      const speed = random(170, 360) * force;
      const tangentX = -Math.sin(angle);
      const tangentY = Math.cos(angle);
      const curlVelocity = curl * speed * 0.2;
      const isStar = Math.random() < 0.18;
      const round = !isStar && Math.random() < 0.3;
      this.particles.push({
        element: null,
        x: HEAD_C + Math.cos(angle) * distance,
        y: HEAD_C + Math.sin(angle) * distance,
        vx: Math.cos(angle) * speed + tangentX * curlVelocity,
        vy: Math.sin(angle) * speed + tangentY * curlVelocity - random(20, 75),
        life: 0,
        max: random(0.45, 0.85),
        radius: isStar ? random(4, 7) : random(3.5, 8),
        rotation: random(0, 360),
        rotationSpeed: random(-260, 260),
        curl: 0,
        color: isStar ? STAR_GOLD : COLORS[Math.floor(Math.random() * COLORS.length)],
        isStar,
        round,
        returnAmount: 0,
        orbit: null,
      });
    }
  }

  projectOrbit(orbit, angle) {
    const horizontal = orbit.radius * Math.sin(angle);
    const vertical = -orbit.radius * Math.cos(angle) * Math.sin(orbit.tilt);
    const cosine = Math.cos(orbit.roll);
    const sine = Math.sin(orbit.roll);
    return {
      x: HEAD_C + horizontal * cosine - vertical * sine,
      y: HEAD_C + horizontal * sine + vertical * cosine,
    };
  }

  orbitDepth(orbit, angle) {
    return Math.cos(angle) * Math.cos(orbit.tilt);
  }

  trailPaths(points, width) {
    const round = (value) => Math.round(value * 10) / 10;
    let length = 0;
    for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    const actualWidth = Math.min(width, 0.34 * length);
    const normalX = [];
    const normalY = [];
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[index > 0 ? index - 1 : 0];
      const next = points[index < points.length - 1 ? index + 1 : points.length - 1];
      let dx = next.x - previous.x;
      let dy = next.y - previous.y;
      const magnitude = Math.hypot(dx, dy) || 1;
      dx /= magnitude;
      dy /= magnitude;
      const halfWidth = actualWidth * (0.5 + index / (points.length - 1) * 0.5) / 2;
      normalX.push(-dy * halfWidth);
      normalY.push(dx * halfWidth);
    }
    const cap = (index) => {
      const radius = Math.max(Math.hypot(normalX[index], normalY[index]), 0.2);
      return `A${round(radius)} ${round(radius)} 0 0 0 `;
    };
    const segment = (start, end) => {
      let path = "";
      for (let index = start; index <= end; index += 1) path += `${index === start ? "M" : "L"}${round(points[index].x + normalX[index])} ${round(points[index].y + normalY[index])}`;
      path += end === points.length - 1 ? cap(end) : "L";
      for (let index = end; index >= start; index -= 1) path += `${index === end ? "" : "L"}${round(points[index].x - normalX[index])} ${round(points[index].y - normalY[index])}`;
      if (start === 0) path += `${cap(0)}${round(points[0].x + normalX[0])} ${round(points[0].y + normalY[0])}`;
      return `${path}Z`;
    };
    if (length < 2) return { front: "", back: "" };
    let front = "";
    let back = "";
    let cursor = 0;
    while (cursor < points.length) {
      const isFront = points[cursor].z >= 0;
      let end = cursor;
      while (end + 1 < points.length && (points[end + 1].z >= 0) === isFront) end += 1;
      const segmentStart = Math.max(cursor - 1, 0);
      const segmentEnd = Math.min(end + 1, points.length - 1);
      if (segmentEnd > segmentStart) {
        const path = segment(segmentStart, segmentEnd);
        if (isFront) front += path;
        else back += path;
      }
      cursor = end + 1;
    }
    return { front, back };
  }

  update(now, delta, { spinAngle, sizeScale, wideStyle, enabled = true }) {
    this.sizeScale = sizeScale;
    this.spinAngle = spinAngle;
    this.wideStyle = wideStyle;
    if (!enabled) {
      if (this.particles.length) this.clear();
      this.emissionQueue = [];
      this.trailActive = false;
      this.angularVelocity = 0;
      this.lastSpinAngle = this.spinAngle;
      return;
    }
    let difference = this.spinAngle - this.lastSpinAngle;
    if (!Number.isFinite(difference) || Math.abs(difference) > 1.2) difference = 0;
    this.lastSpinAngle = this.spinAngle;
    const wasSpinning = Math.abs(this.angularVelocity) >= 0.9;
    this.angularVelocity = delta > 0 ? difference / delta : 0;
    const isSpinning = Math.abs(this.angularVelocity) >= 0.9;
    if (!wasSpinning && isSpinning) {
      this.resetOrbitStyle(this.wideStyle ? 3 : 1);
      this.trailActive = false;
    }
    if (wasSpinning && !isSpinning) this.emissionQueue = [];
    if (!this.reduceMotion() && this.back) {
      if (!this.trailActive && Math.abs(this.angularVelocity) >= 5) {
        this.trailActive = true;
        this.emissionQueue = Array.from({ length: this.orbitCount }, (_, index) => ({ at: now + index * random(55, 105), index }));
      }
      while (this.emissionQueue.length && now >= this.emissionQueue[0].at) {
        const queued = this.emissionQueue.shift();
        this.spawnOrbitParticle(this.spinAngle - random(0, 0.18), Math.sign(this.angularVelocity) || 1, queued.index);
      }
    }

    const alive = [];
    for (const particle of this.particles) {
      particle.life += delta;
      const progress = clamp(particle.life / particle.max, 0, 1);
      if (particle.orbit) {
        const shouldReturn = !isSpinning || progress > 0.55;
        particle.returnAmount = clamp(particle.returnAmount + (shouldReturn ? delta / 0.5 : -delta / 0.35), 0, 1);
        if (particle.returnAmount >= 1) {
          particle.trailElement?.remove();
          particle.trailFrontElement?.remove();
          particle.gradientElement?.remove();
          continue;
        }
      } else if (particle.life >= particle.max) {
        particle.element?.remove();
        continue;
      }

      const opacity = particle.orbit ? Math.min(1, particle.life / 0.26) : progress < 0.1 ? progress / 0.1 : (1 - (progress - 0.1) / 0.9) ** 1.7;
      if (particle.orbit) {
        const orbit = particle.orbit;
        if (isSpinning) {
          orbit.carry = this.angularVelocity * orbit.follow;
          orbit.angle += this.angularVelocity * delta * orbit.follow + orbit.angularVelocity * delta;
        } else {
          orbit.angle += (orbit.carry + orbit.angularVelocity) * delta;
          orbit.carry *= Math.exp(-2.6 * delta);
          orbit.angularVelocity *= Math.exp(-2.6 * delta);
        }
        orbit.radius += orbit.radiusVelocity * delta;
        const position = this.projectOrbit(orbit, orbit.angle);
        particle.x = position.x;
        particle.y = position.y;
        const depth = this.orbitDepth(orbit, orbit.angle);
        const depthScale = 0.72 + 0.28 * clamp(depth, 0, 1);
        const enter = Math.min(particle.life / 0.34, 1);
        const smoothEnter = enter * enter * (3 - 2 * enter);
        const width = Math.max(particle.radius * depthScale * 1.7 * this.sizeScale * smoothEnter * (1 - 0.72 * particle.returnAmount ** 2), 0.5);

        if (!particle.trailElement) {
          const trail = document.createElementNS(SVG_NS, "path");
          trail.setAttribute("data-trail", "");
          trail.setAttribute("stroke", "none");
          const gradient = document.createElementNS(SVG_NS, "linearGradient");
          const gradientId = `${this.idPrefix}t${this.gradientIndex++}`;
          gradient.setAttribute("id", gradientId);
          gradient.setAttribute("gradientUnits", "userSpaceOnUse");
          particle.stops = [];
          for (let index = 0; index < 5; index += 1) {
            const stop = document.createElementNS(SVG_NS, "stop");
            stop.setAttribute("offset", (index / 4).toFixed(3));
            gradient.appendChild(stop);
            particle.stops.push(stop);
          }
          this.back.appendChild(gradient);
          particle.gradientElement = gradient;
          trail.setAttribute("fill", `url(#${gradientId})`);
          this.back.appendChild(trail);
          particle.trailElement = trail;
          const frontTrail = document.createElementNS(SVG_NS, "path");
          frontTrail.setAttribute("data-trail", "");
          frontTrail.setAttribute("stroke", "none");
          frontTrail.setAttribute("fill", trail.getAttribute("fill") || particle.color);
          this.front?.appendChild(frontTrail);
          particle.trailFrontElement = frontTrail;
        }

        const history = particle.history;
        const previousAngle = history.length ? history.at(-1).angle : orbit.angle;
        const angleChange = orbit.angle - previousAngle;
        const subdivisions = Math.min(Math.ceil(Math.abs(angleChange) / 0.09), 24);
        for (let index = 1; index <= subdivisions; index += 1) {
          const angle = previousAngle + angleChange * index / subdivisions;
          const point = this.projectOrbit(orbit, angle);
          history.push({ x: point.x, y: point.y, angle, z: this.orbitDepth(orbit, angle) });
        }
        if (!history.length) history.push({ x: particle.x, y: particle.y, angle: orbit.angle, z: depth });
        const arc = orbit.arc * (1 - particle.returnAmount ** 2 * (3 - 2 * particle.returnAmount));
        while (history.length > 2 && Math.abs(orbit.angle - history[0].angle) > arc) history.shift();
        const excess = Math.abs(orbit.angle - history[0].angle) - arc;
        if (history.length >= 2 && excess > 0) {
          const angle = history[0].angle + Math.sign(orbit.angle - history[0].angle) * excess;
          const point = this.projectOrbit(orbit, angle);
          history[0] = { x: point.x, y: point.y, angle, z: this.orbitDepth(orbit, angle) };
        }
        if (history.length > 48) history.splice(0, history.length - 48);
        if (history.length >= 2) {
          const paths = this.trailPaths(history, width);
          const trailOpacity = opacity.toFixed(3);
          particle.trailElement.setAttribute("d", paths.back);
          particle.trailElement.setAttribute("opacity", trailOpacity);
          particle.trailFrontElement?.setAttribute("d", paths.front);
          particle.trailFrontElement?.setAttribute("opacity", trailOpacity);
          const hue = particle.hue + particle.hueVelocity * particle.life;
          for (let index = 0; index < particle.stops.length; index += 1) {
            const position = index / (particle.stops.length - 1);
            const value = hue + position * particle.hueSpan;
            particle.stops[index].setAttribute("stop-color", `hsl(${(((value % 360) + 360) % 360).toFixed(0)} 56% ${(56 + 11 * position).toFixed(0)}%)`);
          }
          const first = history[0];
          const last = history.at(-1);
          particle.gradientElement.setAttribute("x1", first.x.toFixed(1));
          particle.gradientElement.setAttribute("y1", first.y.toFixed(1));
          particle.gradientElement.setAttribute("x2", last.x.toFixed(1));
          particle.gradientElement.setAttribute("y2", last.y.toFixed(1));
        } else {
          particle.trailElement.setAttribute("opacity", "0");
          particle.trailFrontElement?.setAttribute("opacity", "0");
        }
        alive.push(particle);
        continue;
      }

      if (particle.curl) {
        const cosine = Math.cos(particle.curl * delta);
        const sine = Math.sin(particle.curl * delta);
        const vx = particle.vx * cosine - particle.vy * sine;
        const vy = particle.vx * sine + particle.vy * cosine;
        particle.vx = vx;
        particle.vy = vy;
      }
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      const drag = 0.94 ** (60 * delta);
      particle.vx *= drag;
      particle.vy = particle.vy * drag + 40 * delta;
      const size = Math.max(particle.radius * (1 - 0.4 * progress), 0.5);

      if (!particle.element) {
        particle.element = document.createElementNS(SVG_NS, particle.isStar ? "path" : particle.round ? "circle" : "rect");
        if (particle.isStar) particle.element.setAttribute("d", STAR_PATH);
        particle.element.setAttribute("fill", particle.color);
        this.back.appendChild(particle.element);
      }
      particle.element.setAttribute("opacity", opacity.toFixed(3));
      if (particle.isStar) {
        particle.rotation += particle.rotationSpeed * delta;
        particle.element.setAttribute("transform", `translate(${particle.x.toFixed(1)} ${particle.y.toFixed(1)}) rotate(${particle.rotation.toFixed(1)}) scale(${size.toFixed(2)})`);
      } else if (particle.round) {
        particle.element.setAttribute("cx", particle.x.toFixed(1));
        particle.element.setAttribute("cy", particle.y.toFixed(1));
        particle.element.setAttribute("r", size.toFixed(2));
      } else {
        const width = Math.max(2 * size, Math.min(0.05 * Math.hypot(particle.vx, particle.vy), 30));
        const height = 1.5 * size;
        particle.element.setAttribute("width", width.toFixed(1));
        particle.element.setAttribute("height", height.toFixed(1));
        particle.element.setAttribute("rx", (height / 2).toFixed(2));
        particle.element.setAttribute("x", (particle.x - width / 2).toFixed(1));
        particle.element.setAttribute("y", (particle.y - height / 2).toFixed(1));
        particle.element.setAttribute("transform", `rotate(${(Math.atan2(particle.vy, particle.vx) * 180 / Math.PI).toFixed(1)} ${particle.x.toFixed(1)} ${particle.y.toFixed(1)})`);
      }
      alive.push(particle);
    }
    this.particles = alive;
  }
}
