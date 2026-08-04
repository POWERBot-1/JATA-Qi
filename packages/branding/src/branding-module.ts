// BrandingModule — kernel module exposing the brand system. Generates logos,
// app icons, splash screens, marketing templates, business cards, email
// signatures, and brand CSS for any of the 15 JATA Qi products (or custom
// brand kits). Integrates with the design system for token resolution.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { PRODUCT_BRANDS, getBrand, listProducts } from './product-registry.js';
import { generateLogo, generateLogoMark, generateAppIcon, generateSplashScreen, generateMarketingTemplate, generateBusinessCard, generateEmailSignature, generateBrandCss } from './logo-engine.js';
import type { BrandKit, BusinessCard, EmailSignature, LogoVariant, SplashScreen, AppIcon, MarketingTemplate } from './types.js';

export const BrandingEvents = Object.freeze({
  BrandGenerated: 'branding.generated',
} as const);

export class BrandingModule implements IModule {
  readonly id = 'branding';
  readonly tags = ['core', 'ui'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private customBrands = new Map<string, BrandKit>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('branding', this);
    kernel.logger.info(`branding module initialized (${listProducts().length} products)`);
  }
  async start(_kernel: KernelApi): Promise<void> {}
  async stop(_kernel: KernelApi): Promise<void> {}

  // ---- brand management ---------------------------------------------------

  getBrand(productId: string): BrandKit | undefined {
    return this.customBrands.get(productId) ?? getBrand(productId);
  }

  listProducts(): string[] {
    return [...listProducts(), ...this.customBrands.keys()];
  }

  /** Register a custom brand kit (for non-standard products). */
  registerBrand(kit: BrandKit): void {
    this.customBrands.set(kit.productId, kit);
  }

  // ---- asset generation ---------------------------------------------------

  generateLogo(productId: string, size?: number): LogoVariant {
    const kit = this.requireBrand(productId);
    return generateLogo(kit, size);
  }

  generateLogoMark(productId: string, size?: number): LogoVariant {
    const kit = this.requireBrand(productId);
    return generateLogoMark(kit, size);
  }

  generateAppIcon(productId: string, size?: number): AppIcon {
    const kit = this.requireBrand(productId);
    return generateAppIcon(kit, size);
  }

  generateSplashScreen(productId: string): SplashScreen {
    const kit = this.requireBrand(productId);
    return generateSplashScreen(kit);
  }

  generateMarketingTemplate(productId: string, name: string, width?: number, height?: number): MarketingTemplate {
    const kit = this.requireBrand(productId);
    return generateMarketingTemplate(kit, name, width, height);
  }

  generateBusinessCard(input: BusinessCard, productId: string): string {
    const kit = this.requireBrand(productId);
    return generateBusinessCard(input, kit);
  }

  generateEmailSignature(input: EmailSignature): string {
    return generateEmailSignature(input);
  }

  generateBrandCss(productId: string): string {
    const kit = this.requireBrand(productId);
    return generateBrandCss(kit);
  }

  /** Generate a complete brand package (all assets at once). */
  generateBrandPackage(productId: string): {
    logo: LogoVariant; logoMark: LogoVariant; appIcon: AppIcon;
    splash: SplashScreen; socialCard: MarketingTemplate; css: string;
  } {
    const kit = this.requireBrand(productId);
    void this.api.bus.emit(BrandingEvents.BrandGenerated, { productId });
    return {
      logo: generateLogo(kit),
      logoMark: generateLogoMark(kit),
      appIcon: generateAppIcon(kit),
      splash: generateSplashScreen(kit),
      socialCard: generateMarketingTemplate(kit, 'social-card', 1200, 630),
      css: generateBrandCss(kit),
    };
  }

  private requireBrand(productId: string): BrandKit {
    const kit = this.getBrand(productId);
    if (!kit) throw new Error(`brand "${productId}" not found — registered: ${this.listProducts().join(', ')}`);
    return kit;
  }
}

export { PRODUCT_BRANDS };
