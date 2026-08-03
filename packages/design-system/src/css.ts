// CSS generation — compiles the token bundle into CSS custom properties
// (`--jq-*`) and a component primitive stylesheet. Pure, deterministic string
// builders so output can be snapshot-tested and consumed by the vanilla web-ui
// (replacing its ad-hoc inline tokens).

import { resolveTheme, type BrandOverride, type ThemeMode } from './theme.js';

const NS = 'jq';

/** Convert a token key to a kebab CSS variable name (e.g. 'primary' -> '--jq-color-primary'). */
function cssVar(group: string, key: string): string {
  return `--${NS}-${group}-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/\./g, '-')}`;
}

/** Emit the CSS custom-property block for one theme mode. */
export function generateThemeVars(mode: ThemeMode, brand?: BrandOverride): string {
  const t = resolveTheme(mode, brand);
  const lines: string[] = [`[data-theme="${mode}"] {`];
  for (const [role, value] of Object.entries(t.colors)) lines.push(`  ${cssVar('color', role)}: ${value};`);
  for (const [k, v] of Object.entries(t.typography.family)) lines.push(`  ${cssVar('font', k)}: ${v};`);
  for (const [k, v] of Object.entries(t.typography.size)) lines.push(`  ${cssVar('text', k)}: ${v}px;`);
  for (const [k, v] of Object.entries(t.typography.weight)) lines.push(`  ${cssVar('weight', k)}: ${v};`);
  for (const [k, v] of Object.entries(t.typography.lineHeight)) lines.push(`  ${cssVar('leading', k)}: ${v};`);
  for (const [k, v] of Object.entries(t.spacing)) lines.push(`  ${cssVar('space', String(k))}: ${v}px;`);
  for (const [k, v] of Object.entries(t.radius)) lines.push(`  ${cssVar('radius', k)}: ${v}px;`);
  for (const [k, v] of Object.entries(t.elevation)) lines.push(`  ${cssVar('elev', k)}: ${v};`);
  for (const [k, v] of Object.entries(t.motion.duration)) lines.push(`  ${cssVar('duration', k)}: ${v}ms;`);
  for (const [k, v] of Object.entries(t.motion.easing)) lines.push(`  ${cssVar('ease', k)}: ${v};`);
  for (const [k, v] of Object.entries(t.breakpoints)) lines.push(`  ${cssVar('bp', k)}: ${v}px;`);
  for (const [k, v] of Object.entries(t.zIndex)) lines.push(`  ${cssVar('z', k)}: ${v};`);
  lines.push(`  ${cssVar('glass', 'blur')}: ${t.glass.blur}px;`);
  lines.push(`  ${cssVar('glass', 'saturation')}: ${t.glass.saturation};`);
  lines.push('}');
  return lines.join('\n');
}

/** Base reset + typography + accessible focus ring. */
export function generateBaseCss(): string {
  return `*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { font-family: var(--jq-font-sans); background: var(--jq-color-background); color: var(--jq-color-text); line-height: var(--jq-leading-normal); -webkit-font-smoothing: antialiased; }
a { color: var(--jq-color-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--jq-color-primary); outline-offset: 2px; border-radius: var(--jq-radius-sm); }
::selection { background: color-mix(in srgb, var(--jq-color-primary) 28%, transparent); }
.jq-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }`;
}

