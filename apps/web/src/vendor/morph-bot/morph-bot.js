import { GrokBotEngine } from "./grok-bot-engine.js";
import { ORIGINAL_STATE_DATA } from "./original-data.js";
import { MORPH_BY_STATE, MORPH_IDS, SHAPE_IDS, STATE_IDS } from "./catalog.js";
import {
  DEFAULT_MATERIAL,
  GLASS_PRESETS,
  GRADIENT_PRESETS,
  MATERIAL_IDS,
  SOLID_PRESETS,
  resolveMaterial,
} from "./materials.js";

export const MORPH_BOT_STATES = STATE_IDS;
export const MORPH_BOT_SHAPES = SHAPE_IDS;
export const MORPH_BOT_EFFECTS = MORPH_IDS;
export const MORPH_BOT_MATERIALS = MATERIAL_IDS;
export const MORPH_BOT_SOLID_PRESETS = SOLID_PRESETS;
export const MORPH_BOT_GRADIENT_PRESETS = GRADIENT_PRESETS;
export const MORPH_BOT_GLASS_PRESETS = GLASS_PRESETS;
export { MORPH_BY_STATE };

const DEFAULT_CHARACTER = Object.freeze({
  color: "#0b0b0b",
  ...DEFAULT_MATERIAL,
  eyeColor: "#ffffff",
  size: 96,
  flipX: false,
  pointer: false,
  badgeColor: "#1d9bf0",
  badgeScale: 1,
});

const HTMLElementBase = globalThis.HTMLElement || class {};
let componentCounter = 0;

function defaultState(state) {
  const id = MORPH_BOT_STATES.includes(state) ? state : "idle";
  const blink = ORIGINAL_STATE_DATA.BLINK_CADENCE[id];
  return {
    expressionPool: [...ORIGINAL_STATE_DATA.EXPRESSION_POOLS[id]],
    expressionWeights: {},
    expressionCadence: [...ORIGINAL_STATE_DATA.EXPRESSION_CADENCE[id]],
    blinkEnabled: Boolean(blink),
    blinkMin: blink?.[0] ?? 3000,
    blinkMax: blink?.[1] ?? 7000,
    morph: MORPH_BY_STATE[id] || "none",
    headX: 0,
    headY: 0,
    headRotation: 0,
    scaleX: 1,
    scaleY: 1,
    eyeOpen: 1,
    eyeScale: 1,
    gazeScale: 1,
    motionScale: 1,
    tempo: 1,
  };
}

