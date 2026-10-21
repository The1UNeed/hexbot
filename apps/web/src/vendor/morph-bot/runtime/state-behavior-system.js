import { SHAPES } from "../original-data.js";
import { lerpFace, lerpRing } from "./geometry.js";
import { clamp, cubicInOut, random } from "./math.js";

const REDUCE_MOTION = typeof globalThis.matchMedia === "function"
  ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

export function updateStateTargets(now, config, delta) {
  const elapsed = (now - this.stateStartedAt) / 1000;
  const runtime = (now - this.startedAt) / 1000;
  const motion = config.motionScale;
  let eyeOpen = 1;
  let eyeScale = 1;
  let rotation = 0;
  let x = 0;
  let y = 0;
  let scaleY = 1;
  const gesture = REDUCE_MOTION.matches ? this.emptyGesture() : this.updateGestures(now);

  if (REDUCE_MOTION.matches) {
    this.setExpression(config.expressionPool[0] ?? 0);
  } else {
    switch (this.state) {
      case "sleeping": {
        if (config.expressionPool.includes(this.expressionIndex)) eyeOpen = this.expressionSpring.x > 0.85 ? 1 : 0.08;
        else if (elapsed < 1.2) eyeOpen = Math.max(0.08, 1 - Math.min(1, elapsed) * (1 + 0.15 * Math.sin(6.5 * elapsed)));
        else { eyeOpen = 0.08; if (this.eyeOpen.x < 0.18) this.setExpression(13, 11); }
        const settle = Math.min(elapsed / 2, 1);
        const dip = Math.sin(clamp(elapsed / 0.5, 0, 1) * Math.PI);
        rotation = 4 * settle + 2 * Math.sin(0.25 * runtime);
        x = -2 * settle;
        y = 8 * settle + 3 * Math.sin(0.55 * runtime) - 5 * dip;
        scaleY = 1 + 0.016 * Math.sin(0.55 * runtime) + 0.05 * dip;
        break;
      }
      case "waking":
        if (elapsed < 0.5) { eyeOpen = 0.07; this.setExpression(3, 12); y = 6; }
        else if (elapsed < 1.2) {
          eyeOpen = 1; eyeScale = 1.12; y = -5; scaleY = 1.04;
          if (!this.wakeBurst) { this.particles.burst(Math.round(random(9, 13)), 0.8); this.wakeBurst = true; }
        } else if (elapsed < 2.2) {
          if (!this.blinkQueue.length && elapsed < 1.4) this.scheduleBlink(now);
          this.setExpression(0);
        }
        else { const settle = Math.min((elapsed - 2.2) / 0.8, 1); rotation = 6 * Math.sin(settle * Math.PI * 3) * (1 - settle); y = 2 * Math.sin(0.9 * runtime); }
        break;
      case "idle":
        rotation = 1.5 * Math.sin(0.5 * runtime) + 0.6 * Math.sin(0.17 * runtime);
        x = Math.sin(0.27 * runtime); y = 1.2 * Math.sin(0.85 * runtime); scaleY = 1 + 0.007 * Math.sin(0.85 * runtime);
        break;
      case "listening":
        rotation = 8 + 1.5 * Math.sin(0.5 * runtime); x = 2; y = -2 + 0.8 * Math.sin(0.8 * runtime); scaleY = 1.015;
        if (now >= this.listenNodNext) { this.listenNodUntil = now + 380; this.listenNodNext = now + random(1800, 3200); }
        if (now < this.listenNodUntil) { const phase = 1 - (this.listenNodUntil - now) / 380; y += 4.5 * Math.sin(phase * Math.PI); rotation += 2 * Math.sin(phase * Math.PI); }
        break;
      case "thinking":
        rotation = -9 + 5 * Math.sin(0.35 * runtime); x = 5 * Math.sin(0.3 * runtime); y = 2.5 * Math.sin(0.6 * runtime);
        break;
      case "searching": { const wave = Math.sin(1.3 * runtime); rotation = 13 * wave; x = 7 * wave; y = 3 * Math.sin(1.7 * runtime); break; }
      case "working": { const wave = Math.sin(runtime * Math.PI * 3.2); rotation = 4 + 2.5 * wave; x = 3; y = 1.5 + 3 * Math.max(0, wave); scaleY = 1 - 0.02 * Math.max(0, wave); break; }
      case "excited": { const phase = (2.2 * runtime) % 1; y = -10 * Math.sin(phase * Math.PI) + 2; scaleY = phase < 0.1 ? 0.92 : phase < 0.3 ? 1.05 : 1; x = 4 * Math.sin(1.1 * runtime); eyeScale = 1.06; rotation = 7 * Math.sin(runtime * Math.PI * 2.2); break; }
      case "surprised": { const settle = Math.min(elapsed / 1.2, 1); x = -4 * (1 - settle); y = -8 * (1 - settle); scaleY = elapsed < 0.2 ? 1.08 : 1; eyeScale = 1.15 - 0.08 * settle; rotation = 1.5 * Math.sin(11 * runtime) * (1 - settle); break; }
      case "suspicious":
        rotation = -6 + 3 * Math.sin(0.3 * runtime); x = -4 * Math.sin(0.25 * runtime); y = 1 + 1.2 * Math.sin(0.45 * runtime); eyeOpen = 0.85;
        if (now >= this.impulseNext) { this.rotation.v += 30 * Math.PI / 180; this.impulseNext = now + random(4000, 7000); }
        break;
      case "angry":
        if (now >= this.impulseNext) { this.impulseUntil = now + 420; this.headY.v += 70; this.impulseNext = now + random(1800, 3200); }
        rotation = now < this.impulseUntil ? 4.5 * Math.sin(0.05 * now) : 0; y = 3.5; scaleY = 0.975;
        break;
      case "drowsy":
        rotation = 2.5 * Math.sin(0.32 * runtime); x = 1.5 * Math.sin(0.2 * runtime); y = 6 + 2.2 * Math.sin(0.36 * runtime); scaleY = 1 + 0.022 * Math.sin(0.36 * runtime); eyeOpen = 0.34 + 0.07 * Math.sin(0.8 * runtime);
        if (now >= this.listenNodNext && !this.drowsyStartedAt) this.drowsyStartedAt = now;
        if (this.drowsyStartedAt) {
          const phase = (now - this.drowsyStartedAt) / 1000;
          if (phase < 1.7) { const progress = phase / 1.7; const squared = progress ** 2; y = 6 + 19 * squared + 2.2 * Math.sin(progress * Math.PI * 2.5) * (1 - progress); rotation = 10 * squared; eyeOpen = 0.34 - squared * 0.3; scaleY = 1 - 0.045 * squared; }
          else if (phase < 2) { const rebound = Math.sin((phase - 1.7) / 0.3 * Math.PI); y = 25 - 7 * rebound; rotation = 10 - 4 * rebound; eyeOpen = 0.04 + 0.42 * rebound; }
          else if (phase < 3.5) { const progress = (phase - 2) / 1.5; const recovery = 1 - (1 - progress) ** 2.2; y = 25 - 19 * recovery; rotation = 10 * (1 - recovery); eyeOpen = 0.46 - 0.12 * recovery; if (progress > 0.32 && progress < 0.46) eyeOpen = 0.05; }
          else { this.drowsyStartedAt = 0; this.listenNodNext = now + random(1500, 3500); }
        }
        break;
      case "happy": { const wave = Math.sin(2.4 * runtime); rotation = 3 * Math.sin(1.2 * runtime); x = 2.5 * Math.sin(1.1 * runtime); y = -3 * Math.abs(wave); scaleY = 1 + 0.02 * wave; eyeScale = 1.05; break; }
      case "curious":
        rotation = 10 + 6 * Math.sin(0.7 * runtime); x = 5 * Math.sin(0.6 * runtime); y = -2 + 1.5 * Math.sin(0.9 * runtime); scaleY = 1.01; eyeScale = 1.08;
        if (now >= this.listenNodNext) { this.listenNodUntil = now + 440; this.listenNodNext = now + random(1600, 2800); }
        if (now < this.listenNodUntil) { const phase = 1 - (this.listenNodUntil - now) / 440; x += 8 * Math.sin(phase * Math.PI); rotation += 5 * Math.sin(phase * Math.PI); }
        break;
      case "confused": { const wave = Math.sin(0.8 * runtime); rotation = 12 * wave; x = 3 * wave; y = 2 * Math.sin(0.5 * runtime); eyeOpen = 0.9; if (now >= this.impulseNext) { this.rotation.v += 22 * Math.PI / 180; this.impulseNext = now + random(2600, 4200); } break; }
      case "bored":
        rotation = -3 + 4 * Math.sin(0.25 * runtime); x = 4 * Math.sin(0.2 * runtime); y = 5 + 1.5 * Math.sin(0.35 * runtime); scaleY = 0.99; eyeOpen = 0.6; eyeScale = 0.98;
        if (now >= this.impulseNext) { this.impulseUntil = now + 600; this.impulseNext = now + random(4000, 7000); }
        if (now < this.impulseUntil) { const phase = 1 - (this.impulseUntil - now) / 600; scaleY = 1 + 0.05 * Math.sin(phase * Math.PI); y += 3 * Math.sin(phase * Math.PI); }
        break;
      case "proud": rotation = 2.5 * Math.sin(0.4 * runtime); x = 2 * Math.sin(0.35 * runtime); y = -4 + Math.sin(0.6 * runtime); scaleY = 1.03; eyeScale = 1.02; eyeOpen = 0.9; break;
      case "shy": rotation = -8 + 3 * Math.sin(0.5 * runtime); x = -3 + 2 * Math.sin(0.4 * runtime); y = 3; scaleY = 0.98; eyeScale = 0.95; eyeOpen = 0.85; break;
      case "sad": rotation = 3 + 2 * Math.sin(0.3 * runtime); x = 1.5 * Math.sin(0.25 * runtime); y = 7 + Math.sin(0.4 * runtime); scaleY = 0.97; eyeScale = 0.97; eyeOpen = 0.7; break;
      case "laughing": { const wave = Math.sin(runtime * Math.PI * 6.4); rotation = 4 * wave; x = 2 * Math.sin(2 * runtime); y = -5 * Math.abs(wave); scaleY = 1 + 0.03 * wave; eyeOpen = 0.7; break; }
      case "scared": rotation = 2 * Math.sin(0.04 * now); x = -2 + 1.5 * Math.sin(0.05 * now); y = 2 + Math.sin(1.5 * runtime); scaleY = 0.97; eyeScale = 1.12; eyeOpen = 1.05; break;
      case "playful": rotation = 8 * Math.sin(1.4 * runtime); x = 4 * Math.sin(1.1 * runtime); y = -3 * Math.abs(Math.sin(2.2 * runtime)); scaleY = 1 + 0.015 * Math.sin(2.2 * runtime); eyeScale = 1.06; break;
      case "celebrate": {
        y = -2.5 * Math.abs(Math.sin(1.6 * runtime)); eyeScale = 1.1; eyeOpen = 1.1;
        const wild = this.celebratePose(elapsed);
        Object.assign(gesture, wild);
        break;
      }
      case "dragging": { const phase = (elapsed % 3.4) / 3.4; const cycle = Math.floor(elapsed / 3.4); if (phase < 0.12) { x = -16; y = -22; rotation = -5; } else if (phase < 0.62) { x = -16 + 32 * cubicInOut((phase - 0.12) / 0.5); y = -22 + 2 * Math.sin(1.4 * runtime); rotation = 6 * Math.sin(2.6 * runtime); eyeScale = 1.06; } else { if (cycle !== this.dragCycle) { this.dragCycle = cycle; this.headY.v += 90; } x = 16; } break; }
      case "humming": rotation = 2 * Math.sin(0.4 * runtime); x = 1.5 * Math.sin(0.3 * runtime); y = 1.5 * Math.sin(0.7 * runtime); break;
      case "notifying": if (!this.notifyTriggered && elapsed > 0.12) { this.notifyTriggered = true; this.headY.v -= 26; this.scheduleBlink(now); } eyeScale = 1 + 0.05 * Math.exp(-3 * elapsed); rotation = 3; x = 2; y = -1; break;
      default: break;
    }

    var blinkOverride = this.updateExpressionAndBlink(now, config);
    this.updateAim(now, config);
  }

  if (gesture.eyeOpen !== null) eyeOpen = gesture.eyeOpen;
  if (gesture.eyeScale !== null) eyeScale = gesture.eyeScale;
  this.directTurn = gesture.turn;
  this.directRotation = gesture.rotation;
  this.directX = gesture.x;
  this.directY = gesture.y + gesture.bounceY;
  this.directGazeX = gesture.gazeX;
  this.directGazeY = gesture.gazeY;

  this.rotation.target = (rotation * motion + config.headRotation) * Math.PI / 180;
  this.headX.target = x * motion + config.headX;
  this.headY.target = y * motion + config.headY;
  this.scaleY.target = scaleY * config.scaleY;
  this.eyeOpen.target = (blinkOverride ?? eyeOpen) * config.eyeOpen;
  this.eyeScale.target = eyeScale * config.eyeScale;
  this.notify.target = this.state === "notifying" ? 1 : 0;
  this.humming.target = this.state === "humming" ? 1 : 0;

  if ((this.state === "humming" || this.state === "loading") && !REDUCE_MOTION.matches) {
    const speed = elapsed < 0.5 ? 7 * cubicInOut(elapsed / 0.5) : elapsed < 1.3 ? 7 + ((this.state === "loading" ? 3 : 1.6) - 7) * cubicInOut((elapsed - 0.5) / 0.8) : (this.state === "loading" ? 3 : 1.6) + 0.3 * Math.sin(0.5 * elapsed);
    this.spinAngle += speed * delta;
  } else if (this.state !== "celebrate") this.spinAngle *= 0.94;
}

