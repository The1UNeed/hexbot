import { CIRCLE_RING, EYE_HALF, HEAD_C } from "../original-data.js";
import {
  ALERT_GLYPH,
  CIRCLE_PATH,
  PENCIL_GLYPH,
  PENCIL_RING,
  centroid,
  lerpRing,
  ringOutline,
  ringPath,
  shapeSpanAt,
  spanAt,
  turnedShapeRing,
} from "./geometry.js";
import { backOut, clamp, cubicInOut, cubicOut, random, smoothstep } from "./math.js";

export const MORPH_SIZES = Object.freeze({
  dots: 22,
  orbit: 19,
  radar: 19,
  progress: 19,
  gather: 19,
  wave: 16,
  send: 20,
  receive: 20,
  dock: 20,
  ball: 18,
  whirl: 15,
  pencil: 17,
  bang: 13,
  standby: 13,
});

const MORPH_EFFECTS = Object.keys(MORPH_SIZES);
const MORPH_VIEWBOX = {
  dots: 1.5,
  orbit: 1.14,
  radar: 1.14,
  progress: 1.32,
  gather: 1.15,
  wave: 1.42,
  send: 1.12,
  receive: 1.12,
  dock: 1.3,
  ball: 1.22,
  whirl: 1.45,
  pencil: 1.18,
  bang: 1.28,
  standby: 1.75,
};
const SVG_NS = "http://www.w3.org/2000/svg";
const REDUCE_MOTION = typeof globalThis.matchMedia === "function"
  ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

export function render(now, config) {
  const geometry = this.resolveShape(config.shape);
  const shape = geometry.shape;
  const effectiveShape = {
    ...shape,
    face: geometry.face,
    tiltScale: geometry.tiltScale,
    beltRadius: geometry.beltRadius,
    top: geometry.transitioning ? Math.min(...geometry.ring.map((point) => point[1])) : shape.top,
    bottom: geometry.transitioning ? Math.max(...geometry.ring.map((point) => point[1])) : shape.bottom,
    spanSamples: geometry.transitioning ? null : shape.spanSamples,
  };
  const morphAmount = clamp(this.morph.x, 0, 1);
  this.currentBeltRadius = geometry.beltRadius + (this.state === "loading" ? (52 - geometry.beltRadius) * morphAmount : 0);
  const morphBlend = clamp(this.morphBlend.x, 0, 1);
  const previousMorphEffect = morphBlend < 0.999 ? this.previousMorphEffect : null;
  const morphIsTurning = this.morph.x > 0.001 || Math.abs(this.turn.target - this.turn.x) > 0.01;
  const morphTurn = morphIsTurning ? this.turn.x : 0;
  const turnAngle = morphTurn + (this.spinSpring?.x ?? 0) + this.directTurn;
  const baseShapeRing = geometry.ring;
  const shapeRing = Math.abs(turnAngle) > 0.001 && !geometry.transitioning ? turnedShapeRing(shape, turnAngle) : baseShapeRing;
  const activeMorphRing = this.morphEffect === "pencil" ? PENCIL_RING : CIRCLE_RING;
  const previousMorphRing = previousMorphEffect === "pencil" ? PENCIL_RING : CIRCLE_RING;
  const morphRing = previousMorphEffect
    ? lerpRing(previousMorphRing, activeMorphRing, cubicInOut(morphBlend))
    : activeMorphRing;
  const morphPathAmount = clamp(morphAmount / 0.62, 0, 1);
  const headRing = morphPathAmount <= 0 ? shapeRing : lerpRing(shapeRing, morphRing, cubicInOut(morphPathAmount));
  const headPath = morphPathAmount <= 0
    ? geometry.transitioning || (Math.abs(turnAngle) > 0.001 && (shape.solid || shape.sides)) ? ringOutline(shapeRing) : shape.path
    : ringOutline(headRing);
  this.head.setAttribute("d", headPath);
  this.clipHead.setAttribute("d", headPath);

  this.renderEyes(now, config, effectiveShape, shapeRing, turnAngle, morphAmount);
  const effect = this.morphEffect;
  const activeMorphSize = effect ? MORPH_SIZES[effect] : 19;
  const previousMorphSize = previousMorphEffect ? MORPH_SIZES[previousMorphEffect] : activeMorphSize;
  const morphSize = activeMorphSize * morphBlend + previousMorphSize * (1 - morphBlend);
  const morphScale = morphSize / HEAD_C;
  const effectPose = this.renderMorphEffects(morphAmount, morphBlend, previousMorphEffect, morphSize, now);
  this.renderHummingMarkers(effectiveShape);
  const normal = 1 - morphAmount;
  const translateX = this.headX.x * normal + this.directX * normal + effectPose.x;
  const translateY = this.headY.x * normal + this.directY * normal + effectPose.y;
  const rotation = this.rotation.x * 180 / Math.PI * geometry.tiltScale * normal + this.directRotation * normal + effectPose.rotation;
  const scaleX = config.scaleX * normal + morphScale * effectPose.scale * morphAmount;
  const scaleY = this.scaleY.x * normal + morphScale * effectPose.scale * morphAmount;
  this.transformGroup.setAttribute("transform", `translate(${(HEAD_C + translateX).toFixed(2)} ${(HEAD_C + translateY).toFixed(2)}) rotate(${rotation.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${-HEAD_C} ${-HEAD_C})`);
  this.transformGroup.style.opacity = effectPose.opacity.toFixed(3);

  const badgeAmount = clamp(this.notify.x, 0, 1.4);
  if (badgeAmount <= 0.01) this.badge.hidden = true;
  else {
    const badgeAnchor = shapeRing[Math.round(7 * shapeRing.length / 8) % shapeRing.length];
    this.badge.hidden = false;
    this.badge.setAttribute("fill", config.badgeColor);
    this.badge.setAttribute("stroke", config.eyeColor);
    this.badge.setAttribute("stroke-width", "10");
    this.badge.setAttribute("cx", badgeAnchor[0].toFixed(1));
    this.badge.setAttribute("cy", badgeAnchor[1].toFixed(1));
    this.badge.setAttribute("r", (20 * config.badgeScale * badgeAmount).toFixed(2));
  }

  const width = this.svg.getBoundingClientRect().width || 380;
  const responsive = 1 - smoothstep(clamp((width - 44) / 90, 0, 1));
  const activeExpansion = effect ? MORPH_VIEWBOX[effect] : 1;
  const previousExpansion = previousMorphEffect ? MORPH_VIEWBOX[previousMorphEffect] : activeExpansion;
  const expansion = activeExpansion * morphBlend + previousExpansion * (1 - morphBlend);
  const radius = 129.5 / (1 + (expansion - 1) * morphAmount * responsive);
  this.svg.setAttribute("viewBox", `${(114.5 - radius).toFixed(2)} ${(114.5 - radius).toFixed(2)} ${(2 * radius).toFixed(2)} ${(2 * radius).toFixed(2)}`);
  return { headPath, rotation };
}

