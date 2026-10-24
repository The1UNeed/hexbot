import type {
  HexbotFaceGlassPresetDefinition,
  HexbotFaceGradientPresetDefinition,
  HexbotFaceGradientSpot,
  HexbotFaceMaterial,
  HexbotFaceMaterialStop,
  HexbotFaceSolidPresetDefinition,
} from "./hexbot-face.js";

export const MATERIAL_IDS: readonly HexbotFaceMaterial[];
export const SOLID_PRESETS: readonly HexbotFaceSolidPresetDefinition[];
export const GRADIENT_PRESETS: readonly HexbotFaceGradientPresetDefinition[];
export const GLASS_PRESETS: readonly HexbotFaceGlassPresetDefinition[];
export const MATERIAL_LABELS: Readonly<Record<HexbotFaceMaterial, Readonly<{ zh: string; en: string }>>>;
export const DEFAULT_MATERIAL: Readonly<{
  material: HexbotFaceMaterial;
  color: string;
  gradientPreset: string;
  gradientStart: string;
  gradientEnd: string;
  gradientAngle: number;
  glassPreset: string;
}>;

export function resolveMaterial(config?: Record<string, unknown>): {
  material: HexbotFaceMaterial;
  preset: string;
  color?: string;
  angle?: number;
  stops?: readonly HexbotFaceMaterialStop[];
  kind?: "soft";
  base?: string;
  spots?: readonly HexbotFaceGradientSpot[];
  eyeColor?: string;
  shadow?: string;
  rim?: string;
  sheen?: number;
};

export function smoothMaterialStops(stops: readonly HexbotFaceMaterialStop[], subdivisions?: number): HexbotFaceMaterialStop[];
export function materialCssBackground(material: HexbotFaceMaterial, preset: HexbotFaceSolidPresetDefinition | HexbotFaceGradientPresetDefinition | HexbotFaceGlassPresetDefinition): string;