export function updateExpressionAndBlink(now, config) {
  if (this.state !== "waking" && this.state !== "sleeping" && now >= this.expressionNext) {
    const pool = config.expressionPool;
    if (pool.length) {
      const weights = config.expressionWeights || {};
      const customWeights = pool.some((index) => Math.abs((Number(weights[index]) || 1) - 1) > 0.0001);
      if (customWeights && pool.length > 1) {
        const candidates = pool.map((index, position) => ({ position, weight: Math.max(0.01, Number(weights[index]) || 1) }))
          .filter((candidate) => candidate.position !== this.expressionCursor);
        const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
        let pick = Math.random() * total;
        this.expressionCursor = candidates[candidates.length - 1].position;
        for (const candidate of candidates) {
          pick -= candidate.weight;
          if (pick <= 0) { this.expressionCursor = candidate.position; break; }
        }
      } else {
        this.expressionCursor = (this.expressionCursor + 1 + Math.floor(random(0, Math.max(pool.length - 1, 1)))) % pool.length;
      }
      this.setExpression(pool[this.expressionCursor], this.state === "searching" || this.state === "excited" ? 10 : 6);
    }
    this.expressionNext = now + random(config.expressionCadence[0], config.expressionCadence[1]) * config.tempo;
  }
  if (config.blinkCadence && now >= this.blinkNext) {
    this.scheduleBlink(now);
    this.blinkNext = now + random(config.blinkCadence[0], config.blinkCadence[1]) * config.tempo;
  }
  while (this.blinkQueue.length && now >= this.blinkQueue[0].at) this.blinkTarget = this.blinkQueue.shift().value;
  if (this.blinkQueue.length) return this.blinkTarget;
  if (this.blinkTarget !== null) {
    const finalValue = this.blinkTarget;
    this.blinkTarget = null;
    return finalValue;
  }
  return null;
}

