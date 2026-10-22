export type HexbotFaceState = "sleeping" | "waking" | "idle" | "listening" | "thinking" | "searching" | "working" | "excited" | "surprised" | "suspicious" | "angry" | "drowsy" | "happy" | "curious" | "confused" | "bored" | "proud" | "shy" | "sad" | "laughing" | "scared" | "playful" | "celebrate" | "orbit" | "radar" | "progress" | "spawning" | "humming" | "loading" | "dictating" | "writing" | "sending" | "receiving" | "uploading" | "notifying" | "alerting" | "dragging" | "bouncing" | "powering-down";
export type HexbotFaceShape = "blob" | "pebble" | "bean" | "egg" | "squircle" | "tablet" | "capsule" | "cylinder" | "hex" | "gem" | "crystal" | "wedge" | "shield" | "dome" | "arch" | "cloud" | "teardrop" | "leaf";
export type HexbotFaceEffect = "dots" | "orbit" | "radar" | "progress" | "gather" | "wave" | "send" | "receive" | "dock" | "ball" | "whirl" | "pencil" | "bang" | "standby";
export type HexbotFaceMaterial = "solid" | "gradient" | "rainbow-glass";
export type HexbotFaceGradientPreset = "electric-dusk" | "ocean-signal" | "warm-flare" | "mint-violet" | "midnight-plum" | "peach-sky" | "acid-lime" | "blue-hour" | "porcelain-bloom" | "lilac-breath" | "blue-milk" | "peach-haze";
export type HexbotFaceGlassPreset = "iridescent-orb" | "prism" | "aurora" | "candy" | "opal";

export interface HexbotFaceMaterialStop { offset: number; color: string; opacity?: number; }
export interface HexbotFaceGradientSpot { x: number; y: number; r: number; scaleX: number; scaleY: number; rotation: number; color: string; opacity: number; }
export interface HexbotFaceSolidPresetDefinition { id: string; label: { zh: string; en: string }; color: string; }
export interface HexbotFaceGradientPresetDefinition { id: HexbotFaceGradientPreset; label: { zh: string; en: string }; angle: number; stops: readonly HexbotFaceMaterialStop[]; kind?: "soft"; base?: string; eyeColor?: string; spots?: readonly HexbotFaceGradientSpot[]; }
export interface HexbotFaceGlassPresetDefinition { id: HexbotFaceGlassPreset; label: { zh: string; en: string }; stops: readonly HexbotFaceMaterialStop[]; rimStops?: readonly HexbotFaceMaterialStop[]; shadow: string; rim: string; sheen: number; caustic: string; causticAccent: string; depth: number; }

export interface HexbotFaceCharacterConfig {
  material?: HexbotFaceMaterial;
  color?: string;
  gradientPreset?: HexbotFaceGradientPreset | "custom";
  gradientStart?: string;
  gradientEnd?: string;
  gradientAngle?: number;
  glassPreset?: HexbotFaceGlassPreset;
  eyeColor?: string;
  size?: number;
  flipX?: boolean;
  pointer?: boolean;
  badgeColor?: string;
  badgeScale?: number;
  [key: string]: unknown;
}

export interface HexbotFaceProject {
  version?: number;
  shape?: HexbotFaceShape;
  character?: HexbotFaceCharacterConfig;
  states?: Partial<Record<HexbotFaceState, Record<string, unknown>>>;
}

export interface HexbotFaceSequenceStep {
  state: HexbotFaceState;
  hold?: number;
  morph?: HexbotFaceEffect | "none" | null;
  morphHold?: number;
}

export interface HexbotFaceSequenceResult {
  cancelled: boolean;
  cycles?: number;
  cycle?: number;
  index?: number;
}

export class HexbotFaceElement extends HTMLElement {
  state: HexbotFaceState;
  shape: HexbotFaceShape;
  material: HexbotFaceMaterial;
  readonly gradientPreset: HexbotFaceGradientPreset | "custom";
  readonly glassPreset: HexbotFaceGlassPreset;
  size: number;
  speed: number;
  rotation: number;
  paused: boolean;
  configure(project: HexbotFaceProject): this;
  setState(state: HexbotFaceState, options?: { replay?: boolean }): this;
  setShape(shape: HexbotFaceShape): this;
  setMaterial(material: "solid", options?: { color?: string }): this;
  setMaterial(material: "gradient", options?: { preset?: HexbotFaceGradientPreset; start?: string; end?: string; angle?: number }): this;
  setMaterial(material: "rainbow-glass", options?: { preset?: HexbotFaceGlassPreset }): this;
  replay(): this;
  pause(): this;
  play(): this;
  step(): this;
  restoreStateMorph(): this;
  playMorph(effect: HexbotFaceEffect, options?: { hold?: number; restore?: HexbotFaceState | "default" | null }): Promise<{ cancelled?: boolean; effect?: HexbotFaceEffect; restored?: string | null }>;
  playSequence(steps: HexbotFaceSequenceStep[], options?: { loop?: boolean }): Promise<HexbotFaceSequenceResult>;
  stopSequence(): this;
  snapshot(): Record<string, unknown> | null;
}

export const HEXBOT_FACE_STATES: readonly HexbotFaceState[];
export const HEXBOT_FACE_SHAPES: readonly HexbotFaceShape[];
export const HEXBOT_FACE_EFFECTS: readonly HexbotFaceEffect[];
export const HEXBOT_FACE_MATERIALS: readonly HexbotFaceMaterial[];
export const HEXBOT_FACE_SOLID_PRESETS: readonly HexbotFaceSolidPresetDefinition[];
export const HEXBOT_FACE_GRADIENT_PRESETS: readonly HexbotFaceGradientPresetDefinition[];
export const HEXBOT_FACE_GLASS_PRESETS: readonly HexbotFaceGlassPresetDefinition[];
export const MORPH_BY_STATE: Readonly<Partial<Record<HexbotFaceState, HexbotFaceEffect>>>;

declare global {
  interface HTMLElementTagNameMap {
    "hexbot-face": HexbotFaceElement;
  }
}

export default HexbotFaceElement;