/** Component primitives built entirely from tokens. */
export function generateComponentCss(): string {
  return [
    // Buttons
    `.jq-btn { display: inline-flex; align-items: center; gap: 8px; font-family: inherit; font-size: var(--jq-text-sm); font-weight: var(--jq-weight-medium); line-height: 1; cursor: pointer; border: 1px solid transparent; border-radius: var(--jq-radius-md); padding: 10px 18px; transition: transform var(--jq-duration-fast) var(--jq-ease-standard), background var(--jq-duration-fast) var(--jq-ease-standard), box-shadow var(--jq-duration-fast) var(--jq-ease-standard); }`,
    `.jq-btn:active { transform: translateY(1px) scale(0.99); }`,
    `.jq-btn-primary { background: var(--jq-color-primary); color: var(--jq-color-primary-fg); box-shadow: var(--jq-elev-z1); }`,
    `.jq-btn-primary:hover { background: var(--jq-color-primary-dim); box-shadow: var(--jq-elev-z2); }`,
    `.jq-btn-secondary { background: var(--jq-color-surface-elevated); color: var(--jq-color-text); border-color: var(--jq-color-border); }`,
    `.jq-btn-ghost { background: transparent; color: var(--jq-color-text-muted); }`,
    `.jq-btn-ghost:hover { background: var(--jq-color-surface-elevated); color: var(--jq-color-text); }`,
    `.jq-btn-danger { background: var(--jq-color-danger); color: var(--jq-color-danger-fg); }`,
    `.jq-btn-sm { padding: 6px 12px; font-size: var(--jq-text-xs); }`,
    `.jq-btn-lg { padding: 14px 24px; font-size: var(--jq-text-lg); }`,
    `.jq-btn:disabled { opacity: 0.5; cursor: not-allowed; }`,
    // Cards
    `.jq-card { background: var(--jq-color-surface); border: 1px solid var(--jq-color-border); border-radius: var(--jq-radius-lg); padding: var(--jq-space-3); box-shadow: var(--jq-elev-z1); }`,
    `.jq-card-elevated { box-shadow: var(--jq-elev-z3); }`,
    `.jq-card-title { font-size: var(--jq-text-xs); color: var(--jq-color-text-muted); text-transform: uppercase; letter-spacing: var(--jq-letter-spacing-wide, 0.04em); margin-bottom: var(--jq-space-1-5); }`,
    // Inputs / forms
    `.jq-input, .jq-select, .jq-textarea { width: 100%; background: var(--jq-color-background); border: 1px solid var(--jq-color-border-strong); border-radius: var(--jq-radius-md); padding: 10px 14px; color: var(--jq-color-text); font-family: inherit; font-size: var(--jq-text-sm); transition: border-color var(--jq-duration-fast) var(--jq-ease-standard); }`,
    `.jq-input:focus, .jq-select:focus, .jq-textarea:focus { outline: none; border-color: var(--jq-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--jq-color-primary) 22%, transparent); }`,
    `.jq-label { display: block; font-size: var(--jq-text-xs); font-weight: var(--jq-weight-medium); color: var(--jq-color-text-muted); margin-bottom: 6px; }`,
    // Tables
    `.jq-table { width: 100%; border-collapse: collapse; font-size: var(--jq-text-sm); }`,
    `.jq-table th { text-align: left; font-weight: var(--jq-weight-semibold); color: var(--jq-color-text-muted); padding: var(--jq-space-1-5); border-bottom: 1px solid var(--jq-color-border); }`,
    `.jq-table td { padding: var(--jq-space-1-5); border-bottom: 1px solid var(--jq-color-border); }`,
    `.jq-table tr:hover td { background: var(--jq-color-surface-elevated); }`,
    // Navigation + sidebar
    `.jq-sidebar { width: 256px; background: var(--jq-color-surface); border-right: 1px solid var(--jq-color-border); padding: var(--jq-space-2) 0; }`,
    `.jq-nav-item { display: flex; align-items: center; gap: 12px; padding: 10px var(--jq-space-3); color: var(--jq-color-text-muted); cursor: pointer; border-radius: 0; transition: background var(--jq-duration-fast) var(--jq-ease-standard), color var(--jq-duration-fast) var(--jq-ease-standard); }`,
    `.jq-nav-item:hover { background: var(--jq-color-surface-elevated); color: var(--jq-color-text); }`,
    `.jq-nav-item.is-active { color: var(--jq-color-primary); background: color-mix(in srgb, var(--jq-color-primary) 12%, transparent); }`,
    // Badges
    `.jq-badge { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: var(--jq-radius-full); font-size: var(--jq-text-xs); font-weight: var(--jq-weight-semibold); }`,
    `.jq-badge-success { background: color-mix(in srgb, var(--jq-color-success) 18%, transparent); color: var(--jq-color-success); }`,
    `.jq-badge-warning { background: color-mix(in srgb, var(--jq-color-warning) 18%, transparent); color: var(--jq-color-warning); }`,
    `.jq-badge-danger { background: color-mix(in srgb, var(--jq-color-danger) 18%, transparent); color: var(--jq-color-danger); }`,
    // Dialog + toast
    `.jq-dialog-backdrop { position: fixed; inset: 0; background: rgba(8,10,20,0.5); backdrop-filter: blur(4px); z-index: var(--jq-z-modal); display: grid; place-items: center; }`,
    `.jq-dialog { background: var(--jq-color-surface-elevated); border: 1px solid var(--jq-color-border); border-radius: var(--jq-radius-xl); box-shadow: var(--jq-elev-z5); padding: var(--jq-space-4); min-width: 360px; max-width: 90vw; }`,
    `.jq-toast { background: var(--jq-color-surface-elevated); color: var(--jq-color-text); border: 1px solid var(--jq-color-border); border-radius: var(--jq-radius-lg); padding: var(--jq-space-1-5) var(--jq-space-2); box-shadow: var(--jq-elev-z3); z-index: var(--jq-z-toast); }`,
    // States
    `.jq-skeleton { background: linear-gradient(90deg, var(--jq-color-surface-elevated) 25%, var(--jq-color-border) 37%, var(--jq-color-surface-elevated) 63%); background-size: 400% 100%; animation: jq-shimmer 1.4s var(--jq-ease-standard) infinite; border-radius: var(--jq-radius-md); }`,
    `@keyframes jq-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }`,
    `.jq-spinner { width: 18px; height: 18px; border: 2px solid var(--jq-color-border); border-top-color: var(--jq-color-primary); border-radius: 50%; animation: jq-spin 0.7s linear infinite; }`,
    `@keyframes jq-spin { to { transform: rotate(360deg); } }`,
  ].join('\n');
}

