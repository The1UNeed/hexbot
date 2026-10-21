import {
  EXPRESSIONS,
  SHAPES,
} from "./original-data.js";
import { ParticleSystem } from "./runtime/particle-system.js";
import { lerpRing } from "./runtime/geometry.js";
import { clamp, random, springValue } from "./runtime/math.js";
import * as morphSystem from "./runtime/morph-system.js";
import { MaterialSystem } from "./runtime/material-system.js";
import { stepPhysics } from "./runtime/physics-system.js";
import * as simulationClock from "./runtime/simulation-clock.js";
import * as stateBehavior from "./runtime/state-behavior-system.js";
import * as svgRenderer from "./runtime/svg-renderer.js";
import { MORPH_SIZES } from "./runtime/svg-renderer.js";

const REDUCE_MOTION = typeof globalThis.matchMedia === "function"
  ? globalThis.matchMedia("(prefers-reduced-motion: reduce)")
  : { matches: false };

export class GrokBotEngine {
  constructor(svg, getConfig) {
    this.svg = svg;
    this.getConfig = getConfig;
    this.head = svg.querySelector("#head-path");
    this.clipHead = svg.querySelector("#head-clip-path");
    this.transformGroup = svg.querySelector("#bot-transform");
    this.eyes = [...svg.querySelectorAll(".eye-path")];
    this.morphHeads = [...svg.querySelectorAll(".morph-head")];
    this.rings = [...svg.querySelectorAll(".morph-ring")];
    this.parts = [...svg.querySelectorAll(".morph-part")];
    this.glyphs = [...svg.querySelectorAll(".morph-glyph")];
    this.baseMorphLayer = {
      group: null,
      heads: this.morphHeads,
      rings: this.rings,
      parts: this.parts,
      glyphs: this.glyphs,
    };
    this.morphLayers = new Map();
    this.materials = new MaterialSystem(svg, {
      head: this.head,
      transformGroup: this.transformGroup,
      idPrefix: svg.id || "grok-bot",
    });
    this.badge = svg.querySelector("#notify-badge");
    this.currentBeltRadius = SHAPES.blob.beltRadius;
    this.particleSpinAngle = 0;
    this.particles = new ParticleSystem(svg.querySelector("#particles-back"), svg.querySelector("#particles-front"), {
      idPrefix: `${svg.id || "grok-bot"}-`,
      reduceMotion: () => REDUCE_MOTION.matches,
      radius: () => this.currentBeltRadius,
    });
    this.pointer = { active: false, clientX: 0, clientY: 0, x: 0, y: 0, targetX: 0, targetY: 0 };
    this.state = "idle";
    this.startedAt = performance.now();
    this.stateStartedAt = this.startedAt;
    this.lastTime = this.startedAt;
    this.clockTime = this.startedAt;
    this.playbackRate = 1;
    this.paused = false;
    this.pendingStep = 0;
    this.expressionFrom = [EXPRESSIONS[0][0], EXPRESSIONS[0][1]];
    this.expressionTo = this.expressionFrom;
    this.expressionIndex = 0;
    this.expressionSpring = springValue(1);
    this.expressionFrequency = 7;
    this.rotation = springValue(0);
    this.headX = springValue(0);
    this.headY = springValue(0);
    this.scaleY = springValue(1);
    this.eyeOpen = springValue(1);
    this.eyeScale = springValue(1);
    this.aimX = springValue(0);
    this.aimY = springValue(0);
    this.morph = springValue(0);
    this.morphBlend = springValue(1);
    this.shapeBlend = springValue(1);
    this.turn = springValue(0);
    this.notify = springValue(0);
    this.humming = springValue(0);
    this.stateVersion = 0;
    this.requestedMorphEffect = null;
    this.morphEffect = null;
    this.previousMorphEffect = null;
    this.morphVisible = false;
    this.morphStartedAt = this.startedAt;
    this.morphShotStartedAt = this.startedAt;
    this.morphRestStartedAt = 0;
    this.oneShotResting = false;
    this.morphPreview = null;
    this.turnDirection = 1;
    this.spinAngle = 0;
    this.expressionCursor = 0;
    this.expressionNext = 0;
    this.blinkNext = 0;
    this.gazeNext = 0;
    this.blinkQueue = [];
    this.blinkTarget = null;
    this.wakeBurst = false;
    this.drowsyStartedAt = 0;
    this.listenNodUntil = 0;
    this.listenNodNext = 0;
    this.impulseNext = 0;
    this.impulseUntil = 0;
    this.behaviorNext = 0;
    this.winkAt = -Infinity;
    this.winkEye = 0;
    this.winkNext = this.startedAt + random(3000, 8000);
    this.dragCycle = -1;
    this.notifyTriggered = false;
    this.receiveCycle = -1;
    this.receiveAngle = -0.7;
    this.writingTrail = [];
    this.shapeId = SHAPES[getConfig()?.shape] ? getConfig().shape : "blob";
    this.shapeFromRing = SHAPES[this.shapeId].ring;
    this.shapeFromFace = SHAPES[this.shapeId].face;
    this.shapeFromTiltScale = SHAPES[this.shapeId].tiltScale;
    this.shapeFromBeltRadius = SHAPES[this.shapeId].beltRadius;
    this.shapeChangeCycle = Math.floor(random(0, 5));
    this.shapeChangeWide = false;
    this.spinSpring = null;
    this.gesture = null;
    this.bounceStartedAt = -1;
    this.ambientNext = this.startedAt + random(2500, 5000);
    this.celebrateCycle = -1;
    this.celebrateWildActive = false;
    this.directTurn = 0;
    this.directRotation = 0;
    this.directX = 0;
    this.directY = 0;
    this.directGazeX = 0;
    this.directGazeY = 0;
    this.boundFrame = (time) => this.frame(time);
    this.pointerMove = (event) => {
      this.pointer.active = true;
      this.pointer.clientX = event.clientX;
      this.pointer.clientY = event.clientY;
    };
    this.pointerLeave = () => { this.pointer.active = false; };
    window.addEventListener("pointermove", this.pointerMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", this.pointerLeave);
    this.setState("idle", true);
    this.frameId = requestAnimationFrame(this.boundFrame);
  }

  destroy() {
    cancelAnimationFrame(this.frameId);
    window.removeEventListener("pointermove", this.pointerMove);
    document.documentElement.removeEventListener("mouseleave", this.pointerLeave);
    for (const layer of this.morphLayers.values()) layer.group.remove();
    this.materials.destroy();
  }

  setState(state, immediate = false) {
    if (!immediate && state === this.state) return;
    const now = this.clockTime;
    this.state = state;
    this.stateStartedAt = now;
    this.stateVersion += 1;
    const config = this.getConfig();
    this.expressionCursor = 0;
    this.expressionNext = now + random(config.expressionCadence[0], config.expressionCadence[1]) * config.tempo;
    this.blinkNext = now + random(1500, 7000);
    this.gazeNext = now + random(500, 1400);
    this.listenNodNext = now + random(1200, 2200);
    this.impulseNext = now + random(500, 1200);
    this.behaviorNext = now + (
      state === "excited" ? random(400, 1100)
        : state === "searching" ? random(800, 1600)
          : state === "working" ? random(1200, 2400)
            : random(6000, 10000)
    );
    this.winkNext = now + random(3000, 8000);
    this.blinkQueue = [];
    this.blinkTarget = null;
    this.wakeBurst = false;
    this.drowsyStartedAt = 0;
    this.dragCycle = -1;
    this.notifyTriggered = false;
    this.receiveCycle = -1;
    this.writingTrail = [];
    this.oneShotResting = false;
    this.morphPreview = null;
    this.celebrateWildActive = false;
    this.morphShotStartedAt = now;
    if (state === "celebrate") {
      this.turnDirection = Math.random() < 0.5 ? 1 : -1;
      this.celebrateCycle = -1;
    }
    const firstExpression = config.expressionPool[0] ?? 0;
    if (state !== "waking" && state !== "sleeping") {
      if (state !== "drowsy") this.scheduleBlink(now);
      this.setExpression(firstExpression, state === "excited" ? 10 : 8);
    }
  }

  setExpression(index, frequency = 7) {
    if (index === this.expressionIndex && this.expressionSpring.target === 1) return;
    const amount = clamp(this.expressionSpring.x, 0, 1);
    this.expressionFrom = [
      lerpRing(this.expressionFrom[0], this.expressionTo[0], amount),
      lerpRing(this.expressionFrom[1], this.expressionTo[1], amount),
    ];
    this.expressionTo = [EXPRESSIONS[index][0], EXPRESSIONS[index][1]];
    this.expressionIndex = index;
    this.expressionSpring.x = 0;
    this.expressionSpring.v = 0;
    this.expressionSpring.target = 1;
    this.expressionFrequency = frequency;
  }

  scheduleBlink(now) {
    this.blinkTarget = this.eyeOpen.target;
    this.blinkQueue.push(
      { at: now, value: 0.05 },
      { at: now + 70, value: 0.05 },
      { at: now + 150, value: 1.08 },
      { at: now + 300, value: 1 },
    );
    if (Math.random() < 0.14) this.blinkQueue.push({ at: now + 370, value: 0.05 }, { at: now + 480, value: 1 });
  }

  frame(realNow) {
    const { now, delta } = simulationClock.advanceSimulationClock.call(this, realNow);
    const config = this.getConfig();
    this.svg.dataset.state = this.state;
    this.materials.apply(config);
    this.svg.style.setProperty("--bg", config.eyeColor);
    this.svg.style.setProperty("--bot-size", `${config.size}px`);
    this.svg.style.transform = config.flipX ? "scaleX(-1)" : "";
    this.updateMorph(now, config);
    this.updateStateTargets(now, config, delta);
    stepPhysics.call(this, delta, REDUCE_MOTION.matches);
    const rendered = this.render(now, config);
    this.materials.syncHeadPath(rendered?.headPath || this.head.getAttribute("d"), rendered?.rotation || 0);
    if (this.spinSpring && Math.abs(this.spinSpring.target - this.spinSpring.x) < 0.004 && Math.abs(this.spinSpring.v) < 0.015) {
      this.spinSpring = null;
      this.shapeChangeWide = false;
    }
    if (this.spinSpring) this.particleSpinAngle = this.spinSpring.x;
    else if (Math.abs(this.directTurn) > 0.001) this.particleSpinAngle = this.directTurn;
    else if (this.state === "humming" || this.state === "loading") this.particleSpinAngle = this.spinAngle;
    const width = this.svg.getBoundingClientRect().width || 380;
    const sizeScale = clamp((340 / width) ** 0.7, 1, 2.6);
    this.particles.update(now, delta, {
      spinAngle: this.particleSpinAngle,
      sizeScale,
      wideStyle: this.state === "humming" || this.celebrateWildActive || this.shapeChangeWide,
      enabled: config.particlesEnabled !== false,
    });
    this.frameId = requestAnimationFrame(this.boundFrame);
  }

  setPlaybackRate(rate) {
    return simulationClock.setPlaybackRate.call(this, rate);
  }

  setPaused(paused) {
    return simulationClock.setPaused.call(this, paused);
  }

  togglePaused() {
    return this.setPaused(!this.paused);
  }

  stepFrame(seconds = 1 / 60) {
    return simulationClock.stepFrame.call(this, seconds);
  }

  getSnapshot() {
    return {
      state: this.state,
      expressionIndex: this.expressionIndex,
      eyeOpen: this.eyeOpen.x,
      eyeOpenTarget: this.eyeOpen.target,
      morphEffect: this.morphEffect,
      morphAmount: this.morph.x,
      morphPhase: this.getMorphPhase(),
      elapsed: Math.max(0, (this.clockTime - this.stateStartedAt) / 1000),
      playbackRate: this.playbackRate,
      paused: this.paused,
    };
  }

  getMorphPhase() {
    return morphSystem.getMorphPhase.call(this);
  }

  triggerMorphPreview(effect, duration = 2500) {
    return morphSystem.triggerMorphPreview.call(this, effect, duration);
  }

  clearMorphPreview() {
    return morphSystem.clearMorphPreview.call(this);
  }

  updateMorph(now, config) {
    return morphSystem.updateMorph.call(this, now, config);
  }

  updateStateTargets(now, config, delta) {
    return stateBehavior.updateStateTargets.call(this, now, config, delta);
  }

  updateExpressionAndBlink(now, config) {
    return stateBehavior.updateExpressionAndBlink.call(this, now, config);
  }

  updateAim(now, config) {
    return stateBehavior.updateAim.call(this, now, config);
  }

  emptyGesture() {
    return stateBehavior.emptyGesture.call(this);
  }

  startSpin(turns = 1, direction = Math.random() < 0.5 ? 1 : -1) {
    return stateBehavior.startSpin.call(this, turns, direction);
  }

  startGesture(kind) {
    return stateBehavior.startGesture.call(this, kind);
  }

  startBounce(now) {
    return stateBehavior.startBounce.call(this, now);
  }

  updateGestures(now) {
    return stateBehavior.updateGestures.call(this, now);
  }

  celebratePose(elapsed) {
    return stateBehavior.celebratePose.call(this, elapsed);
  }

  triggerShapeChangeMotion() {
    return stateBehavior.triggerShapeChangeMotion.call(this);
  }

  resolveShape(shapeId) {
    return stateBehavior.resolveShape.call(this, shapeId);
  }

  render(now, config) {
    return svgRenderer.render.call(this, now, config);
  }

  renderEyes(now, config, shape, shapeRing, turnAngle, morphAmount) {
    return svgRenderer.renderEyes.call(this, now, config, shape, shapeRing, turnAngle, morphAmount);
  }

  createMorphLayer(effect) {
    return svgRenderer.createMorphLayer.call(this, effect);
  }

  useMorphLayer(layer) {
    return svgRenderer.useMorphLayer.call(this, layer);
  }

  hideMorphElements() {
    return svgRenderer.hideMorphElements.call(this);
  }

  renderHummingMarkers(shape) {
    return svgRenderer.renderHummingMarkers.call(this, shape);
  }

  renderMorphEffects(morphAmount, morphBlend, previousMorphEffect, morphSize, now) {
    return svgRenderer.renderMorphEffects.call(this, morphAmount, morphBlend, previousMorphEffect, morphSize, now);
  }

  renderDots(amount, now) {
    return svgRenderer.renderDots.call(this, amount, now);
  }

  renderOrbit(amount, now) {
    return svgRenderer.renderOrbit.call(this, amount, now);
  }

  renderRadar(amount, now, baseRadius) {
    return svgRenderer.renderRadar.call(this, amount, now, baseRadius);
  }

  renderProgress(amount, now) {
    return svgRenderer.renderProgress.call(this, amount, now);
  }

  renderGather(amount, now) {
    return svgRenderer.renderGather.call(this, amount, now);
  }

  renderWave(amount, now) {
    return svgRenderer.renderWave.call(this, amount, now);
  }

  renderSend(amount, now) {
    return svgRenderer.renderSend.call(this, amount, now);
  }

  renderReceive(amount, now) {
    return svgRenderer.renderReceive.call(this, amount, now);
  }

  renderDock(amount, now) {
    return svgRenderer.renderDock.call(this, amount, now);
  }

  pencilPose(now) {
    return svgRenderer.pencilPose.call(this, now);
  }

  renderPencil(amount, now) {
    return svgRenderer.renderPencil.call(this, amount, now);
  }

  renderBang(amount, now) {
    return svgRenderer.renderBang.call(this, amount, now);
  }

  renderStandby(amount, now) {
    return svgRenderer.renderStandby.call(this, amount, now);
  }
}

export { MORPH_SIZES };
