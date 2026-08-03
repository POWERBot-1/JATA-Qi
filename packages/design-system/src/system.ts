// DesignSystemModule — kernel module exposing the design tokens, theme
// resolution, and generated stylesheet to the rest of the platform (web-ui,
// branding, dashboard, shell). Supports adaptive mode selection (time-of-day /
// user preference) and emits theme-change events.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { resolveTheme, themeForHour, type ThemeMode } from './theme.js';
import type { BrandOverride, ThemeTokens } from './tokens.js';
import { generateStylesheet } from './css.js';

export const DesignSystemEvents = Object.freeze({
  ThemeChanged: 'design-system.theme.changed',
  BrandChanged: 'design-system.brand.changed',
} as const);

export interface AdaptiveThemeInput {
  /** Explicit user preference (wins over time-of-day). */
  preference?: ThemeMode | 'auto';
  /** Local hour 0..23 (used when preference is 'auto'). */
  hour?: number;
}

export class DesignSystemModule implements IModule {
  readonly id = 'design-system';
  readonly tags = ['core', 'ui'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private mode: ThemeMode = 'dark';
  private brand?: BrandOverride;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('design-system', this);
    kernel.logger.info(`design-system initialized (mode=${this.mode})`);
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  get currentMode(): ThemeMode { return this.mode; }
  get currentBrand(): BrandOverride | undefined { return this.brand; }

  /** Resolve the full token bundle for a mode (defaults to the active mode). */
  tokens(mode: ThemeMode = this.mode, brand?: BrandOverride): ThemeTokens {
    return resolveTheme(mode, brand ?? this.brand);
  }

  /** Generate the complete stylesheet (both themes + brand). */
  stylesheet(brand?: BrandOverride): string {
    return generateStylesheet({ brand: brand ?? this.brand, defaultMode: this.mode });
  }

  /** Set the active theme mode; emits a change event. */
  setMode(mode: ThemeMode): void {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    void this.api.bus.emit(DesignSystemEvents.ThemeChanged, { from: prev, to: mode });
  }

  /** Apply a per-product brand override; emits a change event. */
  setBrand(brand?: BrandOverride): void {
    this.brand = brand;
    void this.api.bus.emit(DesignSystemEvents.BrandChanged, { ...(brand ?? {}) });
  }

  /** Adaptively resolve a theme from user preference + local hour. */
  resolveAdaptive(input: AdaptiveThemeInput = {}): ThemeMode {
    if (input.preference && input.preference !== 'auto') return input.preference;
    const hour = input.hour ?? new Date().getHours();
    return themeForHour(hour);
  }

  /** Apply an adaptive theme (sets mode + emits). */
  applyAdaptive(input: AdaptiveThemeInput = {}): ThemeMode {
    const resolved = this.resolveAdaptive(input);
    this.setMode(resolved);
    return resolved;
  }
}