export function renderEyes(now, config, shape, shapeRing, turnAngle, morphAmount) {
  const amount = clamp(this.expressionSpring.x, 0, 1);
  const eyeRings = [
    lerpRing(this.expressionFrom[0], this.expressionTo[0], amount),
    lerpRing(this.expressionFrom[1], this.expressionTo[1], amount),
  ];
  const centers = eyeRings.map(centroid);
  const face = shape.face;
  let top = shape.top;
  let bottom = shape.bottom;
  if (Math.abs(turnAngle) > 0.001) {
    top = Math.min(...shapeRing.map((point) => point[1]));
    bottom = Math.max(...shapeRing.map((point) => point[1]));
  }
  let leftHalf = 0;
  let rightHalf = 0;
  for (const point of eyeRings[0]) leftHalf = Math.max(leftHalf, Math.abs(point[0] - centers[0][0]));
  for (const point of eyeRings[1]) rightHalf = Math.max(rightHalf, Math.abs(point[0] - centers[1][0]));
  const distance = Math.abs(centers[1][0] - centers[0][0]) * face.sx;
  const fit = leftHalf + rightHalf > 0.5 ? clamp((distance - 5) / (leftHalf + rightHalf), 0.35, 4) : 4;

  if (config.pointer && this.pointer.active) {
    const bounds = this.svg.getBoundingClientRect();
    const flip = config.flipX ? -1 : 1;
    this.pointer.targetX = 22 * clamp((this.pointer.clientX - (bounds.left + bounds.width / 2)) / bounds.width, -0.6, 0.6) * flip;
    this.pointer.targetY = 14 * clamp((this.pointer.clientY - (bounds.top + bounds.height / 2)) / bounds.height, -0.6, 0.6);
  } else { this.pointer.targetX = 0; this.pointer.targetY = 0; }
  const smoothing = 1 - Math.exp(60 * Math.log(0.91) * (this.delta || 1 / 60));

  for (let index = 0; index < 2; index += 1) {
    this.pointer.x += (this.pointer.targetX - this.pointer.x) * smoothing;
    this.pointer.y += (this.pointer.targetY - this.pointer.y) * smoothing;
    const element = this.eyes[index];
    const ring = eyeRings[index];
    const [centerX, centerY] = centers[index];
    element.setAttribute("d", ringPath(ring));
    let localCenter = HEAD_C + face.x;
    let offsetX = (centerX - HEAD_C) * face.sx;
    let perspectiveX = 1;
    let visible = true;
    let perspectiveFade = 1;
    if (Math.abs(turnAngle) > 0.001) {
      const [left, right] = spanAt(shapeRing, clamp(HEAD_C + face.y + (centerY - HEAD_C) * face.sy, top + 2, bottom - 2));
      const radius = Math.max((right - left) / 2, 12);
      localCenter = (left + right) / 2;
      const initial = Math.asin(clamp(offsetX / radius, -1, 1));
      const turned = initial + turnAngle;
      const cosine = Math.cos(turned);
      const baseCosine = Math.max(Math.cos(initial), 0.02);
      visible = cosine > 0.02;
      perspectiveX = Math.max(cosine, 0.02) / baseCosine;
      offsetX = radius * Math.sin(turned);
      perspectiveFade = smoothstep(clamp(cosine / 0.5, 0, 1));
    }
    const pulse = 1 + 0.07 * Math.sin(amount * Math.PI);
    let driftX = 1.4 * Math.sin(0.00042 * now + index) + 0.5 * Math.sin(0.001 * now + 2 * index);
    let driftY = 0.9 * Math.sin(0.00058 * now + index);
    const autonomousGazeWeight = config.pointer && this.pointer.active ? 0.2 : 1;
    driftX += this.pointer.x + this.aimX.x * autonomousGazeWeight + this.directGazeX;
    driftY += this.pointer.y + this.aimY.x * autonomousGazeWeight + this.directGazeY;
    const notification = clamp(this.notify.x, 0, 1);
    driftX -= 10 * notification;
    driftY += 7 * notification;
    const eyeScale = Math.min(clamp(this.eyeScale.x, 0.2, 2) * face.eye, fit / pulse);
    const scaleX = clamp(perspectiveX * eyeScale * pulse, 0.02, 2.4);
    let winkScale = 1;
    if (index === this.winkEye && now < this.winkAt + 320) {
      const phase = (now - this.winkAt) / 320;
      winkScale = Math.max(phase < 0.42 ? 1 - phase / 0.42 : (phase - 0.42) / 0.58, 0.04);
    }
    const scaleY = clamp(Math.max(this.eyeOpen.x * winkScale, 0.04) * eyeScale * pulse, 0.02, 2.4);
    element.style.display = visible && morphAmount < 0.5 ? "" : "none";
    const halfHeight = EYE_HALF * scaleY + 2;
    const y = clamp(HEAD_C + face.y + (centerY + driftY - HEAD_C) * face.sy, top + halfHeight, bottom - halfHeight);
    let maxLeft = -Infinity;
    let minRight = Infinity;
    for (let point = 0; point < ring.length; point += 2) {
      const scaledX = (ring[point][0] - centerX) * scaleX;
      const sampleY = y + (ring[point][1] - centerY) * scaleY;
      const [left, right] = Math.abs(turnAngle) > 0.001 ? spanAt(shapeRing, sampleY) : shapeSpanAt(shape, sampleY);
      maxLeft = Math.max(maxLeft, left - scaledX);
      minRight = Math.min(minRight, right - scaledX);
    }
    const desired = localCenter + offsetX + driftX * face.sx;
    const bounded = maxLeft <= minRight ? clamp(desired, maxLeft, minRight) : (maxLeft + minRight) / 2;
    let finalX = bounded + (desired - bounded) * (1 - perspectiveFade);
    let finalY = y;
    if (notification > 0.01) {
      const badgeAnchor = shapeRing[Math.round(7 * shapeRing.length / 8) % shapeRing.length];
      const dx = finalX - badgeAnchor[0];
      const dy = finalY - badgeAnchor[1];
      const distance = Math.hypot(dx, dy) || 1;
      const directionX = dx / distance;
      const directionY = dy / distance;
      const eyeHalf = index === 0 ? leftHalf : rightHalf;
      const needed = 20 * clamp(this.notify.x, 0, 1.4) + Math.hypot(eyeHalf * scaleX * directionX, EYE_HALF * scaleY * directionY) + 5;
      if (distance < needed) {
        finalX += directionX * (needed - distance);
        finalY += directionY * (needed - distance);
      }
    }
    element.setAttribute("transform", `translate(${finalX.toFixed(2)} ${finalY.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${(-centerX).toFixed(2)} ${(-centerY).toFixed(2)})`);
  }
}

