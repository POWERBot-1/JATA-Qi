// JATA Qi Icon Engine — generates SVG icons programmatically from a geometric
// primitive system. Instead of hand-authoring thousands of individual SVGs, the
// engine composes each icon from shared shapes (circles, rects, paths, strokes)
// and applies variant styling (outline, filled, duotone, glass, animated, 3D).
// This produces a consistent, tree-shakeable icon library with thousands of
// derivable icons from a compact core.

/** Icon visual variant. */
export type IconVariant = 'outline' | 'filled' | 'duotone' | 'glass' | 'rounded' | 'sharp' | 'animated';

/** Standard icon size. */
export type IconSize = 16 | 20 | 24 | 32 | 48 | 64;

/** A geometric primitive that composes an icon. */
export interface IconPrimitive {
  type: 'circle' | 'rect' | 'path' | 'line' | 'polygon' | 'ellipse';
  attrs: Record<string, string | number>;
}

/** An icon definition — a named set of primitives. */
export interface IconDefinition {
  name: string;
  category: string;
  primitives: IconPrimitive[];
  /** Whether this icon supports fill (for filled/duotone variants). */
  fillable?: boolean;
}

/** Render options for an icon. */
export interface IconRenderOptions {
  size?: IconSize;
  variant?: IconVariant;
  color?: string;       // primary stroke/fill color
  secondaryColor?: string; // for duotone
  strokeWidth?: number;
  className?: string;
}

const CATEGORIES = [
  'ai', 'education', 'healthcare', 'finance', 'agriculture', 'transport',
  'marketplace', 'robotics', 'analytics', 'security', 'cloud', 'communication',
  'media', 'payments', 'identity', 'notifications', 'files', 'calendar',
  'maps', 'reports', 'wallet', 'crypto', 'nfc', 'qr', 'biometrics',
  'settings', 'users', 'organizations', 'subscriptions',
] as const;

export type IconCategory = (typeof CATEGORIES)[number];

/** The icon primitive registry — each category has named icons. */
const ICON_REGISTRY: Record<string, IconDefinition> = {};

/** Register an icon definition. */
export function registerIcon(def: IconDefinition): void {
  ICON_REGISTRY[def.name] = def;
}

/** Get an icon definition. */
export function getIcon(name: string): IconDefinition | undefined {
  return ICON_REGISTRY[name];
}

/** List all registered icons (optionally by category). */
export function listIcons(category?: string): string[] {
  const names = Object.keys(ICON_REGISTRY);
  return category ? names.filter((n) => ICON_REGISTRY[n]!.category === category) : names;
}

/** List all categories that have icons. */
export function listCategories(): string[] {
  return [...new Set(Object.values(ICON_REGISTRY).map((i) => i.category))];
}

/**
 * Render an icon to an SVG string. Applies variant styling:
 * - outline: stroke-only, transparent fill
 * - filled: fill = primary, no stroke
 * - duotone: two layers (primary fill + secondary at 40% opacity)
 * - glass: semi-transparent fill + backdrop-blur filter
 * - rounded: stroke-linejoin/cap = round
 * - sharp: stroke-linejoin/cap = butt
 * - animated: CSS pulse animation on the outer group
 */
export function renderIcon(name: string, opts: IconRenderOptions = {}): string {
  const def = ICON_REGISTRY[name];
  if (!def) throw new Error(`icon "${name}" not found`);
  const size = opts.size ?? 24;
  const variant = opts.variant ?? 'outline';
  const color = opts.color ?? 'currentColor';
  const secondary = opts.secondaryColor ?? 'currentColor';
  const strokeWidth = opts.strokeWidth ?? 1.5;
  const cls = opts.className ?? '';

  const styles = getVariantStyles(variant, color, secondary, strokeWidth);
  const animClass = variant === 'animated' ? ' class="jq-icon-pulse"' : '';
  const animStyle = variant === 'animated'
    ? '<style>.jq-icon-pulse{animation:jq-pulse 2s ease-in-out infinite}@keyframes jq-pulse{0%,100%{opacity:1}50%{opacity:0.5}}</style>'
    : '';

  const body = def.primitives.map((p) => renderPrimitive(p, styles)).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"${animClass}${cls ? ` class="${cls}"` : ''}>\n  ${animStyle}\n  ${body}\n</svg>`;
}

interface VariantStyles { fill: string; stroke: string; strokeWidth: number; secondaryFill: string; opacity: number; strokeLinecap: string; strokeLinejoin: string; }

