import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Kernel, KernelEvents, Logger } from '../src/index.js';
import { IModule, KernelApi } from '../src/types.js';
import { createTestKernel, createTestLogger, InMemorySink } from '../src/testing.js';

function makeModule(
  id: string,
  opts: { dependsOn?: string[]; tags?: string[]; init?: boolean; start?: boolean; stop?: boolean } = {},
): IModule & { calls: string[] } {
  const m: IModule & { calls: string[] } = {
    id,
    dependsOn: opts.dependsOn,
    tags: opts.tags,
    calls: [],
  };
  if (opts.init !== false) m.init = async () => { m.calls.push('init'); };
  if (opts.start !== false) m.start = async () => { m.calls.push('start'); };
  if (opts.stop !== false) m.stop = async () => { m.calls.push('stop'); };
  return m;
}

describe('Core Kernel', () => {
  let kernel: Kernel;

  beforeEach(() => {
    kernel = createTestKernel();
  });

  it('starts with core services registered in the container', async () => {
    const bus = await kernel.container.resolve('kernel.bus');
    assert.ok(bus);
    const logger = await kernel.container.resolve('kernel.logger');
    assert.ok(logger);
    const config = await kernel.container.resolve('kernel.config');
    assert.ok(config);
    const k = await kernel.container.resolve('kernel');
    assert.equal(k, kernel);
  });

  it('registers modules and emits registration events', async () => {
    const events: any[] = [];
    kernel.bus.on(KernelEvents.ModuleRegistered, (p) => { events.push(p); });
    kernel.register(makeModule('a'));
    assert.equal(kernel.getModuleState('a'), 'registered');
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'a');
  });

  it('prevents duplicate module ids', () => {
    kernel.register(makeModule('a'));
    assert.throws(() => kernel.register(makeModule('a')), /already registered/);
  });

  it('boots modules in dependency order and shuts down in reverse', async () => {
    const order: string[] = [];
    const a: IModule = {
      id: 'a',
      init: async () => { order.push('a:init'); },
      start: async () => { order.push('a:start'); },
      stop: async () => { order.push('a:stop'); },
    };
    const b: IModule = {
      id: 'b',
      dependsOn: ['a'],
      init: async () => { order.push('b:init'); },
      start: async () => { order.push('b:start'); },
      stop: async () => { order.push('b:stop'); },
    };
    const c: IModule = {
      id: 'c',
      dependsOn: ['b'],
      init: async () => { order.push('c:init'); },
      start: async () => { order.push('c:start'); },
      stop: async () => { order.push('c:stop'); },
    };
    // Register out of order to ensure topological sort works
    kernel.register(c);
    kernel.register(a);
    kernel.register(b);

    await kernel.boot();
    assert.deepEqual(order.slice(0, 3), ['a:init', 'b:init', 'c:init']);
    assert.deepEqual(order.slice(3), ['a:start', 'b:start', 'c:start']);
    assert.equal(kernel.isBooted(), true);
    assert.equal(kernel.getModuleState('c'), 'started');

    order.length = 0;
    await kernel.shutdown();
    assert.deepEqual(order, ['c:stop', 'b:stop', 'a:stop']);
    assert.equal(kernel.isBooted(), false);
  });

  it('detects circular dependencies', async () => {
    const a: IModule = { id: 'a', dependsOn: ['b'], start: async () => {} };
    const b: IModule = { id: 'b', dependsOn: ['a'], start: async () => {} };
    kernel.register(a);
    kernel.register(b);
    await assert.rejects(() => kernel.boot(), /circular dependency/);
  });

  it('detects missing dependencies', async () => {
    const a: IModule = { id: 'a', dependsOn: ['nonexistent'], start: async () => {} };
    kernel.register(a);
    await assert.rejects(() => kernel.boot(), /not found/);
  });

  it('emits booted/shutdown lifecycle events', async () => {
    const events: string[] = [];
    kernel.bus.on(KernelEvents.KernelBooting, () => { events.push('booting'); });
    kernel.bus.on(KernelEvents.KernelBooted, () => { events.push('booted'); });
    kernel.bus.on(KernelEvents.KernelShuttingDown, () => { events.push('shutting_down'); });
    kernel.bus.on(KernelEvents.KernelShutdown, () => { events.push('shutdown'); });

    kernel.register(makeModule('a'));
    await kernel.boot();
    await kernel.shutdown();
    assert.ok(events.includes('booting'));
    assert.ok(events.includes('booted'));
    assert.ok(events.includes('shutting_down'));
    assert.ok(events.includes('shutdown'));
    const bootIdx = events.indexOf('booted');
    const shutdownIdx = events.indexOf('shutdown');
    assert.ok(bootIdx < shutdownIdx);
  });

  it('returns modules by tag', () => {
    const a = makeModule('a', { tags: ['storage'] });
    const b = makeModule('b', { tags: ['storage', 'primary'] });
    const c = makeModule('c', { tags: ['search'] });
    kernel.register(a); kernel.register(b); kernel.register(c);
    const storage = kernel.getModulesByTag('storage');
    assert.equal(storage.length, 2);
    assert.equal(kernel.getModulesByTag('search').length, 1);
    assert.equal(kernel.getModulesByTag('missing').length, 0);
  });

  it('is idempotent for boot() and shutdown()', async () => {
    let starts = 0;
    const a: IModule = { id: 'a', start: async () => { starts++; } };
    kernel.register(a);
    await kernel.boot();
    await kernel.boot();
    assert.equal(starts, 1);
    let stops = 0;
    (kernel.getModule('a') as any).stop = async () => { stops++; };
    await kernel.shutdown();
    await kernel.shutdown();
    assert.equal(stops, 1);
  });

  it('shuts down already-started modules when a later module fails to start', async () => {
    const stopped: string[] = [];
    const a: IModule = { id: 'a', start: async () => {}, stop: async () => { stopped.push('a'); } };
    const b: IModule = { id: 'b', dependsOn: ['a'], start: async () => { throw new Error('boom'); }, stop: async () => {} };
    kernel.register(a);
    kernel.register(b);
    await assert.rejects(() => kernel.boot(), /boom/);
    assert.deepEqual(stopped, ['a']);
    assert.equal(kernel.isBooted(), false);
    assert.equal(kernel.getModuleState('b'), 'error');
  });
});