export function createMorphLayer(effect) {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "morph-effect-layer");
  group.setAttribute("data-morph-effect", effect);
  const create = (tag, className, count) => Array.from({ length: count }, () => {
    const element = document.createElementNS(SVG_NS, tag);
    element.setAttribute("class", className);
    if (tag === "circle") {
      element.setAttribute("cx", HEAD_C);
      element.setAttribute("cy", HEAD_C);
      element.setAttribute("r", 0);
    }
    element.hidden = true;
    group.appendChild(element);
    return element;
  });
  const layer = {
    group,
    heads: create("path", "grok-bot-mark__head morph-head", 2),
    rings: create("circle", "morph-ring", 5),
    parts: create("circle", "grok-bot-mark__head morph-part", 5),
    glyphs: create("path", "morph-glyph", 3),
  };
  this.svg.insertBefore(group, this.transformGroup);
  this.morphLayers.set(effect, layer);
  return layer;
}

export function useMorphLayer(layer) {
  this.morphHeads = layer.heads;
  this.rings = layer.rings;
  this.parts = layer.parts;
  this.glyphs = layer.glyphs;
}

export function hideMorphElements() {
  for (const element of [...this.morphHeads, ...this.rings, ...this.parts, ...this.glyphs]) element.hidden = true;
}

