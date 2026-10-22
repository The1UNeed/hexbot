import { FIXED_STEP, stepSpring } from "./math.js";

export function stepPhysics(delta, reducedMotion = false) {
  // Hexbot pauses reduced-motion faces after drawing, so every spring must
  // reach its target in this frame rather than stop partway through easing.
  if (reducedMotion) {
    for (const spring of [
      this.expressionSpring, this.rotation, this.headX, this.headY, this.scaleY,
      this.eyeOpen, this.eyeScale, this.aimX, this.aimY, this.morph,
      this.morphBlend, this.shapeBlend, this.turn, this.notify, this.humming,
      this.spinSpring,
    ]) {
      if (!spring) continue;
      spring.x = spring.target;
      spring.v = 0;
    }
    return;
  }
  const steps = Math.max(1, Math.ceil(delta / FIXED_STEP));
  const step = delta / steps;
  for (let index = 0; index < steps; index += 1) {
    stepSpring(this.expressionSpring, this.expressionFrequency, 1, step);
    stepSpring(this.rotation, 5, 0.9, step);
    stepSpring(this.headX, 3.5, 1, step);
    stepSpring(this.headY, 4, 1, step);
    stepSpring(this.scaleY, 10, 0.8, step);
    stepSpring(this.eyeOpen, 26, 1, step);
    stepSpring(this.eyeScale, 9, 0.85, step);
    stepSpring(this.aimX, 13, 1, step);
    stepSpring(this.aimY, 13, 1, step);
    stepSpring(this.morph, 14, 1, step);
    stepSpring(this.morphBlend, 11, 1, step);
    stepSpring(this.shapeBlend, 10, 1, step);
    stepSpring(this.turn, 14, 1, step);
    stepSpring(this.notify, 9, 0.55, step);
    stepSpring(this.humming, 6, 1, step);
    if (this.spinSpring) stepSpring(this.spinSpring, 6.2, 1, step);
  }
}