function numberAttribute(element, name, fallback, min, max) {
  const raw = element.getAttribute(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function cloneConfig(value) {
  if (!value || typeof value !== "object") return null;
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function svgTemplate(id) {
  const clipId = `${id}-head-clip`;
  return `
    <style>
      :host {
        --morph-bot-size: 96px;
        display: inline-grid;
        width: var(--morph-bot-size);
        height: var(--morph-bot-size);
        place-items: center;
        contain: layout style;
        vertical-align: middle;
      }
      svg {
        --fg: #0b0b0b;
        --bg: #fff;
        display: block;
        width: 100%;
        height: 100%;
        overflow: visible;
      }
      .grok-bot-mark__head,
      .morph-part { fill: var(--fg); }
      .grok-bot-mark__eye { fill: var(--bg); }
      .eye-path { transform-origin: 0 0; }
      .morph-ring { fill: none; stroke: var(--fg); }
      .morph-glyph { fill: var(--fg); }
      [hidden] { display: none !important; }
      @media (prefers-reduced-motion: reduce) {
        svg { transition: none; }
      }
    </style>
    <svg id="${id}" class="grok-bot-mark" data-state="idle" viewBox="-15 -15 259 259" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs><clipPath id="${clipId}"><path id="head-clip-path"></path></clipPath></defs>
      <g id="particles-back" aria-hidden="true"></g>
      <path class="grok-bot-mark__head morph-head" hidden></path>
      <path class="grok-bot-mark__head morph-head" hidden></path>
      ${Array.from({ length: 5 }, () => '<circle class="morph-ring" cx="114.2705" cy="114.2705" r="0" hidden></circle>').join("")}
      ${Array.from({ length: 5 }, () => '<circle class="grok-bot-mark__head morph-part" cx="114.2705" cy="114.2705" r="0" hidden></circle>').join("")}
      ${Array.from({ length: 3 }, () => '<path class="morph-glyph" hidden></path>').join("")}
      <g id="bot-transform">
        <path id="head-path" class="grok-bot-mark__head"></path>
        <g clip-path="url(#${clipId})">
          <path class="grok-bot-mark__eye eye-path"></path>
          <path class="grok-bot-mark__eye eye-path"></path>
        </g>
        <circle id="notify-badge" cx="114.2705" cy="114.2705" r="0" hidden></circle>
      </g>
      <g id="particles-front" aria-hidden="true"></g>
    </svg>`;
}

export class MorphBotElement extends HTMLElementBase {
  static get observedAttributes() {
    return [
      "state", "shape", "size", "color", "eye-color", "speed", "follow-pointer", "flip", "paused", "decorative", "label",
      "material", "gradient-preset", "gradient-start", "gradient-end", "gradient-angle", "glass-preset", "rotation",
    ];
  }

  constructor() {
    super();
    this._engine = null;
    this._preset = null;
    this._visible = true;
    this._intersectionObserver = null;
    this._morphMonitor = 0;
    this._sequenceToken = 0;
    this._componentId = `morph-bot-${++componentCounter}`;
    if (this.attachShadow) this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    if (!this.shadowRoot.querySelector("svg")) this.shadowRoot.innerHTML = svgTemplate(this._componentId);
    this._syncSize();
    this._syncAccessibility();
    if (!this._engine) {
      const svg = this.shadowRoot.querySelector("svg");
      this._engine = new GrokBotEngine(svg, () => this._engineConfig());
      this._engine.setPlaybackRate(this.speed);
      this._engine.setPaused(this.paused);
      this._engine.setState(this.state, true);
      if (globalThis.IntersectionObserver) {
        this._intersectionObserver = new IntersectionObserver(([entry]) => {
          this._visible = entry?.isIntersecting ?? true;
          this._syncPaused();
        });
        this._intersectionObserver.observe(this);
      }
      queueMicrotask(() => this.dispatchEvent(new CustomEvent("ready")));
    }
  }

  disconnectedCallback() {
    this._morphMonitor += 1;
    this._sequenceToken += 1;
    this._intersectionObserver?.disconnect();
    this._intersectionObserver = null;
    this._engine?.destroy();
    this._engine = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === "size") this._syncSize();
    if (["state", "decorative", "label"].includes(name)) this._syncAccessibility();
    if (!this._engine) return;
    if (name === "state") {
      this._engine.setState(this.state, true);
      this.dispatchEvent(new CustomEvent("statechange", { detail: { state: this.state } }));
    } else if (name === "shape") {
      this.dispatchEvent(new CustomEvent("shapechange", { detail: { shape: this.shape } }));
    } else if (["material", "color", "gradient-preset", "gradient-start", "gradient-end", "gradient-angle", "glass-preset"].includes(name)) {
      this.dispatchEvent(new CustomEvent("materialchange", { detail: { material: this.material } }));
    } else if (name === "speed") this._engine.setPlaybackRate(this.speed);
    else if (name === "paused") this._syncPaused();
  }

  get state() {
    const value = this.getAttribute("state") || "idle";
    return MORPH_BOT_STATES.includes(value) ? value : "idle";
  }

  set state(value) {
    this.setAttribute("state", MORPH_BOT_STATES.includes(value) ? value : "idle");
  }

  get shape() {
    const fallback = MORPH_BOT_SHAPES.includes(this._preset?.shape) ? this._preset.shape : "blob";
    const value = this.getAttribute("shape") || fallback;
    return MORPH_BOT_SHAPES.includes(value) ? value : fallback;
  }

  set shape(value) {
    this.setAttribute("shape", MORPH_BOT_SHAPES.includes(value) ? value : "blob");
  }

  get material() {
    const fallback = MATERIAL_IDS.includes(this._preset?.character?.material) ? this._preset.character.material : DEFAULT_MATERIAL.material;
    const value = this.getAttribute("material") || fallback;
    return MATERIAL_IDS.includes(value) ? value : fallback;
  }

  set material(value) {
    this.setAttribute("material", MATERIAL_IDS.includes(value) ? value : DEFAULT_MATERIAL.material);
  }

  get gradientPreset() {
    if ((this.hasAttribute("gradient-start") || this.hasAttribute("gradient-end")) && !this.hasAttribute("gradient-preset")) return "custom";
    const fallback = this._preset?.character?.gradientPreset || DEFAULT_MATERIAL.gradientPreset;
    const value = this.getAttribute("gradient-preset") || fallback;
    return value === "custom" || GRADIENT_PRESETS.some(({ id }) => id === value) ? value : DEFAULT_MATERIAL.gradientPreset;
  }

  get glassPreset() {
    const fallback = this._preset?.character?.glassPreset || DEFAULT_MATERIAL.glassPreset;
    const value = this.getAttribute("glass-preset") || fallback;
    return GLASS_PRESETS.some(({ id }) => id === value) ? value : DEFAULT_MATERIAL.glassPreset;
  }

  get size() { return numberAttribute(this, "size", this._preset?.character?.size || DEFAULT_CHARACTER.size, 12, 1024); }
  set size(value) { this.setAttribute("size", String(value)); }
  get speed() { return numberAttribute(this, "speed", 1, 0.1, 4); }
  set speed(value) { this.setAttribute("speed", String(value)); }
  get paused() { return this.hasAttribute("paused"); }
  set paused(value) { this.toggleAttribute("paused", Boolean(value)); }
  get rotation() { return numberAttribute(this, "rotation", 0, -180, 180); }
  set rotation(value) { this.setAttribute("rotation", String(Math.min(180, Math.max(-180, Number(value) || 0)))); }

  configure(project) {
    this._preset = cloneConfig(project);
    this._syncSize();
    this._engine?.setState(this.state, true);
    this.dispatchEvent(new CustomEvent("configure"));
    return this;
  }

  setState(state, { replay = false } = {}) {
    if (!MORPH_BOT_STATES.includes(state)) throw new RangeError(`Unknown morph-bot state: ${state}`);
    if (state === this.state && replay) this._engine?.setState(state, true);
    else this.state = state;
    return this;
  }

  setShape(shape) {
    if (!MORPH_BOT_SHAPES.includes(shape)) throw new RangeError(`Unknown morph-bot shape: ${shape}`);
    this.shape = shape;
    return this;
  }

  setMaterial(material, options = {}) {
    if (!MATERIAL_IDS.includes(material)) throw new RangeError(`Unknown morph-bot material: ${material}`);
    this.material = material;
    if (material === "solid" && options.color) this.setAttribute("color", options.color);
    if (material === "gradient") {
      if (options.preset) {
        this.setAttribute("gradient-preset", options.preset);
        this.removeAttribute("gradient-start");
        this.removeAttribute("gradient-end");
        this.removeAttribute("gradient-angle");
      } else if (options.start || options.end || options.angle !== undefined) {
        this.removeAttribute("gradient-preset");
        if (options.start) this.setAttribute("gradient-start", options.start);
        if (options.end) this.setAttribute("gradient-end", options.end);
        if (options.angle !== undefined) this.setAttribute("gradient-angle", String(options.angle));
      }
    }
    if (material === "rainbow-glass" && options.preset) this.setAttribute("glass-preset", options.preset);
    return this;
  }

  replay() {
    this._engine?.setState(this.state, true);
    return this;
  }

  pause() { this.paused = true; return this; }
  play() { this.paused = false; return this; }
  step() { this._engine?.stepFrame(); this.paused = true; return this; }

  restoreStateMorph() {
    this._morphMonitor += 1;
    this._engine?.clearMorphPreview();
    return this;
  }

  playMorph(effect, { hold = 2500, restore = null } = {}) {
    if (!MORPH_BOT_EFFECTS.includes(effect)) return Promise.reject(new RangeError(`Unknown morph effect: ${effect}`));
    if (!this._engine) return Promise.reject(new Error("morph-bot is not connected"));
    const token = ++this._morphMonitor;
    this._engine.triggerMorphPreview(effect, hold);
    this.dispatchEvent(new CustomEvent("morphstart", { detail: { effect, hold } }));
    return new Promise((resolve) => {
      const inspect = () => {
        if (token !== this._morphMonitor || !this._engine) { resolve({ cancelled: true }); return; }
        if (this._engine.getSnapshot().morphPhase === "DONE") {
          this.dispatchEvent(new CustomEvent("morphend", { detail: { effect } }));
          if (restore === "default") this._engine.clearMorphPreview();
          else if (MORPH_BOT_STATES.includes(restore)) this.state = restore;
          resolve({ effect, restored: restore });
          return;
        }
        requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
  }

  async playSequence(steps, { loop = false } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) throw new TypeError("Morph sequence requires at least one step");
    if (!this._engine) throw new Error("morph-bot is not connected");
    const sequence = steps.map((step, index) => {
      if (!step || !MORPH_BOT_STATES.includes(step.state)) throw new RangeError(`Unknown state at sequence step ${index + 1}`);
      const morph = step.morph === undefined || step.morph === null || step.morph === "none" ? null : step.morph;
      if (morph && !MORPH_BOT_EFFECTS.includes(morph)) throw new RangeError(`Unknown morph effect at sequence step ${index + 1}: ${morph}`);
      const hold = Number(step.hold ?? 1000);
      const morphHold = Number(step.morphHold ?? 1200);
      if (!Number.isFinite(hold) || hold < 0) throw new RangeError(`Invalid hold at sequence step ${index + 1}`);
      if (!Number.isFinite(morphHold) || morphHold < 0) throw new RangeError(`Invalid morphHold at sequence step ${index + 1}`);
      return { state: step.state, hold, morph, morphHold };
    });

    this.stopSequence();
    const token = ++this._sequenceToken;
    let cycle = 0;
    this.dispatchEvent(new CustomEvent("sequencestart", { detail: { steps: sequence, loop: Boolean(loop) } }));

    do {
      for (let index = 0; index < sequence.length; index += 1) {
        if (token !== this._sequenceToken || !this._engine) return { cancelled: true, cycle, index };
        const step = sequence[index];
        this.setState(step.state, { replay: true });
        this.dispatchEvent(new CustomEvent("sequencestep", { detail: { index, cycle, ...step } }));
        if (!(await this._waitForSequence(step.hold, token))) return { cancelled: true, cycle, index };
        if (step.morph) {
          const result = await this.playMorph(step.morph, { hold: step.morphHold, restore: "default" });
          if (result.cancelled || token !== this._sequenceToken) return { cancelled: true, cycle, index };
        }
      }
      cycle += 1;
      if (loop && !(await this._waitForSequence(16, token))) return { cancelled: true, cycle };
    } while (loop && token === this._sequenceToken && this._engine);

    if (token !== this._sequenceToken || !this._engine) return { cancelled: true, cycle };
    this.dispatchEvent(new CustomEvent("sequenceend", { detail: { cycles: cycle } }));
    return { cancelled: false, cycles: cycle };
  }

  stopSequence() {
    this._sequenceToken += 1;
    this._morphMonitor += 1;
    this._engine?.clearMorphPreview();
    return this;
  }

  _waitForSequence(duration, token) {
    if (duration <= 0) return Promise.resolve(token === this._sequenceToken);
    return new Promise((resolve) => {
      let remaining = duration;
      let previous = performance.now();
      const inspect = (now) => {
        if (token !== this._sequenceToken || !this._engine) { resolve(false); return; }
        if (!(this.paused || !this._visible)) remaining -= Math.max(0, now - previous);
        previous = now;
        if (remaining <= 0) { resolve(true); return; }
        requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
  }

  snapshot() {
    return this._engine?.getSnapshot() || null;
  }

  _engineConfig() {
    const state = this.state;
    const baseState = defaultState(state);
    const stateConfig = { ...baseState, ...(this._preset?.states?.[state] || {}) };
    stateConfig.expressionPool = Array.isArray(stateConfig.expressionPool) && stateConfig.expressionPool.length
      ? stateConfig.expressionPool
      : baseState.expressionPool;
    stateConfig.expressionCadence = Array.isArray(stateConfig.expressionCadence)
      ? stateConfig.expressionCadence
      : baseState.expressionCadence;
    const character = { ...DEFAULT_CHARACTER, ...(this._preset?.character || {}) };
    const color = this.getAttribute("color") || character.color;
    const material = this.material;
    const gradientPreset = this.gradientPreset;
    const gradientStart = this.getAttribute("gradient-start") || character.gradientStart;
    const gradientEnd = this.getAttribute("gradient-end") || character.gradientEnd;
    const gradientAngle = numberAttribute(this, "gradient-angle", character.gradientAngle, 0, 360);
    const glassPreset = this.glassPreset;
    const resolvedMaterial = resolveMaterial({
      material,
      color,
      gradientPreset,
      gradientStart,
      gradientEnd,
      gradientAngle,
      glassPreset,
    });
    const eyeColor = this.getAttribute("eye-color")
      || this._preset?.character?.eyeColor
      || resolvedMaterial.eyeColor
      || character.eyeColor;
    const rotation = numberAttribute(this, "rotation", stateConfig.headRotation, -180, 180);
    const pointer = this.hasAttribute("follow-pointer") ? true : Boolean(character.pointer);
    const flipX = this.hasAttribute("flip") ? true : Boolean(character.flipX);
    return {
      ...character,
      ...stateConfig,
      color,
      material,
      gradientPreset,
      gradientStart,
      gradientEnd,
      gradientAngle,
      glassPreset,
      eyeColor,
      headRotation: rotation,
      pointer,
      flipX,
      particlesEnabled: !this.hasAttribute("thumbnail"),
      size: this.size,
      shape: this.shape,
      blinkCadence: stateConfig.blinkEnabled
        ? [Math.min(stateConfig.blinkMin, stateConfig.blinkMax), Math.max(stateConfig.blinkMin, stateConfig.blinkMax)]
        : null,
    };
  }

  _syncSize() {
    this.style?.setProperty("--morph-bot-size", `${this.size}px`);
  }

  _syncPaused() {
    this._engine?.setPaused(this.paused || !this._visible);
  }

  _syncAccessibility() {
    if (this.hasAttribute("decorative")) {
      this.setAttribute("aria-hidden", "true");
      this.removeAttribute("role");
      return;
    }
    this.removeAttribute("aria-hidden");
    if (!this.hasAttribute("role")) this.setAttribute("role", ["loading", "progress", "spawning"].includes(this.state) ? "status" : "img");
    if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", this.getAttribute("label") || `Animated bot: ${this.state}`);
  }
}

if (globalThis.customElements && !customElements.get("morph-bot")) {
  customElements.define("morph-bot", MorphBotElement);
}

export default MorphBotElement;
