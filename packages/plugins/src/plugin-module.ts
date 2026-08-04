// PluginManagerModule — registers, validates and tracks plugins. A plugin may
// carry a kernel `module` which the manager auto-registers (and, if the kernel
// is already booted, initializes and starts) on install.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { PluginEvents } from './types.js';
import type { InstalledPlugin, Plugin } from './types.js';

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

export class PluginManagerModule implements IModule {
  readonly id = 'plugins';
  readonly tags = ['core', 'plugins'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private plugins = new Map<string, InstalledPlugin>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('plugins', this);
    kernel.logger.info('plugin manager initialized');
  }

  async start(_kernel: KernelApi): Promise<void> {
    this._booted = true;
  }
  async stop(_kernel: KernelApi): Promise<void> { this.plugins.clear(); }

  /** Install a plugin. Validates id/version/dependencies and auto-registers its module. */
  async install(plugin: Plugin): Promise<InstalledPlugin> {
    const diag = this.validate(plugin);
    if (diag) {
      await this.api.bus.emit(PluginEvents.InstallFailed, { id: plugin.id, reason: diag });
      throw new Error(`plugins: ${diag}`);
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`plugins: plugin "${plugin.id}" is already installed`);
    }

    if (plugin.module) {
      try {
        this.api.register(plugin.module);
        // If the kernel is already booted, initialize+start the module now;
        // otherwise boot() will handle it during the normal lifecycle.
        if (this._booted) {
          if (plugin.module.init) await plugin.module.init(this.api);
          if (plugin.module.start) await plugin.module.start(this.api);
        }
      } catch (err) {
        await this.api.bus.emit(PluginEvents.InstallFailed, { id: plugin.id, reason: (err as Error).message });
        throw err;
      }
    }

    const installed: InstalledPlugin = { ...plugin, enabled: true, installedAt: Date.now() };
    this.plugins.set(plugin.id, installed);
    await this.api.bus.emit(PluginEvents.Installed, { id: plugin.id, version: plugin.version });
    this.api.logger.info(`plugin installed: ${plugin.id}@${plugin.version}`);
    return installed;
  }

  async uninstall(id: string): Promise<boolean> {
    const p = this.plugins.get(id);
    if (!p) return false;
    if (p.module?.stop) {
      try {
        await p.module.stop(this.api);
      } catch (err) {
        this.api.logger.error(`error stopping plugin ${id}`, err as Error);
      }
    }
    this.plugins.delete(id);
    await this.api.bus.emit(PluginEvents.Uninstalled, { id });
    return true;
  }

  enable(id: string): void {
    const p = this.plugins.get(id);
    if (!p) throw new Error(`plugins: plugin "${id}" not found`);
    (this.plugins.get(id) as InstalledPlugin).enabled = true;
    void this.api.bus.emit(PluginEvents.Enabled, { id });
  }

  disable(id: string): void {
    const p = this.plugins.get(id);
    if (!p) throw new Error(`plugins: plugin "${id}" not found`);
    (this.plugins.get(id) as InstalledPlugin).enabled = false;
    void this.api.bus.emit(PluginEvents.Disabled, { id });
  }

  get(id: string): InstalledPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): InstalledPlugin[] {
    return [...this.plugins.values()];
  }

  /** All enabled plugins that declare the given capability. */
  byCapability(capability: string): InstalledPlugin[] {
    return this.list().filter((p) => p.enabled && p.capabilities.includes(capability));
  }

  /** Validate a plugin's manifest. Returns an error message or undefined if OK. */
  validate(plugin: Plugin): string | undefined {
    if (!plugin.id || !/^[a-z0-9-_]+$/i.test(plugin.id)) return `invalid plugin id "${plugin.id}"`;
    if (!SEMVER.test(plugin.version)) return `invalid version "${plugin.version}" (expected semver)`;
    if (!Array.isArray(plugin.capabilities)) return 'capabilities must be an array';
    for (const dep of plugin.dependencies ?? []) {
      const hasPlugin = this.plugins.has(dep);
      const hasModule = this.hasKernelModule(dep);
      if (!hasPlugin && !hasModule) return `missing dependency "${dep}"`;
    }
    return undefined;
  }

  private hasKernelModule(id: string): boolean {
    try {
      this.api.getModuleState(id);
      return true;
    } catch {
      return false;
    }
  }

  /** Set true once the kernel has booted (so post-boot installs are live-started). */
  private _booted = false;
}
