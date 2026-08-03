// @jataqi/design-system — the JATA Qi universal design language (tokens, themes,
// WCAG AA color science, CSS generation). Public API.

export { DesignSystemModule, DesignSystemEvents } from './system.js';
export type { AdaptiveThemeInput } from './system.js';
export {
  resolveTheme, themeForHour, hexToRgb, rgbToHex, relativeLuminance, contrastRatio,
  passesAA, passesAAA, legibleTextOn, mix, darken, lighten,
} from './theme.js';
export type { ThemeMode, Rgb } from './theme.js';
export {
  LIGHT_COLORS, DARK_COLORS, TYPOGRAPHY, SPACING, RADIUS, ELEVATION, MOTION, BREAKPOINTS, GLASS, Z_INDEX,
} from './tokens.js';
export type {
  ColorRole, ColorSet, ThemeTokens, BrandOverride, SpacingStep, RadiusStep,
} from './tokens.js';
export {
  generateThemeVars, generateBaseCss, generateComponentCss, generateUtilityCss, generateStylesheet,
} from './css.js';
