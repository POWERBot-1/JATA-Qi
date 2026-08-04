// Logo Engine — generates SVG logos, app icons, and splash screens from a
// BrandKit. Each product gets a unique geometric logo mark derived from its
// configured shape + glyph + palette. No static assets — everything is
// generated on demand.

import type { AppIcon, BrandKit, LogoVariant, SplashScreen, MarketingTemplate, BusinessCard, EmailSignature } from './types.js';

/** Generate a logo SVG from a brand kit at a given size. */
export function generateLogo(kit: BrandKit, size = 200): LogoVariant {
  const half = size / 2;
  const inner = half * 0.65;
  const shape = drawShape(kit.logoShape, half, inner, kit.palette.primary);
  const text = `<text x="${half}" y="${half + 8}" text-anchor="middle" font-size="${inner * 0.8}" font-family="sans-serif" font-weight="700" fill="${kit.palette.text}">${escapeXml(kit.logoGlyph)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.12}" fill="${kit.palette.background}"/>
  ${shape}
  ${text}
</svg>`;
  return { format: 'svg', content: svg, width: size, height: size };
}

/** Generate a compact logo mark (icon-only, no text). */
export function generateLogoMark(kit: BrandKit, size = 48): LogoVariant {
  const half = size / 2;
  const inner = half * 0.7;
  const shape = drawShape(kit.logoShape, half, inner, kit.palette.primary);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="${kit.palette.primary}"/>
  ${drawShape(kit.logoShape, half, inner * 0.8, kit.palette.text)}
</svg>`;
  return { format: 'svg', content: svg, width: size, height: size };
}

/** Generate an app icon (squared, rounded corners). */
export function generateAppIcon(kit: BrandKit, size = 512): AppIcon {
  const mark = generateLogoMark(kit, size);
  return {
    size,
    backgroundColor: kit.palette.primary,
    iconColor: kit.palette.text,
    borderRadius: Math.round(size * 0.22),
    svg: mark.content,
  };
}

/** Generate a splash screen. */
export function generateSplashScreen(kit: BrandKit): SplashScreen {
  return {
    backgroundColor: kit.palette.background,
    logoColor: kit.palette.primary,
    text: kit.productName,
    textColor: kit.palette.text,
    fontFamily: kit.typography.displayFont,
  };
}

/** Generate a marketing template (social media card, presentation slide). */
export function generateMarketingTemplate(kit: BrandKit, name: string, width = 1200, height = 630): MarketingTemplate {
  return {
    name, width, height,
    backgroundColor: kit.palette.background,
    primaryText: kit.tagline,
    primaryTextColor: kit.palette.text,
    fontFamily: kit.typography.displayFont,
    logoPosition: 'top-left',
  };
}

/** Generate a business card (front side SVG). */
export function generateBusinessCard(card: BusinessCard, kit: BrandKit): string {
  const w = 350, h = 200;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" rx="8" fill="${card.backgroundColor}"/>
  <rect x="0" y="0" width="6" height="${h}" rx="3" fill="${card.accentColor}"/>
  <text x="24" y="50" font-family="sans-serif" font-size="18" font-weight="700" fill="${card.textColor}">${escapeXml(card.name)}</text>
  <text x="24" y="72" font-size="12" fill="${card.accentColor}">${escapeXml(card.title)}</text>
  <text x="24" y="110" font-size="11" fill="${card.textColor}">${escapeXml(card.email)}</text>
  ${card.phone ? `<text x="24" y="128" font-size="11" fill="${card.textColor}">${escapeXml(card.phone)}</text>` : ''}
  <text x="24" y="170" font-size="14" font-weight="600" fill="${card.accentColor}">${escapeXml(card.company)}</text>
</svg>`;
}

/** Generate an HTML email signature. */
export function generateEmailSignature(sig: EmailSignature): string {
  return `<table style="font-family:${sig.fontFamily},sans-serif;font-size:14px;color:#333;">
  <tr><td style="padding-right:12px;border-right:3px solid ${sig.accentColor};">
    <strong style="color:${sig.accentColor};">${escapeXml(sig.name)}</strong><br>
    <span style="color:#666;">${escapeXml(sig.title)}</span>
  </td><td style="padding-left:12px;">
    <a href="mailto:${escapeXml(sig.email)}" style="color:#333;text-decoration:none;">${escapeXml(sig.email)}</a><br>
    ${sig.phone ? `<span style="color:#666;">${escapeXml(sig.phone)}</span><br>` : ''}
    <a href="${escapeXml(sig.website)}" style="color:${sig.accentColor};text-decoration:none;">${escapeXml(sig.website)}</a>
  </td></tr>
</table>`;
}

/** Generate CSS custom properties for a brand kit. */
export function generateBrandCss(kit: BrandKit): string {
  return `:root {
  --brand-primary: ${kit.palette.primary};
  --brand-primary-dim: ${kit.palette.primaryDim};
  --brand-secondary: ${kit.palette.secondary};
  --brand-accent: ${kit.palette.accent};
  --brand-background: ${kit.palette.background};
  --brand-surface: ${kit.palette.surface};
  --brand-text: ${kit.palette.text};
  --brand-display-font: ${kit.typography.displayFont};
  --brand-body-font: ${kit.typography.bodyFont};
  --brand-mono-font: ${kit.typography.monoFont};
}`;
}

// ---- shape drawing --------------------------------------------------------

function drawShape(shape: BrandKit['logoShape'], cx: number, r: number, color: string): string {
  const pts = shapePoints(shape, cx, r);
  if (shape === 'circle') return `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="${r * 0.12}"/>`;
  return `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="${r * 0.1}" stroke-linejoin="round"/>`;
}

function shapePoints(shape: BrandKit['logoShape'], cx: number, r: number): string {
  const points: Array<[number, number]> = [];
  let sides: number;
  switch (shape) {
    case 'hexagon': sides = 6; break;
    case 'triangle': sides = 3; break;
    case 'diamond': sides = 4; break;
    case 'square': sides = 4; break;
    case 'shield': sides = 5; break;
    default: sides = 6;
  }
  const rotation = shape === 'square' ? Math.PI / 4 : shape === 'diamond' ? 0 : -Math.PI / 2;
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i * 2 * Math.PI) / sides;
    points.push([cx + r * Math.cos(angle), cx + r * Math.sin(angle)]);
  }
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => { switch (c) { case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;'; case "'": return '&apos;'; default: return '&quot;'; } });
}