export function renderHummingMarkers(shape) {
  const amount = clamp(this.humming.x, 0, 1);
  if (amount <= 0.01) return;
  for (let index = 0; index < 2; index += 1) {
    const element = this.parts[3 + index];
    const angle = 0.85 * this.spinAngle + index * Math.PI;
    const radius = 1.3 * shape.radius;
    const depth = 0.55 + 0.45 * clamp((Math.cos(angle) + 1) / 2, 0, 1);
    element.hidden = false;
    element.setAttribute("cx", (HEAD_C + radius * Math.sin(angle)).toFixed(1));
    element.setAttribute("cy", (HEAD_C - 0.38 * radius * Math.cos(angle) - 8).toFixed(1));
    element.setAttribute("r", (7.5 * depth * amount).toFixed(2));
    element.setAttribute("opacity", ((0.3 + 0.7 * depth) * amount).toFixed(3));
  }
}

export function renderMorphEffects(morphAmount, morphBlend, previousMorphEffect, morphSize, now) {
  this.useMorphLayer(this.baseMorphLayer);
  this.hideMorphElements();
  for (const layer of this.morphLayers.values()) layer.group.hidden = true;
  const pose = { x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 };
  if (!this.morphEffect || morphAmount <= 0.004) return pose;

  const effectAmount = (effect) => {
    if (effect === this.morphEffect) return morphAmount * morphBlend;
    if (effect === previousMorphEffect) return morphAmount * (1 - morphBlend);
    return 0;
  };
  const elapsed = now - this.stateStartedAt;

  for (const effect of MORPH_EFFECTS) {
    const amount = effectAmount(effect);
    if (amount <= 0.004) continue;
    const layer = this.morphLayers.get(effect) || this.createMorphLayer(effect);
    layer.group.hidden = false;
    this.useMorphLayer(layer);
    this.hideMorphElements();
    switch (effect) {
      case "dots": {
        this.renderDots(amount, now);
        const distance = Math.abs(((((now - this.morphStartedAt) / 1400 + 0.119) % 1 + 1) % 1) - 1 / 3);
        const pulseDistance = Math.min(distance, 1 - distance);
        const pulse = REDUCE_MOTION.matches ? 1 : Math.exp(-(pulseDistance ** 2) / 0.045);
        const pop = REDUCE_MOTION.matches ? 1 : 0.84 + 0.22 * pulse;
        pose.scale *= 1 + (pop - 1) * (amount / Math.max(morphAmount, 0.001));
        pose.y -= REDUCE_MOTION.matches ? 0 : 9 * pulse * amount * morphAmount;
        pose.opacity *= 1 - (REDUCE_MOTION.matches ? 0 : 0.5 * (1 - pulse)) * amount;
        break;
      }
      case "orbit": this.renderOrbit(amount, now); break;
      case "radar": this.renderRadar(amount, now, morphSize); break;
      case "progress": this.renderProgress(amount, now); break;
      case "gather": this.renderGather(amount, now); break;
      case "wave": this.renderWave(amount, now); break;
      case "send": {
        this.renderSend(amount, now);
        const phase = ((((elapsed / 1500) % 1) + 1) % 1);
        pose.scale *= 1 + (phase < 0.18 ? -0.06 * Math.sin(phase / 0.18 * Math.PI) : phase < 0.42 ? 0.05 * Math.sin((phase - 0.18) / 0.24 * Math.PI) : 0) * amount;
        break;
      }
      case "receive": {
        this.renderReceive(amount, now);
        const phase = clamp((((((elapsed / 1700) % 1) + 1) % 1) - 0.58) / 0.34, 0, 1);
        pose.scale *= 1 + 0.11 * Math.sin(phase * Math.PI) * amount;
        break;
      }
      case "dock": this.renderDock(amount, now); break;
      case "pencil": {
        const pencil = this.renderPencil(amount, now);
        pose.x += pencil.x * amount * morphAmount;
        pose.y += pencil.y * amount * morphAmount;
        pose.rotation += pencil.rotation * amount * morphAmount;
        break;
      }
      case "bang":
        this.renderBang(amount, now);
        pose.y += 58 * amount * morphAmount;
        pose.scale *= 1 + 0.04 * Math.exp(-((elapsed / 1000 % 2.2) * 5.5)) * amount;
        break;
      case "standby":
        this.renderStandby(amount, now);
        pose.opacity *= 1 - (0.28 + 0.2 * Math.sin(0.0016 * now)) * amount;
        break;
      case "whirl":
        pose.x += (2 * Math.sin(0.0009 * now) + 0.8 * Math.sin(0.0017 * now)) * amount * morphAmount;
        pose.y += (2.4 * Math.sin(0.0013 * now) + 1.2 * Math.sin(0.0006 * now)) * amount * morphAmount;
        break;
      case "ball": {
        const seconds = elapsed / 1000;
        const gravity = 416 / 0.3844;
        const fall = Math.sqrt(80 / gravity);
        const cycle = ((((seconds - fall) / 0.62) % 1 + 1) % 1);
        const height = seconds < fall ? 40 - 0.5 * gravity * seconds ** 2 : 208 * cycle * (1 - cycle);
        pose.y += (40 - height) * amount * morphAmount;
        break;
      }
      default: break;
    }
  }
  this.useMorphLayer(this.baseMorphLayer);
  return pose;
}

