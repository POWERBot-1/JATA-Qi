// R-01 CLI host command tests: argument parsing, credential redaction,
// durable driver resolution, and DEFAULT-BEHAVIOUR IMMUTABILITY.
//
// The last of these is an explicit R-01 acceptance criterion: composing JATA Qi
// with no configuration must behave exactly as it did at the P-01 baseline —
// memory driver, host module NOT registered, nothing started, no side effects.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJataQi } from '../src/bootstrap.js';
import { hostBanner, parseHostArgs } from '../src/host-command.js';
import {
  isDurableDriverName,
  redactConnectionString,
  resolveStorageDriver,
  StorageDriverResolutionError,
} from '../src/storage-driver.js';

describe('R-01 host command argument parsing', () => {
  it('parses the supported flags', () => {
    const opts = parseHostArgs(['--max-cycles', '3', '--min-idle-ms', '10', '--max-idle-ms', '500']);
    assert.equal(opts.maxCycles, 3);
    assert.equal(opts.minIdleMs, 10);
    assert.equal(opts.maxIdleMs, 500);
  });

  it('parses the development-only non-durable opt-out', () => {
    assert.equal(parseHostArgs(['--allow-non-durable-storage']).allowNonDurableStorage, true);
    assert.equal(parseHostArgs([]).allowNonDurableStorage, undefined);
  });

  it('rejects unknown flags and invalid values (fail closed)', () => {
    assert.throws(() => parseHostArgs(['--merge-the-pr']), /Unknown option/);
    assert.throws(() => parseHostArgs(['--max-cycles', '0']), /positive integer/);
    assert.throws(() => parseHostArgs(['--max-cycles', 'many']), /positive integer/);
  });
});

describe('R-01 credential handling', () => {
  it('redacts the password from a connection string', () => {
    const redacted = redactConnectionString('postgres://alice:sup3rs3cret@db.internal:5432/jataqi');
    assert.ok(!redacted.includes('sup3rs3cret'), 'the password must never reach a log line');
    assert.ok(redacted.includes('alice'));
    assert.ok(redacted.includes('db.internal'));
  });

  it('handles an absent or unparseable connection string safely', () => {
    assert.equal(redactConnectionString(undefined), '(none)');
    assert.match(redactConnectionString('not a url'), /redacted|none/);
  });

  it('the startup banner never contains a raw password', () => {
    const banner = hostBanner({
      hostId: 'host:test',
      driverId: 'postgres',
      connectionString: 'postgres://bob:hunter2@example:5432/db',
      minIdleMs: 250,
      maxIdleMs: 30_000,
    });
    assert.ok(!banner.includes('hunter2'));
    assert.match(banner, /no backup\/restore\/PITR\/replication/);
    assert.match(banner, /34-stage governed loop/);
  });
});

describe('R-01 storage driver resolution', () => {
  it('classifies durable vs development-only driver names', () => {
    assert.equal(isDurableDriverName('postgres'), true);
    assert.equal(isDurableDriverName('memory'), false);
    assert.equal(isDurableDriverName('filesystem'), false);
  });

  it('returns undefined for development drivers so default composition is untouched', async () => {
    assert.equal(await resolveStorageDriver('memory'), undefined);
    assert.equal(await resolveStorageDriver('filesystem'), undefined);
  });

  it('rejects an unknown driver name', async () => {
    await assert.rejects(() => resolveStorageDriver('mongodb'), StorageDriverResolutionError);
  });

  it('fails closed when postgres is selected with no connection configuration', async () => {
    // requireExplicitConfig makes the driver throw rather than silently trying
    // localhost. The throw may surface at construction or on first use.
    let threw = false;
    try {
      const driver = await resolveStorageDriver('postgres', {} as NodeJS.ProcessEnv);
      if (driver) {
        await (driver as unknown as { init(): Promise<void> }).init();
      }
    } catch (error) {
      threw = true;
      assert.match((error as Error).message, /connection|config/i);
    }
    assert.ok(threw, 'postgres without configuration must fail closed, never default silently');
  });

  it('constructs a postgres driver when a connection string is supplied (no connection attempted)', async () => {
    const driver = await resolveStorageDriver('postgres', {
      JATAQI_PG_CONNECTION_STRING: 'postgres://u:p@127.0.0.1:1/db',
    } as NodeJS.ProcessEnv);
    assert.ok(driver);
    assert.equal(driver.id, 'postgres');
  });
});

describe('R-01 default-behaviour immutability (P-01 baseline preserved)', () => {
  it('default composition still uses the in-memory driver', async () => {
    const instance = await createJataQi();
    try {
      const storage = instance.kernel.getModule('storage') as unknown as { getDriver(): { id: string } };
      assert.equal(storage.getDriver().id, 'memory', 'default driver must remain memory');
    } finally {
      await instance.shutdown();
    }
  });

  it('default composition does NOT register the loop host (unchanged from O-01/P-01)', async () => {
    const instance = await createJataQi();
    try {
      assert.throws(
        () => instance.kernel.getModule('loop-host'),
        'the host must not be registered unless explicitly enabled',
      );
    } finally {
      await instance.shutdown();
    }
  });

  it('explicitly enabling the host registers it IDLE and starts nothing', async () => {
    const instance = await createJataQi({ loopHost: { enabled: true } });
    try {
      const hostModule = instance.kernel.getModule('loop-host') as unknown as {
        getService(): { getLifecycle(): string };
      };
      assert.equal(
        hostModule.getService().getLifecycle(),
        'IDLE',
        'registration must never auto-start work',
      );
    } finally {
      await instance.shutdown();
    }
  });
});
