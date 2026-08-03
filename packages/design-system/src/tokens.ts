// JATA Qi Design System — canonical design tokens. The single source of truth
// inherited by every product (icons, branding, dashboard, OS shell, web-ui).
// Tokens are plain, serializable data so they can be tested, themed, and
// compiled to CSS custom properties.

/** A semantic color role. */
export type ColorRole =
  | 'primary' | 'primaryFg' | 'primaryDim'
  | 'secondary' | 'secondaryFg'
  | 'accent' | 'accentFg'
  | 'success' | 'successFg'
  | 'warning' | 'warningFg'
  | 'danger' | 'dangerFg'
  | 'info' | 'infoFg'
  | 'background' | 'surface' | 'surfaceElevated' | 'surfaceGlass'
  | 'border' | 'borderStrong'
  | 'text' | 'textMuted' | 'textInverse' | 'textOnPrimary';

export type ColorSet = Record<ColorRole, string>;

/** Light-mode semantic colors (premium indigo/violet, AI-first). */
export const LIGHT_COLORS: ColorSet = {
  primary: '#5b5bd6', primaryFg: '#ffffff', primaryDim: '#4a4ac0',
  secondary: '#0ea5e9', secondaryFg: '#ffffff',
  accent: '#f472b6', accentFg: '#1a1030',
  success: '#16a34a', successFg: '#ffffff',
  warning: '#d97706', warningFg: '#ffffff',
  danger: '#dc2626', dangerFg: '#ffffff',
  info: '#2563eb', infoFg: '#ffffff',
  background: '#f6f7fb', surface: '#ffffff', surfaceElevated: '#ffffff', surfaceGlass: 'rgba(255,255,255,0.65)',
  border: '#e6e8f0', borderStrong: '#cdd2e0',
  text: '#16182b', textMuted: '#5b6178', textInverse: '#ffffff', textOnPrimary: '#ffffff',
};

/** Dark-mode semantic colors. */
export const DARK_COLORS: ColorSet = {
  primary: '#7c7cf0', primaryFg: '#0b0b1a', primaryDim: '#5b5bd6',
  secondary: '#38bdf8', secondaryFg: '#06121f',
  accent: '#f9a8d4', accentFg: '#1a1030',
  success: '#22c55e', successFg: '#04140b',
  warning: '#f59e0b', warningFg: '#1a1003',
  danger: '#f87171', dangerFg: '#1a0606',
  info: '#60a5fa', infoFg: '#06101f',
  background: '#0c0e1a', surface: '#15182a', surfaceElevated: '#1d2138', surfaceGlass: 'rgba(29,33,56,0.55)',
  border: '#272c45', borderStrong: '#3a416a',
  text: '#e7e9f5', textMuted: '#9aa1bd', textInverse: '#0c0e1a', textOnPrimary: '#0b0b1a',
};

/** Typography tokens. */
export const TYPOGRAPHY = {
  family: {
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif",
    display: "'SF Pro Display', 'Inter', -apple-system, sans-serif",
    mono: "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  },
  size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48 } as Record<string, number>,
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 } as Record<string, number>,
  lineHeight: { tight: 1.2, normal: 1.5, relaxed: 1.7 } as Record<string, number>,
  letterSpacing: { tight: '-0.01em', normal: '0', wide: '0.02em' } as Record<string, string>,
} as const;

/** Spacing scale — 8px grid with a 4px half-step. */
export const SPACING = { 0: 0, '0.5': 4, 1: 8, 1.5: 12, 2: 16, 2.5: 20, 3: 24, 4: 32, 5: 40, 6: 48, 8: 64, 10: 80, 12: 96 } as const;
export type SpacingStep = keyof typeof SPACING;

/** Border-radius scale (16–24px for premium components). */
export const RADIUS = { none: 0, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, full: 9999 } as const;
export type RadiusStep = keyof typeof RADIUS;

/** Elevation (box-shadow) by z-depth, including a glass layer. */
export const ELEVATION = {
  z0: 'none',
  z1: '0 1px 2px rgba(16,24,40,0.06), 0 1px 3px rgba(16,24,40,0.05)',
  z2: '0 4px 8px rgba(16,24,40,0.08), 0 2px 4px rgba(16,24,40,0.05)',
  z3: '0 10px 20px rgba(16,24,40,0.10), 0 4px 8px rgba(16,24,40,0.06)',
  z4: '0 20px 40px rgba(16,24,40,0.14), 0 8px 16px rgba(16,24,40,0.08)',
  z5: '0 32px 64px rgba(16,24,40,0.20), 0 16px 32px rgba(16,24,40,0.10)',
  glass: '0 8px 32px rgba(16,24,40,0.12), inset 0 1px 0 rgba(255,255,255,0.25)',
} as const;

/** Motion tokens — durations (ms) and easings. */
export const MOTION = {
  duration: { instant: 80, fast: 140, normal: 220, slow: 360, slower: 520 } as Record<string, number>,
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.3, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
    spring: 'cubic-bezier(0.5, 1.5, 0.5, 1)',
  } as Record<string, string>,
} as const;

/** Responsive breakpoints (min-width). */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } as const;

/** Glassmorphism treatment (subtle, per design philosophy). */
export const GLASS = {
  blur: 16,          // backdrop-filter blur px
  saturation: 1.6,   // backdrop saturate
  borderAlpha: 0.12,
  highlight: 'inset 0 1px 0 rgba(255,255,255,0.25)',
} as const;

/** Z-index layering scale. */
export const Z_INDEX = {
  base: 0, dropdown: 100, sticky: 200, drawer: 300, modal: 400, popover: 500, toast: 600, tooltip: 700, commandPalette: 800,
} as const;

/** The complete token bundle for one theme mode. */
export interface ThemeTokens {
  mode: 'light' | 'dark';
  colors: ColorSet;
  typography: typeof TYPOGRAPHY;
  spacing: typeof SPACING;
  radius: typeof RADIUS;
  elevation: typeof ELEVATION;
  motion: typeof MOTION;
  breakpoints: typeof BREAKPOINTS;
  glass: typeof GLASS;
  zIndex: typeof Z_INDEX;
}

/** A brand override (used by @jataqi/branding to derive per-product palettes). */
export interface BrandOverride {
  /** Primary color (hex). Derives primaryDim automatically. */
  primary?: string;
  /** Secondary/accent colors (hex). */
  secondary?: string;
  accent?: string;
}