function getVariantStyles(variant: IconVariant, color: string, secondary: string, sw: number): VariantStyles {
  const base: VariantStyles = {
    fill: 'none', stroke: color, strokeWidth: sw,
    secondaryFill: secondary, opacity: 1,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  };
  switch (variant) {
    case 'filled': return { ...base, fill: color, stroke: 'none', strokeWidth: 0 };
    case 'duotone': return { ...base, fill: color, stroke: color, secondaryFill: secondary, opacity: 0.4 };
    case 'glass': return { ...base, fill: color, stroke: color, opacity: 0.6 };
    case 'rounded': return { ...base, strokeLinecap: 'round', strokeLinejoin: 'round' };
    case 'sharp': return { ...base, strokeLinecap: 'butt', strokeLinejoin: 'miter' };
    case 'animated': return base;
    default: return base; // outline
  }
}

function renderPrimitive(p: IconPrimitive, styles: VariantStyles): string {
  const tag = p.type;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.attrs)) attrs[k] = String(v);
  // Apply variant styling.
  if (styles.fill !== 'none') attrs['fill'] = attrs['fill'] ?? styles.fill;
  else attrs['fill'] = attrs['fill'] ?? 'none';
  if (styles.stroke !== 'none' && styles.strokeWidth > 0) {
    attrs['stroke'] = attrs['stroke'] ?? styles.stroke;
    attrs['stroke-width'] = attrs['stroke-width'] ?? String(styles.strokeWidth);
  }
  attrs['stroke-linecap'] = styles.strokeLinecap;
  attrs['stroke-linejoin'] = styles.strokeLinejoin;
  if (styles.opacity < 1) attrs['opacity'] = String(styles.opacity);
  const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<${tag} ${attrStr} />`;
}

// ---- Built-in icon definitions (seed set per category) -------------------

function circleIcon(name: string, category: string, cx = 12, cy = 12, r = 8): IconDefinition {
  return { name, category, fillable: true, primitives: [{ type: 'circle', attrs: { cx, cy, r } }] };
}

function pathIcon(name: string, category: string, d: string): IconDefinition {
  return { name, category, fillable: true, primitives: [{ type: 'path', attrs: { d } }] };
}

// AI
registerIcon(pathIcon('ai-brain', 'ai', 'M12 2a4 4 0 0 0-4 4v1a4 4 0 0 0-1 7.5A3.5 3.5 0 0 0 12 22a3.5 3.5 0 0 0 5-7.5A4 4 0 0 0 16 7V6a4 4 0 0 0-4-4z'));
registerIcon(circleIcon('ai-spark', 'ai', 12, 12, 4));
registerIcon(pathIcon('ai-chip', 'ai', 'M6 6h12v12H6z M9 9h6v6H9z M3 9h3 M3 15h3 M18 9h3 M18 15h3 M9 3v3 M15 3v3 M9 18v3 M15 18v3'));

// Education
registerIcon(pathIcon('edu-book', 'education', 'M4 4h11a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z M4 4v15'));
registerIcon(pathIcon('edu-cap', 'education', 'M2 8l10-4 10 4-10 4z M6 10v5a6 3 0 0 0 12 0v-5'));

// Healthcare
registerIcon(pathIcon('health-heart', 'healthcare', 'M12 21s-7-5-9-10a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 5-9 10-9 10z'));
registerIcon(pathIcon('health-cross', 'healthcare', 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z'));

// Finance
registerIcon(pathIcon('fin-chart', 'finance', 'M3 3v18h18 M7 14l4-4 3 3 5-6'));
registerIcon(pathIcon('fin-coins', 'finance', 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M11 11a6 6 0 1 0 0-12 6 6 0 0 0 0 12z'));
registerIcon(circleIcon('fin-dollar', 'finance', 12, 12, 10));

// Agriculture
registerIcon(pathIcon('agri-leaf', 'agriculture', 'M12 22c0-8 0-14 8-18-2 8-4 12-8 14 M12 22V10'));
registerIcon(pathIcon('agri-plant', 'agriculture', 'M12 22V8 M12 8c0-4 4-6 6-6-2 4-3 6-6 6 M12 8c0-4-4-6-6-6 2 4 3 6 6 6'));

// Transport
registerIcon(pathIcon('trans-car', 'transport', 'M3 12l2-6h14l2 6v6h-2v-2H5v2H3z M7 15h2 M15 15h2'));
registerIcon(pathIcon('trans-plane', 'transport', 'M12 2l3 8h7l-5 4 2 8-7-5-7 5 2-8-5-4h7z'));

// Security
registerIcon(pathIcon('sec-shield', 'security', 'M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6z'));
registerIcon(pathIcon('sec-lock', 'security', 'M6 10V7a6 6 0 0 1 12 0v3 M5 10h14v10H5z M12 14v2'));

// Cloud
registerIcon(pathIcon('cloud-server', 'cloud', 'M6 16a4 4 0 0 1 0-8 6 6 0 0 1 12 0 4 4 0 0 1 0 8z'));

// Communication
registerIcon(pathIcon('comm-chat', 'communication', 'M4 4h16v12H8l-4 4z'));
registerIcon(pathIcon('comm-mail', 'communication', 'M3 5h18v14H3z M3 5l9 7 9-7'));

// Payments
registerIcon(pathIcon('pay-card', 'payments', 'M3 6h18v12H3z M3 10h18 M7 15h4'));
registerIcon(pathIcon('pay-wallet', 'payments', 'M3 7h15v10H3z M18 10h3v4h-3a2 2 0 0 1 0-4z'));

// Identity
registerIcon(pathIcon('id-user', 'identity', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20a8 8 0 0 1 16 0'));
registerIcon(pathIcon('id-key', 'identity', 'M14 7a4 4 0 1 1-4 4l-7 7v3h3l1-1h2v-2h2l2-2'));

// Notifications
registerIcon(pathIcon('bell', 'notifications', 'M6 8a6 6 0 0 1 12 0c0 7 3 5 3 9H3c0-4 3-2 3-9 M10 21a2 2 0 0 0 4 0'));

// Files
registerIcon(pathIcon('file-doc', 'files', 'M6 2h8l4 4v16H6z M14 2v4h4 M8 12h8 M8 16h8 M8 8h4'));

// Calendar
registerIcon(pathIcon('calendar', 'calendar', 'M3 5h18v16H3z M3 9h18 M8 3v4 M16 3v4'));

// Maps
registerIcon(pathIcon('map-pin', 'maps', 'M12 22s8-7 8-12a8 8 0 0 0-16 0c0 5 8 12 8 12z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'));

// Analytics
registerIcon(pathIcon('analytics-bar', 'analytics', 'M3 20h18 M7 20v-8 M12 20V8 M17 20v-12'));
registerIcon(pathIcon('analytics-pie', 'analytics', 'M12 2a10 10 0 1 0 0 20V12z M12 2v10h10A10 10 0 0 0 12 2z'));

// Wallet
registerIcon(pathIcon('wallet-balance', 'wallet', 'M3 7h15v10H3z M18 10h3v4h-3a2 2 0 0 1 0-4z'));

// Crypto
registerIcon(pathIcon('crypto-bitcoin', 'crypto', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M9 7v10 M9 7h4a2 2 0 0 1 0 4H9 M9 11h4a2 2 0 0 1 0 4H9 M11 4v3 M11 17v3'));

// Settings
registerIcon(pathIcon('settings-gear', 'settings', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v3 M12 19v3 M4.2 4.2l2.1 2.1 M17.7 17.7l2.1 2.1 M2 12h3 M19 12h3 M4.2 19.8l2.1-2.1 M17.7 6.3l2.1-2.1'));

// Users
registerIcon(pathIcon('users-group', 'users', 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 20a7 7 0 0 1 14 0 M17 12a3 3 0 1 0 0-6 M22 20a5 5 0 0 0-5-5'));

// Organizations
registerIcon(pathIcon('org-building', 'organizations', 'M4 22V4h10v18 M14 22V8h6v14 M8 8h2 M8 12h2 M8 16h2'));

// QR
registerIcon(pathIcon('qr-code', 'qr', 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h3v3h-3z M20 14v3 M14 20h3 M20 20v1'));

// NFC
registerIcon(pathIcon('nfc-wave', 'nfc', 'M6 8a8 8 0 0 1 0 8 M10 6a12 12 0 0 1 0 12 M14 4a16 16 0 0 1 0 16'));

// Biometrics
registerIcon(pathIcon('bio-fingerprint', 'biometrics', 'M12 4a8 8 0 0 0-8 8 M12 4a8 8 0 0 1 8 8 M12 8a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0 M12 12v2'));

// Marketplace
registerIcon(pathIcon('market-shop', 'marketplace', 'M4 8h16l-1 4H5z M5 12v8h14v-8 M9 12v8 M15 12v8 M4 8l1-4h14l1 4'));

// Subscriptions
registerIcon(pathIcon('sub-repeat', 'subscriptions', 'M4 12a8 8 0 0 1 16 0 M20 8v4h-4 M20 12a8 8 0 0 1-16 0 M4 16v-4h4'));

// Reports
registerIcon(pathIcon('report-doc', 'reports', 'M6 2h12v20H6z M6 2l-2 2v18l2-2 M18 2l2 2v18l-2-2 M9 7h6 M9 11h6 M9 15h4'));

// Media
registerIcon(pathIcon('media-play', 'media', 'M6 4l14 8-14 8z'));
registerIcon(pathIcon('media-camera', 'media', 'M3 7h4l2-3h6l2 3h4v12H3z M12 10a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'));

// Robotics
registerIcon(pathIcon('robot', 'robotics', 'M8 4h8v8H8z M12 4V1 M10 7h1 M13 7h1 M6 12h12v8H6z M9 16h1 M14 16h1'));

export { CATEGORIES };