export function updateAim(now, config) {
  if (now < this.gazeNext) return;
  const direction = () => Math.random() < 0.5 ? -1 : 1;
  let x = 0;
  let y = 0;
  let min = 2500;
  let max = 5000;
  switch (this.state) {
    case "idle": min = 2500; max = 5500; break;
    case "listening": x = 15 * random(-0.3, 0.3); y = 9 * random(-0.25, 0.25); min = 2200; max = 4200; break;
    case "thinking": x = direction() * random(0.5, 1) * 15; y = -9 * random(0.4, 1); min = 1500; max = 2800; break;
    case "searching": x = direction() * random(0.7, 1) * 15; y = 9 * random(-1, 1); min = 550; max = 1150; break;
    case "working": x = 15 * random(-0.4, 0.4); y = 9 * random(0.4, 1); min = 1200; max = 2400; break;
    case "excited": x = 15 * random(-1, 1); y = 9 * random(-1, 0.3); min = 700; max = 1400; break;
    case "surprised": min = 1600; max = 2600; break;
    case "suspicious": x = 15 * direction(); y = 2.7; min = 2200; max = 4200; break;
    case "angry": x = 15 * random(-0.2, 0.2); y = 1.8; min = 1800; max = 3200; break;
    case "drowsy": x = 15 * random(-0.4, 0.4); y = 9 * random(0.4, 1); min = 2500; max = 4500; break;
    case "happy": x = 15 * random(-0.7, 0.7); y = -9 * random(0, 0.6); min = 1800; max = 3400; break;
    case "curious": x = direction() * random(0.6, 1) * 15; y = 9 * random(-1, 1); min = 950; max = 1900; break;
    case "confused": x = direction() * random(0.5, 1) * 15; y = 9 * random(-0.6, 1); min = 1100; max = 2300; break;
    case "bored": x = direction() * random(0.7, 1) * 15; y = 9 * random(0.4, 0.9); min = 3000; max = 6000; break;
    case "proud": x = 15 * random(-0.3, 0.3); y = -9 * random(0.3, 0.7); min = 2600; max = 4600; break;
    case "shy": x = direction() * random(0.6, 1) * 15; y = 9 * random(0.5, 1); min = 2000; max = 4000; break;
    case "sad": x = 15 * random(-0.3, 0.3); y = 9 * random(0.6, 1); min = 2800; max = 5000; break;
    case "laughing": x = 15 * random(-0.5, 0.5); y = -9 * random(0.2, 0.6); min = 800; max = 1700; break;
    case "scared": x = direction() * random(0.7, 1) * 15; y = 9 * random(-0.6, 0.6); min = 450; max = 1050; break;
    case "playful": x = direction() * random(0.5, 1) * 15; y = -9 * random(0, 0.6); min = 900; max = 1800; break;
    case "notifying": { const focused = Math.random() < 0.72; x = (focused ? 0.45 : 0.1) * 15; y = -9 * (focused ? 0.3 : 0.05); min = 1200; max = 2400; break; }
    default: x = 15 * random(-0.4, 0.4); y = 9 * random(-0.3, 0.3);
  }
  this.aimX.target = x * config.gazeScale;
  this.aimY.target = y * config.gazeScale;
  this.gazeNext = now + random(min, max) * config.tempo;
}