/** Utility classes (glassmorphism, elevation, motion). */
export function generateUtilityCss(): string {
  return [
    `.jq-glass { background: var(--jq-color-surface-glass); backdrop-filter: blur(var(--jq-glass-blur)) saturate(var(--jq-glass-saturation)); -webkit-backdrop-filter: blur(var(--jq-glass-blur)) saturate(var(--jq-glass-saturation)); border: 1px solid rgba(255,255,255,0.12); box-shadow: var(--jq-elev-glass); }`,
    `.jq-elev-1 { box-shadow: var(--jq-elev-z1); }`, `.jq-elev-2 { box-shadow: var(--jq-elev-z2); }`,
    `.jq-elev-3 { box-shadow: var(--jq-elev-z3); }`, `.jq-elev-4 { box-shadow: var(--jq-elev-z4); }`,
    `.jq-fade-in { animation: jq-fade var(--jq-duration-normal) var(--jq-ease-decelerate); }`,
    `@keyframes jq-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }`,
    `.jq-flex { display: flex; }`, `.jq-gap-2 { gap: var(--jq-space-2); }`, `.jq-gap-3 { gap: var(--jq-space-3); }`,
    `.jq-text-muted { color: var(--jq-color-text-muted); }`,
  ].join('\n');
}

/** Generate the complete stylesheet (both themes + base + components + utilities). */
export function generateStylesheet(opts: { brand?: BrandOverride; defaultMode?: ThemeMode } = {}): string {
  const dark = generateThemeVars('dark', opts.brand);
  const light = generateThemeVars('light', opts.brand);
  const header = '/* JATA Qi Design System — generated. Do not edit by hand. */';
  return [
    header,
    `:root { color-scheme: ${opts.defaultMode ?? 'dark'}; }`,
    light,
    dark,
    `[data-theme="dark"] { color-scheme: dark; }`,
    `[data-theme="light"] { color-scheme: light; }`,
    generateBaseCss(),
    generateComponentCss(),
    generateUtilityCss(),
  ].join('\n\n');
}
