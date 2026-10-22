import { clamp } from "./math.js";

export function advanceSimulationClock(realNow) {
  const realDelta = Math.min(Math.max((realNow - this.lastTime) / 1000, 0), 0.1);
  this.lastTime = realNow;
  let delta = this.paused ? 0 : realDelta * this.playbackRate;
  if (this.pendingStep > 0) {
    delta = this.pendingStep;
    this.pendingStep = 0;
  }
  this.clockTime += delta * 1000;
  this.delta = delta;
  return { now: this.clockTime, delta };
}

export function setPlaybackRate(rate) {
  const numeric = Number(rate);
  this.playbackRate = Number.isFinite(numeric) ? clamp(numeric, 0.1, 4) : 1;
  return this.playbackRate;
}

export function setPaused(paused) {
  this.paused = Boolean(paused);
  return this.paused;
}

export function stepFrame(seconds = 1 / 60) {
  this.paused = true;
  this.pendingStep += Math.max(0, Number(seconds) || 1 / 60);
}