export function emptyGesture() {
  return { turn: 0, rotation: 0, x: 0, y: 0, bounceY: 0, gazeX: 0, gazeY: 0, eyeOpen: null, eyeScale: null };
}

export function startSpin(turns = 1, direction = Math.random() < 0.5 ? 1 : -1) {
  if (this.spinSpring) return false;
  this.spinSpring = { x: 0, v: 0, target: turns * Math.PI * 2 * direction };
  return true;
}

export function startGesture(kind) {
  if (this.gesture || this.spinSpring) return;
  const turns = kind === "spinDizzy" ? Math.round(random(3, 4)) : 1;
  this.gesture = { kind, startedAt: this.clockTime, direction: Math.random() < 0.5 ? 1 : -1, turns };
}

export function startBounce(now) {
  if (this.bounceStartedAt < 0) this.bounceStartedAt = now;
}

export function updateGestures(now) {
  const output = this.emptyGesture();
  if (["idle", "happy", "excited", "curious", "playful"].includes(this.state) && now >= this.winkNext) {
    this.winkAt = now;
    this.winkEye = Math.random() < 0.5 ? 0 : 1;
    this.winkNext = now + random(4500, 10000);
  }
  if (now >= this.behaviorNext && !this.gesture && !this.spinSpring) {
    if (this.state === "searching") { this.startSpin(); this.behaviorNext = now + random(4000, 7000); }
    else if (this.state === "working") { this.startSpin(1, 1); this.behaviorNext = now + random(6000, 9000); }
    else if (this.state === "excited") { this.startSpin(1); this.behaviorNext = now + random(2800, 5000); }
    else if (this.state === "playful") { this.startSpin(1); this.behaviorNext = now + random(3500, 6000); }
  }
  if (now >= this.ambientNext) {
    if (!this.gesture && !this.spinSpring) {
      const roll = Math.random();
      if (["happy", "excited", "proud"].includes(this.state)) roll < 0.55 ? this.startSpin(1) : this.startGesture("spinBounce");
      else if (this.state === "playful") {
        if (roll < 0.34) this.startGesture("spinBounce");
        else if (roll < 0.62) this.startBounce(now);
        else if (roll < 0.86) this.startGesture("spinDizzy");
        else this.startSpin(1);
      }
    }
    this.ambientNext = now + random(9000, 18000);
  }
  if (this.gesture) {
    const elapsed = (now - this.gesture.startedAt) / 1000;
    const { kind, direction, turns } = this.gesture;
    if (kind === "spinBounce") {
      if (elapsed < 0.7) output.turn = turns * Math.PI * 2 * direction * cubicInOut(elapsed / 0.7);
      else { this.startBounce(now); this.gesture = null; }
    } else if (kind === "spinDizzy") {
      const spinDuration = 0.55 + 0.16 * turns;
      if (elapsed < spinDuration) output.turn = turns * Math.PI * 2 * direction * (elapsed / spinDuration) ** 2;
      else if (elapsed < spinDuration + 1.5) {
        const shakeTime = elapsed - spinDuration;
        const envelope = (1 - shakeTime / 1.5) ** 1.3;
        output.rotation = 17 * Math.sin(10 * shakeTime) * direction * envelope;
        output.x = 10 * Math.cos(10 * shakeTime) * direction * envelope;
        output.y = 3 * Math.sin(20 * shakeTime) * envelope;
        output.eyeOpen = 0.46 + 0.14 * Math.sin(21 * shakeTime);
        output.eyeScale = 1.03;
      } else this.gesture = null;
    }
  }
  if (this.bounceStartedAt >= 0) {
    const sequence = [{ h: 48, d: 0.5 }, { h: 28, d: 0.382 }, { h: 14, d: 0.27 }, { h: 6, d: 0.177 }];
    let elapsed = (now - this.bounceStartedAt) / 1000;
    let step = 0;
    while (step < sequence.length && elapsed >= sequence[step].d) { elapsed -= sequence[step].d; step += 1; }
    if (step >= sequence.length) this.bounceStartedAt = -1;
    else { const phase = elapsed / sequence[step].d; output.bounceY = -4 * sequence[step].h * phase * (1 - phase); }
  }
  return output;
}

