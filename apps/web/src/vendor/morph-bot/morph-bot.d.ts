export type MorphBotState = "sleeping" | "waking" | "idle" | "listening" | "thinking" | "searching" | "working" | "excited" | "surprised" | "suspicious" | "angry" | "drowsy" | "happy" | "curious" | "confused" | "bored" | "proud" | "shy" | "sad" | "laughing" | "scared" | "playful" | "celebrate" | "orbit" | "radar" | "progress" | "spawning" | "humming" | "loading" | "dictating" | "writing" | "sending" | "receiving" | "uploading" | "notifying" | "alerting" | "dragging" | "bouncing" | "powering-down";
export type MorphBotShape = "blob" | "pebble" | "bean" | "egg" | "squircle" | "tablet" | "capsule" | "cylinder" | "hex" | "gem" | "crystal" | "wedge" | "shield" | "dome" | "arch" | "cloud" | "teardrop" | "leaf";
export type MorphBotEffect = "dots" | "orbit" | "radar" | "progress" | "gather" | "wave" | "send" | "receive" | "dock" | "ball" | "whirl" | "pencil" | "bang" | "standby";
export type MorphBotMaterial = "solid" | "gradient" | "rainbow-glass";
export type MorphBotGradientPreset = "electric-dusk" | "ocean-signal" | "warm-flare" | "mint-violet" | "midnight-plum" | "peach-sky" | "acid-lime" | "blue-hour" | "porcelain-bloom" | "lilac-breath" | "blue-milk" | "peach-haze";
export type MorphBotGlassPreset = "iridescent-orb" | "prism" | "aurora" | "candy" | "opal";

export interface MorphBotMaterialStop { offset: number; color: string; opacity?: number; }
export interface MorphBotGradientSpot { x: number; y: number; r: number; scaleX: number; scaleY: number; rotation: number; color: string; opacity: number; }
export interface MorphBotSolidPresetDefinition { id: string; label: { zh: string; en: string }; color: string; }
export interface MorphBotGradientPresetDefinition { id: MorphBotGradientPreset; label: { zh: string; en: string }; angle: number; stops: readonly MorphBotMaterialStop[]; kind?: "soft"; base?: string; eyeColor?: string; spots?: readonly MorphBotGradientSpot[]; }
export interface MorphBotGlassPresetDefinition { id: MorphBotGlassPreset; label: { zh: string; en: string }; stops: readonly MorphBotMaterialStop[]; rimStops?: readonly MorphBotMaterialStop[]; shadow: string; rim: string; sheen: number; caustic: string; causticAccent: string; depth: number; }

export interface MorphBotCharacterConfig {
  material?: MorphBotMaterial;
  color?: string;
  gradientPreset?: MorphBotGradientPreset | "custom";
  gradientStart?: string;
  gradientEnd?: string;
  gradientAngle?: number;
  glassPreset?: MorphBotGlassPreset;
  eyeColor?: string;
  size?: number;
  flipX?: boolean;
  pointer?: boolean;
  badgeColor?: string;
  badgeScale?: number;
  [key: string]: unknown;
}

export interface MorphBotProject {
  version?: number;
  shape?: MorphBotShape;
  character?: MorphBotCharacterConfig;
  states?: Partial<Record<MorphBotState, Record<string, unknown>>>;
}

export interface MorphBotSequenceStep {
  state: MorphBotState;
  hold?: number;
  morph?: MorphBotEffect | "none" | null;
  morphHold?: number;
}

export interface MorphBotSequenceResult {
  cancelled: boolean;
  cycles?: number;
  cycle?: number;
  index?: number;
}

export class MorphBotElement extends HTMLElement {
  state: MorphBotState;
  shape: MorphBotShape;
  material: MorphBotMaterial;
  readonly gradientPreset: MorphBotGradientPreset | "custom";
  readonly glassPreset: MorphBotGlassPreset;
  size: number;
  speed: number;
  rotation: number;
  paused: boolean;
  configure(project: MorphBotProject): this;
  setState(state: MorphBotState, options?: { replay?: boolean }): this;
  setShape(shape: MorphBotShape): this;
  setMaterial(material: "solid", options?: { color?: string }): this;
  setMaterial(material: "gradient", options?: { preset?: MorphBotGradientPreset; start?: string; end?: string; angle?: number }): this;
  setMaterial(material: "rainbow-glass", options?: { preset?: MorphBotGlassPreset }): this;
  replay(): this;
  pause(): this;
  play(): this;
  step(): this;
  restoreStateMorph(): this;
  playMorph(effect: MorphBotEffect, options?: { hold?: number; restore?: MorphBotState | "default" | null }): Promise<{ cancelled?: boolean; effect?: MorphBotEffect; restored?: string | null }>;
  playSequence(steps: MorphBotSequenceStep[], options?: { loop?: boolean }): Promise<MorphBotSequenceResult>;
  stopSequence(): this;
  snapshot(): Record<string, unknown> | null;
}

export const MORPH_BOT_STATES: readonly MorphBotState[];
export const MORPH_BOT_SHAPES: readonly MorphBotShape[];
export const MORPH_BOT_EFFECTS: readonly MorphBotEffect[];
export const MORPH_BOT_MATERIALS: readonly MorphBotMaterial[];
export const MORPH_BOT_SOLID_PRESETS: readonly MorphBotSolidPresetDefinition[];
export const MORPH_BOT_GRADIENT_PRESETS: readonly MorphBotGradientPresetDefinition[];
export const MORPH_BOT_GLASS_PRESETS: readonly MorphBotGlassPresetDefinition[];
export const MORPH_BY_STATE: Readonly<Partial<Record<MorphBotState, MorphBotEffect>>>;

declare global {
  interface HTMLElementTagNameMap {
    "morph-bot": MorphBotElement;
  }
}

export default MorphBotElement;
