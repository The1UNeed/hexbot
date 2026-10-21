export const FIXED_STEP = 1 / 120;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const random = (min, max) => min + Math.random() * (max - min);
export const cubicInOut = (value) => value < 0.5 ? 4 * value ** 3 : 1 - ((-2 * value + 2) ** 3) / 2;
export const cubicOut = (value) => 1 - (1 - value) ** 3;
export const backOut = (value) => 1 + 2.70158 * (value - 1) ** 3 + 1.70158 * (value - 1) ** 2;
export const smoothstep = (value) => value * value * (3 - 2 * value);
export const springValue = (value) => ({ x: value, v: 0, target: value });

export function stepSpring(spring, frequency, damping, delta) {
  spring.v += (-2 * damping * frequency * spring.v - frequency ** 2 * (spring.x - spring.target)) * delta;
  spring.x += spring.v * delta;
  if (!Number.isFinite(spring.x) || !Number.isFinite(spring.v)) {
    spring.x = spring.target;
    spring.v = 0;
  }
}
