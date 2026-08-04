// JATA Qi Plugins — types.
//
// The Plugin Manager / Plugin Framework (spec Step 3 #16, Step 15 "Plugin
// Framework") lets the platform be extended safely. Plugins declare their
// capabilities, required permissions, and dependencies; the manager validates
// them, tracks enable/disable state, and can auto-register a kernel module.

import type { IModule } from '@jataqi/core-kernel';

/** A versioned, capability-declaring extension to the platform. */
export interface Plugin {
  readonly id: string;
  /** Semantic version, e.g. "1.0.0". */
  readonly version: string;
  readonly name?: string;
  readonly description?: string;
  /** What this plugin provides, e.g. ["llm", "connector:stripe"]. */
  readonly capabilities: string[];
  /** Permissions the plugin requires to function. */
  readonly permissions?: string[];
  /** Ids of other plugins (or kernel modules) that must be present. */
  readonly dependencies?: string[];
  /** Optional kernel module to auto-register when installed. */
  readonly module?: IModule;
  readonly metadata?: Record<string, unknown>;
}

export interface InstalledPlugin extends Plugin {
  enabled: boolean;
  installedAt: number;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly capabilities: string[];
  readonly permissions?: string[];
  readonly dependencies?: string[];
}

export const PluginEvents = Object.freeze({
  Installed: 'plugins.installed',
  InstallFailed: 'plugins.install.failed',
  Enabled: 'plugins.enabled',
  Disabled: 'plugins.disabled',
  Uninstalled: 'plugins.uninstalled',
} as const);