export function celebratePose(elapsed) {
  const output = this.emptyGesture();
  this.celebrateWildActive = false;
  const activeElapsed = elapsed - 0.14;
  if (activeElapsed < 0) return output;
  const cycleIndex = Math.floor(activeElapsed / 6.2);
  if (cycleIndex !== this.celebrateCycle) {
    this.celebrateCycle = cycleIndex;
    this.turnDirection = Math.random() < 0.5 ? 1 : -1;
  }
  const cycle = activeElapsed % 6.2;
  if (cycle > 5.49 || REDUCE_MOTION.matches) return output;
  this.celebrateWildActive = true;
  const turns = 9;
  const direction = this.turnDirection;
  const speed = (turns * Math.PI * 2 + 0.5) / (0.15 + 2 + 0.3125);
  let angle;
  if (cycle < 0.24) angle = -0.25 * (1 - Math.cos(cycle / 0.24 * Math.PI));
  else if (cycle < 0.54) { const time = cycle - 0.24; angle = -0.5 + speed * time ** 2 / 0.6; }
  else if (cycle < 2.54) angle = -0.5 + speed * (0.15 + cycle - 0.54);
  else if (cycle < 3.79) angle = -0.5 + speed * 2.15 + 1.25 * speed * (1 - (1 - (cycle - 2.54) / 1.25) ** 4) / 4;
  else angle = turns * Math.PI * 2;
  output.turn = angle * direction;
  let envelope = 0;
  if (cycle > 2.54) {
    const progress = Math.min((cycle - 2.54) / 1.25, 1);
    envelope = progress < 0.4 ? 0 : ((progress - 0.4) / 0.6) ** 2;
    if (cycle >= 3.79) envelope = Math.max(0, (1 - (cycle - 3.79) / 1.7) ** 1.6);
  }
  const shakeTime = Math.max(cycle - 2.54, 0);
  output.rotation = angle / (turns * Math.PI * 2) * 1080 * direction + 11 * Math.sin(9.2 * shakeTime) * direction * envelope;
  output.x = (Math.cos(9.2 * shakeTime) - 1) * 6 * direction * envelope;
  output.y = 2.6 * Math.sin(18.4 * shakeTime) * envelope;
  output.gazeX = 13 * Math.sin(11.5 * shakeTime) * direction * envelope;
  output.gazeY = (Math.cos(9 * shakeTime) - 1) * 3.5 * envelope;
  output.eyeOpen = 1.14 - 0.44 * envelope + 0.1 * Math.sin(16 * shakeTime) * envelope;
  output.eyeScale = 1.12 - 0.09 * envelope;
  return output;
}