export function renderDots(amount, now) {
  const anchors = [HEAD_C - 62, HEAD_C + 62];
  for (let index = 0; index < 2; index += 1) {
    const element = this.morphHeads[index];
    const phase = clamp((amount - 0.12 * index) / (1 - 0.12 * index), 0, 1);
    if (phase <= 0.004) continue;
    const grow = cubicOut(phase);
    const enter = backOut(phase);
    const pulseDistance = Math.abs(((((now - this.morphStartedAt) / 1400 + 0.119) % 1 + 1) % 1) - index * 2 / 3);
    const distance = Math.min(pulseDistance, 1 - pulseDistance);
    const pulse = REDUCE_MOTION.matches ? 1 : Math.exp(-(distance ** 2) / 0.045);
    const lift = REDUCE_MOTION.matches ? 0 : 9 * pulse * amount;
    const pop = REDUCE_MOTION.matches ? 1 : 0.84 + 0.22 * pulse;
    const scale = 22 * grow * pop / HEAD_C * 1.02;
    element.hidden = false;
    element.setAttribute("d", CIRCLE_PATH);
    element.setAttribute("transform", `translate(${(HEAD_C + (anchors[index] - HEAD_C) * enter).toFixed(1)} ${(HEAD_C - lift).toFixed(1)}) scale(${scale.toFixed(4)}) translate(${-HEAD_C} ${-HEAD_C})`);
    element.setAttribute("opacity", (grow * (1 - 0.5 * (1 - pulse))).toFixed(3));
  }
}

export function renderOrbit(amount, now) {
  const radius = 52 * backOut(amount);
  for (let index = 0; index < 5; index += 1) {
    const element = this.parts[index];
    const phase = 0.0017 * now + index * Math.PI * 2 / 5;
    const cosine = Math.cos(phase);
    const depth = 0.5 + 0.5 * clamp(cosine, 0, 1);
    element.hidden = false;
    element.setAttribute("cx", (HEAD_C + radius * Math.sin(phase)).toFixed(1));
    element.setAttribute("cy", (HEAD_C - 0.42 * radius * Math.cos(phase)).toFixed(1));
    element.setAttribute("r", Math.max(12 * depth * cubicOut(amount), 0.3).toFixed(2));
    element.setAttribute("opacity", (clamp((cosine + 0.4) / 0.6, 0.18, 1) * cubicOut(amount)).toFixed(3));
  }
}

export function renderRadar(amount, now, baseRadius) {
  for (let index = 0; index < 3; index += 1) {
    const element = this.rings[index];
    const phase = ((now / 1300 + index / 3) % 1 + 1) % 1;
    element.hidden = false;
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", "var(--fg)");
    element.setAttribute("r", (baseRadius + (104 - baseRadius) * phase).toFixed(1));
    element.setAttribute("stroke-width", (3.4 * (1 - 0.55 * phase)).toFixed(2));
    element.setAttribute("opacity", (cubicOut(amount) * (1 - phase) * 0.9).toFixed(3));
  }
}

