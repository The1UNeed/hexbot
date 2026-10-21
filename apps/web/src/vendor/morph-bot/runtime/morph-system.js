import { MORPH_IDS } from "../catalog.js";
import { clamp } from "./math.js";

const REDUCE_MOTION = typeof globalThis.matchMedia === "function"
  ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

export function getMorphPhase() {
  if (this.morphPreview) return this.morphPreview.phase.toUpperCase();
  if (this.oneShotResting) return "REST";
  if (this.morph.target > 0.5) return this.morph.x < 0.996 ? "ENTER" : "HOLD";
  if (this.morph.x > 0.004) return "EXIT";
  return "IDLE";
}

export function triggerMorphPreview(effect, duration = 2500) {
  if (!MORPH_IDS.includes(effect)) return false;
  this.morphPreview = {
    effect,
    duration: clamp(Number(duration) || 2500, 100, 20000),
    phase: "reset",
    phaseStartedAt: this.clockTime,
  };
  this.oneShotResting = false;
  return true;
}

export function clearMorphPreview() {
  this.morphPreview = null;
}

export function updateMorph(now, config) {
  let requestedEffect = config.morph === "none" ? null : config.morph;
  if (this.morphPreview) {
    const preview = this.morphPreview;
    if (preview.phase === "reset") {
      requestedEffect = null;
      if (this.morph.x < 0.004) {
        preview.phase = "enter";
        preview.phaseStartedAt = now;
        requestedEffect = preview.effect;
      }
    } else if (preview.phase === "enter") {
      requestedEffect = preview.effect;
      if (this.morph.x > 0.996) {
        preview.phase = "hold";
        preview.phaseStartedAt = now;
      }
    } else if (preview.phase === "hold") {
      requestedEffect = preview.effect;
      if (now - preview.phaseStartedAt >= preview.duration) {
        preview.phase = "exit";
        preview.phaseStartedAt = now;
        requestedEffect = null;
      }
    } else if (preview.phase === "exit") {
      requestedEffect = null;
      if (this.morph.x < 0.004) {
        preview.phase = "done";
        preview.phaseStartedAt = now;
      }
    } else requestedEffect = null;
  }
  if (requestedEffect !== this.requestedMorphEffect) {
    this.requestedMorphEffect = requestedEffect;
    this.morphShotStartedAt = now;
    this.oneShotResting = false;
  }
  let visible = Boolean(requestedEffect);
  if (!this.morphPreview && (this.state === "progress" || this.state === "spawning") && requestedEffect) {
    const shot = this.state === "progress" ? 2500 : 2000;
    if (!this.oneShotResting && now - this.morphShotStartedAt > shot) {
      this.oneShotResting = true;
      this.morphRestStartedAt = now;
    } else if (this.oneShotResting && now - this.morphRestStartedAt > 1500) {
      this.oneShotResting = false;
      this.morphShotStartedAt = now;
    }
    visible = !this.oneShotResting;
  }
  this.morph.target = visible ? 1 : 0;

  if (requestedEffect && requestedEffect !== this.morphEffect) {
    if (this.morphEffect && this.morph.x > 0.02) {
      this.previousMorphEffect = this.morphEffect;
      this.morphBlend.x = 0;
      this.morphBlend.v = 0;
      this.morphBlend.target = 1;
    } else {
      this.previousMorphEffect = null;
      this.morphBlend.x = 1;
      this.morphBlend.v = 0;
      this.morphBlend.target = 1;
    }
    this.morphEffect = requestedEffect;
    this.morphStartedAt = now;
  }

  // Preserve the outgoing geometry until its spring reaches the base character.
  if (!requestedEffect && this.morph.x < 0.004) {
    this.morphEffect = null;
    this.previousMorphEffect = null;
    this.morphBlend.x = 1;
    this.morphBlend.v = 0;
    this.morphBlend.target = 1;
  }
  if (this.previousMorphEffect && this.morphBlend.x > 0.996) this.previousMorphEffect = null;

  if (visible !== this.morphVisible) {
    if (visible && !REDUCE_MOTION.matches) this.turnDirection = Math.random() < 0.5 ? 1 : -1;
    if (!REDUCE_MOTION.matches) this.turn.target += Math.PI * this.turnDirection;
    this.morphVisible = visible;
  }
}