export function triggerShapeChangeMotion() {
  if (REDUCE_MOTION.matches) return;
  this.shapeChangeCycle = (this.shapeChangeCycle + 1) % 5;
  if (this.shapeChangeCycle === 0) this.startSpin(1);
  else if (this.shapeChangeCycle === 1) this.shapeChangeWide = this.startSpin(2);
  else if (this.shapeChangeCycle === 2) this.startGesture("spinBounce");
  else if (this.shapeChangeCycle === 3) this.startGesture("spinDizzy");
  else {
    this.startSpin(1);
    this.particles.burst(16, 0.95, 0.3);
  }
}

export function resolveShape(shapeId) {
  const requestedId = SHAPES[shapeId] ? shapeId : "blob";
  if (requestedId !== this.shapeId) {
    const previous = SHAPES[this.shapeId];
    const currentAmount = cubicInOut(clamp(this.shapeBlend.x, 0, 1));
    this.shapeFromRing = currentAmount >= 1
      ? previous.ring
      : lerpRing(this.shapeFromRing, previous.ring, currentAmount);
    this.shapeFromFace = currentAmount >= 1
      ? previous.face
      : lerpFace(this.shapeFromFace, previous.face, currentAmount);
    this.shapeFromTiltScale += (previous.tiltScale - this.shapeFromTiltScale) * currentAmount;
    this.shapeFromBeltRadius += (previous.beltRadius - this.shapeFromBeltRadius) * currentAmount;
    this.shapeId = requestedId;
    this.shapeBlend.x = 0;
    this.shapeBlend.v = 0;
    this.shapeBlend.target = 1;
    this.triggerShapeChangeMotion();
  }

  const shape = SHAPES[this.shapeId];
  const amount = cubicInOut(clamp(this.shapeBlend.x, 0, 1));
  const transitioning = amount < 0.999;
  return {
    shape,
    transitioning,
    ring: transitioning ? lerpRing(this.shapeFromRing, shape.ring, amount) : shape.ring,
    face: transitioning ? lerpFace(this.shapeFromFace, shape.face, amount) : shape.face,
    tiltScale: transitioning
      ? this.shapeFromTiltScale + (shape.tiltScale - this.shapeFromTiltScale) * amount
      : shape.tiltScale,
    beltRadius: transitioning
      ? this.shapeFromBeltRadius + (shape.beltRadius - this.shapeFromBeltRadius) * amount
      : shape.beltRadius,
  };
}