export function renderProgress(amount, now) {
  const radius = 62 * backOut(amount);
  const track = this.rings[3];
  const value = this.rings[4];
  track.hidden = false;
  track.setAttribute("fill", "none"); track.setAttribute("stroke", "var(--fg)"); track.setAttribute("r", radius.toFixed(1)); track.setAttribute("stroke-width", "5"); track.setAttribute("opacity", (0.16 * cubicOut(amount)).toFixed(3));
  const progress = clamp((now - this.morphShotStartedAt) / 2500 / 0.85, 0, 1);
  const circumference = 2 * Math.PI * radius;
  value.hidden = false;
  value.setAttribute("fill", "none"); value.setAttribute("stroke", "var(--fg)"); value.setAttribute("r", radius.toFixed(1)); value.setAttribute("stroke-width", "5"); value.setAttribute("stroke-dasharray", circumference.toFixed(1)); value.setAttribute("stroke-dashoffset", (circumference * (1 - progress)).toFixed(1)); value.setAttribute("transform", `rotate(-90 ${HEAD_C} ${HEAD_C})`); value.setAttribute("opacity", cubicOut(amount).toFixed(3));
}

export function renderGather(amount, now) {
  for (let index = 0; index < 5; index += 1) {
    const element = this.parts[index];
    const phase = clamp(((now - this.morphShotStartedAt) / 2000 - 0.09 * index) / 0.62, 0, 1);
    if (phase >= 1) continue;
    const settle = 1 - (1 - phase) ** 3;
    const angle = 2.4 * index + 2.2 * phase;
    const radius = 96 * (1 - settle);
    element.hidden = false;
    element.setAttribute("cx", (HEAD_C + radius * Math.cos(angle)).toFixed(1));
    element.setAttribute("cy", (HEAD_C + radius * Math.sin(angle) * 0.8).toFixed(1));
    element.setAttribute("r", (9 * (0.5 + 0.5 * settle) * cubicOut(amount)).toFixed(2));
    element.setAttribute("opacity", (cubicOut(amount) * clamp(5 * phase, 0, 1) * (1 - 0.25 * settle)).toFixed(3));
  }
}

export function renderWave(amount, now) {
  const offsets = [-2, -1, 1, 2];
  for (let index = 0; index < 4; index += 1) {
    const element = index < 2 ? this.morphHeads[index] : this.parts[index - 2];
    const offset = offsets[index];
    const phase = clamp((amount - 0.1 * Math.abs(offset)) / (1 - 0.1 * Math.abs(offset)), 0, 1);
    if (phase <= 0.004) continue;
    const energy = (0.42 + 0.29 * Math.sin(0.0021 * now) * Math.sin(0.0034 * now) + 0.29 * Math.sin(0.0013 * now + 1.7)) * (0.55 + 0.45 * Math.sin(0.012 * now - 1.05 * Math.abs(offset)));
    const size = (7 + 9 * clamp(energy, 0.08, 1)) * cubicOut(phase);
    const lift = 6 * clamp(energy, 0, 1) * phase;
    element.hidden = false;
    if (index < 2) {
      const scale = size / HEAD_C * 1.02;
      element.setAttribute("d", CIRCLE_PATH);
      element.setAttribute("transform", `translate(${(HEAD_C + 44 * offset * backOut(phase)).toFixed(1)} ${(HEAD_C - lift).toFixed(1)}) scale(${scale.toFixed(4)}) translate(${-HEAD_C} ${-HEAD_C})`);
    } else {
      element.setAttribute("cx", (HEAD_C + 44 * offset * backOut(phase)).toFixed(1)); element.setAttribute("cy", (HEAD_C - lift).toFixed(1)); element.setAttribute("r", size.toFixed(2));
    }
    element.setAttribute("opacity", phase.toFixed(3));
  }
}

export function renderSend(amount, now) {
  const phase = ((((now - this.stateStartedAt) / 1500) % 1) + 1) % 1;
  const travel = clamp((phase - 0.18) / 0.55, 0, 1);
  const eased = travel ** 2 * (0.4 + 0.6 * travel);
  const distance = 108 * eased;
  const first = this.parts[0];
  if (travel > 0 && travel < 1) { first.hidden = false; first.setAttribute("cx", (HEAD_C + 0.74 * distance).toFixed(1)); first.setAttribute("cy", (HEAD_C - 0.62 * distance).toFixed(1)); first.setAttribute("r", (10 * (1 - 0.55 * eased) * cubicOut(amount)).toFixed(2)); first.setAttribute("opacity", (cubicOut(amount) * (1 - eased ** 2)).toFixed(3)); }
  const secondTravel = clamp((phase - 0.26) / 0.55, 0, 1);
  const secondEase = secondTravel ** 2 * (0.4 + 0.6 * secondTravel);
  const second = this.parts[1];
  if (travel > 0 && secondTravel > 0 && secondTravel < 1) { const secondDistance = 108 * secondEase; second.hidden = false; second.setAttribute("cx", (HEAD_C + 0.74 * secondDistance).toFixed(1)); second.setAttribute("cy", (HEAD_C - 0.62 * secondDistance).toFixed(1)); second.setAttribute("r", (5 * (1 - 0.6 * secondEase) * cubicOut(amount)).toFixed(2)); second.setAttribute("opacity", (0.3 * cubicOut(amount) * (1 - secondEase)).toFixed(3)); }
  const ringPhase = clamp((phase - 0.18) / 0.3, 0, 1);
  if (ringPhase > 0 && ringPhase < 1) { const ring = this.rings[0]; ring.hidden = false; ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--fg)"); ring.setAttribute("r", (20 + 34 * cubicOut(ringPhase)).toFixed(1)); ring.setAttribute("stroke-width", (2.8 * (1 - ringPhase)).toFixed(2)); ring.setAttribute("opacity", (cubicOut(amount) * (1 - ringPhase) * 0.8).toFixed(3)); }
}

