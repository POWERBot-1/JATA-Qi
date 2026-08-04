// @jataqi/branding — JATA Qi brand identity system. Public API.

export { BrandingModule, BrandingEvents, PRODUCT_BRANDS } from './branding-module.js';
export { getBrand, listProducts } from './product-registry.js';
export {
  generateLogo, generateLogoMark, generateAppIcon, generateSplashScreen,
  generateMarketingTemplate, generateBusinessCard, generateEmailSignature, generateBrandCss,
} from './logo-engine.js';
export type {
  BrandKit, BrandPalette, BrandTypography, LogoVariant, SplashScreen,
  AppIcon, MarketingTemplate, BusinessCard, EmailSignature,
} from './types.js';
