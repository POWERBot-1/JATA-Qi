// JATA Qi Branding — types. Per-product brand identity system. Each product
// gets a unique palette, typography pairing, logo variant, splash screen,
// and marketing asset definitions — all derived from the shared design system
// so every product is visually unique yet unmistakably JATA Qi.

/** Brand color palette for a product. */
export interface BrandPalette {
  primary: string;
  primaryDim: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
}

/** Typography pairing for a product. */
export interface BrandTypography {
  displayFont: string;
  bodyFont: string;
  monoFont: string;
  displayWeight: number;
  bodyWeight: number;
}

/** Logo variant — generated programmatically from geometric primitives. */
export interface LogoVariant {
  format: 'svg';
  content: string;
  width: number;
  height: number;
}

/** A splash screen definition. */
export interface SplashScreen {
  backgroundColor: string;
  logoColor: string;
  text: string;
  textColor: string;
  fontFamily: string;
}

/** An app icon definition (square, rounded). */
export interface AppIcon {
  size: number;
  backgroundColor: string;
  iconColor: string;
  borderRadius: number;
  svg: string;
}

/** A marketing template definition. */
export interface MarketingTemplate {
  name: string;
  width: number;
  height: number;
  backgroundColor: string;
  primaryText: string;
  primaryTextColor: string;
  fontFamily: string;
  logoPosition: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-right';
}

/** A complete brand kit for a JATA Qi product. */
export interface BrandKit {
  productId: string;
  productName: string;
  tagline: string;
  palette: BrandPalette;
  typography: BrandTypography;
  logoGlyph: string; // single-character or short symbol used in the logo mark
  logoShape: 'hexagon' | 'circle' | 'square' | 'triangle' | 'diamond' | 'shield';
  createdAt: number;
}

/** Business card layout. */
export interface BusinessCard {
  name: string;
  title: string;
  email: string;
  phone?: string;
  company: string;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
}

/** Email signature template. */
export interface EmailSignature {
  name: string;
  title: string;
  email: string;
  phone?: string;
  website: string;
  accentColor: string;
  fontFamily: string;
}
