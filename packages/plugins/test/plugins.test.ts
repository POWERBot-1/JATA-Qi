import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { PluginManagerModule } from '../src/index.js';
import type { Plugin } from '../src/index.js';
import type { IModule, Kernel } from '@jataqi/core-kernel';

// A trivial plugin-provided module we can observe.
class FakeConnector implements IModule {
  readonly id = 'connector.fake';
  readonly dependsOn = ['storage'] as const;
  started = false;
  async init() { /* noop */ }
  async start() { this.started = true; }
  async stop() { this.started = false; }
}

describe('PluginManagerModule (kernel integration)', () => {
  let kernel: Kernel;
  let pm: PluginManagerModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new PluginManagerModule());
    await kernel.boot();
    pm = kernel.getModule<PluginManagerModule>('plugins');
  });

  it('installs a plugin and tracks it', async () => {
    const p: Plugin = { id: 'foo', version: '1.0.0', capabilities: ['llm'] };
    await pm.install(p);
    assert.ok(pm.get('foo'));
    assert.equal(pm.list().length, 1);
  });

  it('rejects invalid ids and versions', async () => {
    await assert.rejects(() => pm.install({ id: 'bad id!', version: '1.0.0', capabilities: [] }), /invalid plugin id/);
    await assert.rejects(() => pm.install({ id: 'ok', version: 'latest', capabilities: [] }), /invalid version/);
  });

  it('validates dependencies against plugins and kernel modules', async () => {
    // storage is a kernel module -> dependency satisfied.
    await pm.install({ id: 'dep-ok', version: '1.0.0', capabilities: ['connector'], dependencies: ['storage'] });
    // missing dependency.
    await assert.rejects(
      () => pm.install({ id: 'dep-bad', version: '1.0.0', capabilities: [], dependencies: ['nonexistent'] }),
      /missing dependency/,
    );
    // satisfied by another plugin.
    await pm.install({ id: 'dep-chain', version: '1.0.0', capabilities: [], dependencies: ['dep-ok'] });
  });

  it('enables/disables plugins and filters by capability', async () => {
    await pm.install({ id: 'a', version: '1.0.0', capabilities: ['tool'] });
    await pm.install({ id: 'b', version: '1.0.0', capabilities: ['tool'] });
    pm.disable('b');
    assert.equal(pm.byCapability('tool').length, 1);
    assert.equal(pm.byCapability('tool')[0]!.id, 'a');
  });

  it('auto-registers and live-starts a plugin module installed after boot', async () => {
    const connector = new FakeConnector();
    await pm.install({ id: 'fake-conn', version: '0.2.0', capabilities: ['connector:fake'], module: connector });
    assert.equal(connector.started, true);
    assert.doesNotThrow(() => kernel.getModule('connector.fake'));
    const ok = await pm.uninstall('fake-conn');
    assert.equal(ok, true);
    assert.equal(connector.started, false); // stop() ran
  });

  it('prevents duplicate installs', async () => {
    await pm.install({ id: 'dup', version: '1.0.0', capabilities: [] });
    await assert.rejects(() => pm.install({ id: 'dup', version: '1.0.0', capabilities: [] }), /already installed/);
  });
});
