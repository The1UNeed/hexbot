import type {
  MorphBotGlassPresetDefinition,
  MorphBotGradientPresetDefinition,
  MorphBotGradientSpot,
  MorphBotMaterial,
  MorphBotMaterialStop,
  MorphBotSolidPresetDefinition,
} from "./morph-bot.js";

export const MATERIAL_IDS: readonly MorphBotMaterial[];
export const SOLID_PRESETS: readonly MorphBotSolidPresetDefinition[];
export const GRADIENT_PRESETS: readonly MorphBotGradientPresetDefinition[];
export const GLASS_PRESETS: readonly MorphBotGlassPresetDefinition[];
export const MATERIAL_LABELS: Readonly<Record<MorphBotMaterial, Readonly<{ zh: string; en: string }>>>;
export const DEFAULT_MATERIAL: Readonly<{
  material: MorphBotMaterial;
  color: string;
  gradientPreset: string;
  gradientStart: string;
  gradientEnd: string;
  gradientAngle: number;
  glassPreset: string;
}>;

export function resolveMaterial(config?: Record<string, unknown>): {
  material: MorphBotMaterial;
  preset: string;
  color?: string;
  angle?: number;
  stops?: readonly MorphBotMaterialStop[];
  kind?: "soft";
  base?: string;
  spots?: readonly MorphBotGradientSpot[];
  eyeColor?: string;
  shadow?: string;
  rim?: string;
  sheen?: number;
};

export function smoothMaterialStops(stops: readonly MorphBotMaterialStop[], subdivisions?: number): MorphBotMaterialStop[];
export function materialCssBackground(material: MorphBotMaterial, preset: MorphBotSolidPresetDefinition | MorphBotGradientPresetDefinition | MorphBotGlassPresetDefinition): string;