describe('EventBus', () => {
  it('delivers events to subscribed handlers and unsubscribes cleanly', async () => {
    const k = createTestKernel();
    const received: number[] = [];
    const off = k.bus.on<number>('tick', (n) => { received.push(n); });
    await k.bus.emit('tick', 1);
    await k.bus.emit('tick', 2);
    off();
    await k.bus.emit('tick', 3);
    assert.deepEqual(received, [1, 2]);
  });

  it('supports once() listeners', async () => {
    const k = createTestKernel();
    let n = 0;
    k.bus.once('ping', () => { n++; });
    await k.bus.emit('ping', undefined);
    await k.bus.emit('ping', undefined);
    assert.equal(n, 1);
  });

  it('wildcards receive every event', async () => {
    const k = createTestKernel();
    const events: string[] = [];
    k.bus.onAny((payload: any) => { events.push(payload.__name); });
    await k.bus.emit('x', { __name: 'x' });
    await k.bus.emit('y', { __name: 'y' });
    assert.deepEqual(events, ['x', 'y']);
  });

  it('does not fail sibling handlers when one throws', async () => {
    const k = createTestKernel();
    let second = false;
    k.bus.on('e', () => { throw new Error('nope'); });
    k.bus.on('e', () => { second = true; });
    await k.bus.emit('e', undefined);
    assert.equal(second, true);
  });
});

describe('Container', () => {
  it('resolves values and lazy singleton factories', async () => {
    const k = createTestKernel();
    k.container.registerValue('greeting', 'hello');
    let invocations = 0;
    k.container.registerFactory('counter', () => {
      invocations++;
      return { n: invocations };
    });
    assert.equal(await k.container.resolve<string>('greeting'), 'hello');
    const a = await k.container.resolve<{n:number}>('counter');
    const b = await k.container.resolve<{n:number}>('counter');
    assert.equal(a, b);
    assert.equal(invocations, 1);
  });

  it('throws for missing tokens', async () => {
    const k = createTestKernel();
    await assert.rejects(() => k.container.resolve('nope'), /no binding/);
  });

  it('resolveSync throws for async factories that are not yet resolved', () => {
    const k = createTestKernel();
    k.container.registerFactory('async', async () => 42);
    assert.throws(() => k.container.resolveSync('async'), /async factory/);
  });
});

describe('Logger', () => {
  it('redacts sensitive fields and respects scope', () => {
    const sink = new InMemorySink();
    const logger = new Logger({ level: 'trace', sink: sink.push.bind(sink) });
    const child = logger.child('db', { component: 'pg' });
    child.info('connected', { password: 'secret123', host: 'localhost' });
    assert.equal(sink.entries.length, 1);
    const e = sink.entries[0]!;
    assert.equal(e.scope, 'db');
    assert.equal(e.data?.password, '[REDACTED]');
    assert.equal(e.data?.host, 'localhost');
    assert.equal(e.data?.component, 'pg');
  });

  it('filters below configured level', () => {
    const sink = new InMemorySink();
    const logger = new Logger({ level: 'warn', sink: sink.push.bind(sink) });
    logger.info('hi');
    logger.warn('warn-hi');
    logger.error('err-hi');
    assert.deepEqual(sink.messages(), ['warn-hi', 'err-hi']);
  });
});

describe('Config', () => {
  it('layers defaults + env and coerces types', () => {
    const { logger } = createTestLogger();
    const k = new Kernel({
      logger,
      configDefaults: { http: { port: 3000 }, name: 'jataqi' },
      env: { HTTP_PORT: '4000', FEATURE_X: 'true', COUNT: '7' } as any,
    });
    assert.equal(k.config.getNumber('http.port'), 4000); // env wins
    assert.equal(k.config.getString('name'), 'jataqi');
    assert.equal(k.config.getBoolean('feature.x'), true);
    assert.equal(k.config.getNumber('count'), 7);
    assert.equal(k.config.get('missing', 'fallback'), 'fallback');
    assert.throws(() => k.config.getRequired('really.missing'), /missing required/);
  });
});