export function renderReceive(amount, now) {
  const elapsed = now - this.stateStartedAt;
  const cycle = Math.floor(elapsed / 1700);
  if (cycle !== this.receiveCycle) { this.receiveCycle = cycle; this.receiveAngle = random(-1.25 * Math.PI, 0.25 * Math.PI); }
  const phase = (((elapsed / 1700) % 1) + 1) % 1;
  const travel = clamp(phase / 0.6, 0, 1);
  const eased = 1 - (1 - travel) ** 3;
  const radius = 108 * (1 - eased);
  const orbit = 18 * Math.sin(travel * Math.PI) * (1 - 0.7 * eased);
  const cosine = Math.cos(this.receiveAngle || 0);
  const sine = Math.sin(this.receiveAngle || 0);
  const part = this.parts[0];
  if (travel < 1) { part.hidden = false; part.setAttribute("cx", (HEAD_C + cosine * radius - sine * orbit).toFixed(1)); part.setAttribute("cy", (HEAD_C + sine * radius + cosine * orbit).toFixed(1)); part.setAttribute("r", (3.5 + 6.5 * eased).toFixed(2)); part.setAttribute("opacity", (cubicOut(amount) * clamp(3.5 * travel, 0, 1) * (0.3 + 0.7 * eased)).toFixed(3)); }
  const ringPhase = clamp((phase - 0.58) / 0.32, 0, 1);
  if (ringPhase > 0 && ringPhase < 1) { const ring = this.rings[1]; ring.hidden = false; ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--fg)"); ring.setAttribute("r", (20 + 26 * cubicOut(ringPhase)).toFixed(1)); ring.setAttribute("stroke-width", (2.8 * (1 - ringPhase)).toFixed(2)); ring.setAttribute("opacity", (cubicOut(amount) * (1 - ringPhase) * 0.8).toFixed(3)); }
}

export function renderDock(amount, now) {
  const elapsed = (now - this.stateStartedAt) / 1000;
  for (let index = 0; index < 2; index += 1) {
    const part = this.parts[index];
    const phase = clamp((elapsed - (0.2 + 1.3 * index)) / 0.9, 0, 1);
    if (phase <= 0) continue;
    const eased = 1 - (1 - phase) ** 3;
    const angle = 0.0011 * now + index * Math.PI;
    const targetX = HEAD_C + 42 * Math.sin(angle);
    const targetY = HEAD_C + 21 * Math.cos(angle) + 2 * Math.sin(0.003 * now + index);
    const startX = HEAD_C - 120 + 30 * index;
    const startY = HEAD_C + 95;
    part.hidden = false; part.setAttribute("cx", (startX + (targetX - startX) * eased).toFixed(1)); part.setAttribute("cy", (startY + (targetY - startY) * eased).toFixed(1)); part.setAttribute("r", ((7 + 3 * eased) * cubicOut(amount)).toFixed(2)); part.setAttribute("opacity", (cubicOut(amount) * clamp(4 * phase, 0, 1)).toFixed(3));
  }
}

export function pencilPose(now) {
  const elapsed = now - this.stateStartedAt;
  const cycle = (((elapsed / 2500) % 1) + 1) % 1;
  if (cycle < 0.68) { const phase = cycle / 0.68; const envelope = clamp(phase / 0.08, 0, 1) * clamp((1 - phase) / 0.08, 0, 1); return { x: -54 + smoothstep(phase) * 118, y: 26, wiggle: 3.2 * Math.sin(24 * phase) * envelope, rotation: 17 + Math.sin(0.0006 * elapsed), lift: false }; }
  const phase = cubicInOut((cycle - 0.68) / 0.32);
  return { x: 64 - 118 * phase, y: 26 - 20 * Math.sin(phase * Math.PI), wiggle: 0, rotation: 17 - 2 * Math.sin(phase * Math.PI) + Math.sin(0.0006 * elapsed), lift: true };
}

