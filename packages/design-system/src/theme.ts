// Theme resolution + color science. Resolves a complete token bundle for a mode
// (light/dark) with optional per-product brand overrides, and provides WCAG AA
// contrast utilities so accessible color pairings can be validated in tests and
// at runtime.

import {
  DARK_COLORS, LIGHT_COLORS, TYPOGRAPHY, SPACING, RADIUS, ELEVATION, MOTION, BREAKPOINTS, GLASS, Z_INDEX,
  type BrandOverride, type ColorSet, type ThemeTokens,
} from './tokens.js';

export type { BrandOverride, ColorSet, ThemeTokens } from './tokens.js';

export type ThemeMode = 'light' | 'dark';

// ---- color math ----------------------------------------------------------

export interface Rgb { r: number; g: number; b: number }

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) throw new Error(`invalid hex color: ${hex}`);
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear-channel value for luminance computation. */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0..1). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Does a pairing pass WCAG AA? (`large` text needs only 3:1, normal needs 4.5:1). */
export function passesAA(fg: string, bg: string, large = false): boolean {
  return contrastRatio(fg, bg) >= (large ? 3 : 4.5);
}

/** Does a pairing pass WCAG AAA (7:1 normal / 4.5:1 large)? */
export function passesAAA(fg: string, bg: string, large = false): boolean {
  return contrastRatio(fg, bg) >= (large ? 4.5 : 7);
}

/** Pick black or white text for maximum contrast on a background. */
export function legibleTextOn(bg: string): string {
  return contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg) ? '#ffffff' : '#000000';
}

/** Linearly mix two hex colors (t = 0..1 toward b). */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  return rgbToHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t });
}

/** Darken a hex color by `amount` (0..1). */
export function darken(hex: string, amount: number): string { return mix(hex, '#000000', amount); }
/** Lighten a hex color by `amount` (0..1). */
export function lighten(hex: string, amount: number): string { return mix(hex, '#ffffff', amount); }

// ---- theme resolution ----------------------------------------------------

/** Resolve a complete token bundle for a mode, applying brand overrides. */
export function resolveTheme(mode: ThemeMode = 'dark', brand?: BrandOverride): ThemeTokens {
  const base: ColorSet = mode === 'dark' ? { ...DARK_COLORS } : { ...LIGHT_COLORS };
  if (brand) {
    if (brand.primary) {
      base.primary = brand.primary;
      base.primaryDim = darken(brand.primary, 0.14);
      base.textOnPrimary = legibleTextOn(brand.primary);
      base.primaryFg = base.textOnPrimary;
    }
    if (brand.secondary) base.secondary = brand.secondary;
    if (brand.accent) base.accent = brand.accent;
  }
  return {
    mode, colors: base, typography: TYPOGRAPHY, spacing: SPACING, radius: RADIUS,
    elevation: ELEVATION, motion: MOTION, breakpoints: BREAKPOINTS, glass: GLASS, zIndex: Z_INDEX,
  };
}

/** Auto-select a theme by local hour (6–18 light, else dark) — supports the
 *  "time of day" adaptation requirement at the foundation layer. */
export function themeForHour(hour: number): ThemeMode {
  return hour >= 6 && hour < 18 ? 'light' : 'dark';
}