export function renderPencil(amount, now) {
  const pose = this.pencilPose(now);
  const glyph = this.glyphs[0];
  const angle = (pose.rotation - 90) * Math.PI / 180;
  const offsetX = 68 * Math.cos(angle);
  const offsetY = 68 * Math.sin(angle);
  glyph.hidden = false; glyph.setAttribute("d", PENCIL_GLYPH); glyph.setAttribute("fill", "var(--fg)"); glyph.setAttribute("transform", `translate(${(HEAD_C + (pose.x + offsetX) * amount).toFixed(1)} ${(HEAD_C + (pose.y + 0.15 * pose.wiggle + offsetY) * amount).toFixed(1)}) rotate(${(pose.rotation * amount).toFixed(1)}) scale(${cubicOut(amount).toFixed(3)}) translate(${-HEAD_C} ${-HEAD_C})`); glyph.setAttribute("opacity", clamp(1.6 * amount - 0.3, 0, 1).toFixed(3));
  if (amount > 0.6 && !pose.lift) {
    const point = [HEAD_C + pose.x, HEAD_C + pose.y + pose.wiggle + 19];
    const last = this.writingTrail.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 2.4) {
      this.writingTrail.push(point);
      if (this.writingTrail.length > 64) this.writingTrail.shift();
    } else {
      last[0] = point[0];
      last[1] = point[1];
    }
  }
  else if (this.writingTrail.length) this.writingTrail.splice(0, 2);
  const trail = this.glyphs[1];
  if (this.writingTrail.length >= 2) {
    const points = this.writingTrail;
    let path = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    if (points.length === 2) path += `L${points[1][0].toFixed(1)} ${points[1][1].toFixed(1)}`;
    else {
      for (let index = 0; index < points.length - 1; index += 1) {
        const previous = points[Math.max(index - 1, 0)];
        const point = points[index];
        const next = points[index + 1];
        const after = points[Math.min(index + 2, points.length - 1)];
        const control1X = point[0] + (next[0] - previous[0]) / 6;
        const control1Y = point[1] + (next[1] - previous[1]) / 6;
        const control2X = next[0] - (after[0] - point[0]) / 6;
        const control2Y = next[1] - (after[1] - point[1]) / 6;
        path += `C${control1X.toFixed(1)} ${control1Y.toFixed(1)} ${control2X.toFixed(1)} ${control2Y.toFixed(1)} ${next[0].toFixed(1)} ${next[1].toFixed(1)}`;
      }
    }
    trail.hidden = false;
    trail.setAttribute("fill", "none");
    trail.setAttribute("stroke", "var(--fg)");
    trail.setAttribute("stroke-width", "6");
    trail.setAttribute("stroke-linecap", "round");
    trail.setAttribute("stroke-linejoin", "round");
    trail.setAttribute("d", path);
    trail.setAttribute("opacity", clamp(1.2 * amount, 0, 1).toFixed(3));
  }
  return { x: pose.x, y: pose.y + 0.5 * pose.wiggle, rotation: pose.rotation, scale: 1, opacityLoss: 0 };
}

export function renderBang(amount, now) {
  const glyph = this.glyphs[2];
  const elapsed = (now - this.stateStartedAt) / 1000;
  const enter = cubicOut(clamp(1.1 * amount, 0, 1));
  const shake = 2.2 * Math.sin(42 * elapsed) * Math.exp(-((elapsed % 2.2) * 5.5));
  glyph.hidden = false; glyph.setAttribute("d", ALERT_GLYPH); glyph.setAttribute("fill", "var(--fg)"); glyph.setAttribute("transform", `translate(0 ${(-26 - (1 - enter) * 70).toFixed(1)}) rotate(${shake.toFixed(2)} ${HEAD_C} ${(HEAD_C - 74).toFixed(1)}) translate(${HEAD_C} ${HEAD_C}) scale(${clamp(1.2 * amount, 0, 1).toFixed(3)}) translate(${-HEAD_C} ${-HEAD_C})`); glyph.setAttribute("opacity", clamp(1.5 * amount - 0.2, 0, 1).toFixed(3));
  return { x: 0, y: 58, rotation: 0, scale: 1, opacityLoss: 0 };
}

export function renderStandby(amount, now) {
  const glow = this.parts[4];
  const pulse = 0.5 + 0.5 * Math.sin(0.0016 * now);
  glow.hidden = false; glow.setAttribute("cx", HEAD_C); glow.setAttribute("cy", HEAD_C); glow.setAttribute("r", (26 + 7 * pulse).toFixed(1)); glow.setAttribute("opacity", (cubicOut(amount) * (0.06 + 0.1 * pulse)).toFixed(3));
  if (amount < 0.995) { const ring = this.rings[2]; ring.hidden = false; ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--fg)"); ring.setAttribute("r", (104 - 88 * cubicOut(amount)).toFixed(1)); ring.setAttribute("stroke-width", "2.4"); ring.setAttribute("opacity", ((1 - cubicOut(amount)) * 0.5).toFixed(3)); }
}
