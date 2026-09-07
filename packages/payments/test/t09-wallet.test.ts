import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
// R1 (§6 TEST KERNEL REPAIR): this fixture installs the REAL A-01
// AuthorizationBoundaryModule — the same module the production composition
// installs. It is NOT a mock, a stub, or a bypass. Legitimate kernel-internal
// worker operations establish scoped KERNEL_INTERNAL authority through the
// real boundary; anything out of scope is still denied.
import { AuthorizationBoundaryModule } from '@jataqi/authorization-boundary';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import {
  CommercialControlPlaneModule,
  createStaticFxProvider,
  minorUnitsOf,
  scaleOf,
  type CommercialActor,
  type CommercialControlPlaneService,
} from '@jataqi/commercial-control-plane';
import {
  WALLETS_COLLECTION,
  WalletError,
  PaymentsModule,
  type WalletAccount,
  type WalletService,
} from '../src/index.js';

/**
 * T-09 AC-4 (wallet) and AC-5 (FX) at the service boundary.
 *
 * These tests boot the real payments module on the real storage module and
 * assert observable state: stored balances, stored minor units, append-only
 * movement records, published events, and the exact refusals. Each refusal
 * test also asserts that NOTHING moved, so a regression that debits on a
 * refused withdrawal (or mixes two currencies into one balance) fails here.
 */

let now: number;
let admin: CommercialActor;
let operator: CommercialActor;
let observer: CommercialActor;
let otherTenantOperator: CommercialActor;
let control: CommercialControlPlaneService;
let wallet: WalletService;
let storage: StorageModule;
let busEvents: string[];

const OWNER = 'customer-hash-1';

/** Deterministic injected FX table — no network, no PSP, no environment rate source. */
const fx = createStaticFxProvider({
  'USD/JPY': 155.25,
  'USD/KES': 130.5,
  'KES/JPY': 1.1,
  'JPY/KWD': 0.0021,
  'KWD/USD': 3.25,
}, 'static:t09-test');

beforeEach(async () => {
  now = Date.now();
  admin = { id: 'admin', tenantId: 'acme', roles: ['admin'] };
  operator = { id: 'operator', tenantId: 'acme', roles: ['operator'] };
  observer = { id: 'observer', tenantId: 'acme', roles: ['observer'] };
  otherTenantOperator = { id: 'intruder', tenantId: 'other', roles: ['operator'] };
  busEvents = [];
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new CommercialControlPlaneModule({ now: () => now }));
  kernel.register(new AuthorizationBoundaryModule());
  kernel.register(new AutonomousActionRuntimeModule());
  kernel.register(new PaymentsModule());
  for (const type of ['wallet.credited', 'wallet.debited', 'wallet.conversion.completed', 'wallet.withdrawal.rejected', 'wallet.status.changed']) {
    kernel.bus.on(type, () => { busEvents.push(type); });
  }
  await kernel.boot();
  control = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  storage = kernel.getModule<StorageModule>('storage');
  wallet = kernel.getModule<PaymentsModule>('payments').getWalletService();
});

function payloadOf(record: { envelope?: unknown }): Record<string, unknown> {
  const envelope = record.envelope as { payload?: { payload?: Record<string, unknown> } } | undefined;
  const inner = envelope?.payload;
  return (inner?.payload ?? inner ?? {}) as Record<string, unknown>;
}

async function outboxEventTypes(): Promise<string[]> {
  return (await control.replayUnifiedOutbox(operator, {})).map((record) => record.eventType);
}

describe('T-09 AC-4 — per-currency wallet balances', () => {
  it('keeps one balance per currency and never aggregates across currencies', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-jpy-1', reason: 'T-09 JPY top-up' });
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 50.25, currency: 'KWD' }, idempotencyKey: 'dep-kwd-1', reason: 'T-09 KWD top-up' });
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 500.1, currency: 'KES' }, idempotencyKey: 'dep-kes-1' });

    const balances = await wallet.listBalances(operator, OWNER);
    assert.equal(balances.length, 3, 'one row per currency, never a mixed total');
    assert.deepEqual(balances.map((balance) => balance.currency), ['JPY', 'KES', 'KWD']);

    const jpy = await wallet.getBalance(operator, OWNER, 'JPY');
    assert.equal(jpy?.scale, 0);
    assert.equal(jpy?.minorUnits, '1000', 'JPY minor units are whole yen (no x100)');
    assert.deepEqual(jpy?.balance, { amount: 1000, currency: 'JPY' });

    const kwd = await wallet.getBalance(operator, OWNER, 'KWD');
    assert.equal(kwd?.scale, 3);
    assert.equal(kwd?.minorUnits, '50250', 'KWD minor units are fils (x1000)');
    assert.deepEqual(kwd?.balance, { amount: 50.25, currency: 'KWD' });

    const kes = await wallet.getBalance(operator, OWNER, 'KES');
    assert.equal(kes?.scale, 2);
    assert.equal(kes?.minorUnits, '50010');
    assert.deepEqual(kes?.balance, { amount: 500.1, currency: 'KES' });

    // The stored rows carry the currency in their identity: no single row can
    // hold two currencies, and no code path sums them.
    const rows = await (await storage.collection<WalletAccount>(WALLETS_COLLECTION)).all();
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.currency)).size, 3);
    assert.ok(rows.every((row) => row.tenantId === 'acme' && row.ownerReference === OWNER));
    assert.ok(rows.every((row) => row.scale === scaleOf(row.currency)));
    assert.ok(rows.every((row) => row.minorUnits === minorUnitsOf(row.balance.amount, row.currency).toString()));
  });

  it('quantizes deposits half-up at the currency scale (JPY 0dp, KWD 3dp, KES 2dp)', async () => {
    const tie = await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100.5, currency: 'JPY' }, idempotencyKey: 'dep-jpy-tie' });
    assert.deepEqual(tie.balance.balance, { amount: 101, currency: 'JPY' }, 'tie 100.5 JPY credits 101 yen');
    assert.equal(tie.entry.minorUnits, '101');

    // A sub-unit deposit would credit zero yen: it is refused rather than
    // recorded as a movement that changes nothing (fail-closed, no phantom
    // ledger entry).
    await assert.rejects(
      () => wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 0.4, currency: 'JPY' }, idempotencyKey: 'dep-jpy-sub' }),
      (error: unknown) => error instanceof WalletError && /greater than zero at the JPY minor-unit scale \(0 decimal place\(s\)\)/.test(error.message),
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '101');

    const kwd = await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1.2345, currency: 'KWD' }, idempotencyKey: 'dep-kwd-tie' });
    assert.deepEqual(kwd.balance.balance, { amount: 1.235, currency: 'KWD' }, 'tie at the 4th decimal rounds half-up to fils');
    assert.equal(kwd.balance.minorUnits, '1235');

    const kes = await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 19.99, currency: 'KES' }, idempotencyKey: 'dep-kes' });
    assert.equal(kes.balance.minorUnits, '1999', '2dp behaviour is unchanged');
    assert.deepEqual(kes.balance.balance, { amount: 19.99, currency: 'KES' });
  });

  it('normalizes currency case so "jpy" and "JPY" cannot become two balances', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 500, currency: 'jpy' }, idempotencyKey: 'dep-jpy-lower' });
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 250, currency: ' JPY ' }, idempotencyKey: 'dep-jpy-upper' });
    const balances = await wallet.listBalances(operator, OWNER);
    assert.equal(balances.length, 1);
    assert.equal(balances[0]!.currency, 'JPY');
    assert.equal(balances[0]!.minorUnits, '750');
  });

  it('refuses a non-ISO currency label and a non-positive amount', async () => {
    await assert.rejects(
      () => wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 10, currency: 'CREDITS' }, idempotencyKey: 'dep-bad-currency' }),
      (error: unknown) => error instanceof WalletError && /3-letter ISO-4217/.test(error.message),
    );
    await assert.rejects(
      () => wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 0, currency: 'JPY' }, idempotencyKey: 'dep-zero' }),
      (error: unknown) => error instanceof WalletError && /greater than zero/.test(error.message),
    );
    await assert.rejects(
      () => wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: Number.NaN, currency: 'JPY' }, idempotencyKey: 'dep-nan' }),
      WalletError,
    );
    await assert.rejects(
      () => wallet.deposit(observer, { ownerReference: OWNER, amount: { amount: 10, currency: 'JPY' }, idempotencyKey: 'dep-observer' }),
      (error: unknown) => error instanceof WalletError && /operator role/.test(error.message),
    );
    assert.deepEqual(await wallet.listBalances(operator, OWNER), []);
  });

  it('is idempotent per (wallet, key): a replay never moves the balance twice', async () => {
    const first = await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-idem' });
    const replay = await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-idem' });
    assert.equal(replay.entry.replayed, true);
    assert.equal(replay.entry.id, first.entry.id);
    assert.equal(replay.balance.minorUnits, '1000', 'the replay credited nothing');
    const entries = await wallet.listEntries(operator, { ownerReference: OWNER, currency: 'JPY' });
    assert.equal(entries.length, 1);
    assert.equal(busEvents.filter((type) => type === 'wallet.credited').length, 1, 'exactly one credit event');

    // A different key is a distinct business act.
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 500, currency: 'JPY' }, idempotencyKey: 'dep-idem-2' });
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '1500');
  });
});

describe('T-09 AC-4 — fail-closed withdrawals', () => {
  it('debits exact minor units and allows a withdrawal of exactly the balance', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-w-1' });
    const partial = await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 250, currency: 'JPY' }, idempotencyKey: 'wd-1', reason: 'partial payout' });
    assert.equal(partial.balance.minorUnits, '750');
    assert.equal(partial.entry.minorUnits, '-250', 'a debit is recorded as negative minor units');
    assert.equal(partial.entry.kind, 'DEBIT');
    assert.deepEqual(partial.entry.balanceAfter, { amount: 750, currency: 'JPY' });

    const exact = await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 750, currency: 'JPY' }, idempotencyKey: 'wd-2' });
    assert.equal(exact.balance.minorUnits, '0');
    assert.deepEqual(exact.balance.balance, { amount: 0, currency: 'JPY' });
    assert.equal(exact.balance.exists, true);
  });

  it('refuses an insufficient balance with no partial debit and no balance change', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-ins' });
    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 1001, currency: 'JPY' }, idempotencyKey: 'wd-insufficient' }),
      (error: unknown) => error instanceof WalletError
        && /Insufficient JPY balance/.test(error.message)
        && /available 1000 JPY \(1000 minor units at 0dp\)/.test(error.message)
        && /requested 1001 JPY \(1001 minor units\)/.test(error.message),
    );
    const balance = await wallet.getBalance(operator, OWNER, 'JPY');
    assert.equal(balance?.minorUnits, '1000', 'the refused withdrawal moved nothing');
    const entries = await wallet.listEntries(operator, { ownerReference: OWNER, currency: 'JPY' });
    assert.equal(entries.length, 1, 'no debit entry was appended');
    assert.equal(entries[0]!.kind, 'CREDIT');
    assert.ok(busEvents.includes('wallet.withdrawal.rejected'), 'the refusal is auditable');
    assert.ok(!busEvents.includes('wallet.debited'), 'no debit event was published');
  });

  it('refuses a sub-unit withdrawal that rounds up beyond the balance (JPY 0dp trap)', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'JPY' }, idempotencyKey: 'dep-round' });
    // 100.5 JPY quantizes half-up to 101 yen, which the wallet does not hold.
    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 100.5, currency: 'JPY' }, idempotencyKey: 'wd-round-up' }),
      /Insufficient JPY balance/,
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '100');
    // 100.4 JPY quantizes to 100 yen and is exactly affordable.
    const ok = await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 100.4, currency: 'JPY' }, idempotencyKey: 'wd-round-down' });
    assert.equal(ok.balance.minorUnits, '0');
  });

  it('refuses a withdrawal from a currency the owner does not hold (no cross-currency funding)', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 10_000, currency: 'KES' }, idempotencyKey: 'dep-kes-only' });
    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'JPY' }, idempotencyKey: 'wd-jpy-from-kes' }),
      (error: unknown) => error instanceof WalletError && /Insufficient JPY balance/.test(error.message) && /available 0 JPY/.test(error.message),
    );
    const kes = await wallet.getBalance(operator, OWNER, 'KES');
    assert.equal(kes?.minorUnits, '1000000', 'the KES balance was never touched to fund a JPY withdrawal');
    const jpy = await wallet.getBalance(operator, OWNER, 'JPY');
    assert.equal(jpy?.exists, false, 'no JPY account was created by the refused withdrawal');
    assert.equal(jpy?.minorUnits, '0');
    assert.equal((await wallet.listBalances(operator, OWNER)).length, 1);
  });

  it('refuses an explicit currency mismatch before any read or write', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-mismatch' });
    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'JPY' }, currency: 'KES', idempotencyKey: 'wd-mismatch' }),
      (error: unknown) => error instanceof WalletError && /currency mismatch/.test(error.message) && /no implicit conversion/.test(error.message),
    );
    // The same check applies to deposits: an explicit currency that disagrees
    // with the amount's currency is refused in both directions.
    await assert.rejects(
      () => wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'KES' }, currency: 'JPY', idempotencyKey: 'dep-mismatch' }),
      (error: unknown) => error instanceof WalletError && /currency mismatch/.test(error.message),
    );
    // Case and surrounding whitespace are normalized, so they are NOT a
    // mismatch (and cannot create a second, differently-cased balance).
    const ok = await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'JPY' }, currency: ' jpy ', idempotencyKey: 'dep-case-ok' });
    assert.equal(ok.balance.minorUnits, '1100');
    assert.equal(ok.balance.currency, 'JPY');
    const entries = await wallet.listEntries(operator, { ownerReference: OWNER });
    assert.equal(entries.filter((entry) => entry.kind === 'DEBIT').length, 0, 'the mismatched withdrawal recorded no debit');
    assert.equal(entries.filter((entry) => entry.currency === 'KES').length, 0, 'the mismatched deposit recorded nothing');
    assert.equal((await wallet.getBalance(operator, OWNER, 'KES'))?.exists, false, 'no KES account was created by a refused mismatch');
  });

  it('refuses every movement on a frozen account and recovers when unfrozen', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-freeze' });
    const frozen = await wallet.setStatus(admin, OWNER, 'JPY', 'FROZEN', 'T-09 fraud review');
    assert.equal(frozen.status, 'FROZEN');
    assert.equal(frozen.minorUnits, '1000', 'freezing never changes the balance');
    await assert.rejects(
      () => wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 1, currency: 'JPY' }, idempotencyKey: 'wd-frozen' }),
      (error: unknown) => error instanceof WalletError && /FROZEN/.test(error.message),
    );
    await assert.rejects(
      () => wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1, currency: 'JPY' }, idempotencyKey: 'dep-frozen' }),
      /FROZEN/,
    );
    await assert.rejects(() => wallet.setStatus(operator, OWNER, 'JPY', 'ACTIVE', 'not an admin'), /administrator role/);
    const active = await wallet.setStatus(admin, OWNER, 'JPY', 'ACTIVE', 'review complete');
    assert.equal(active.status, 'ACTIVE');
    const withdrawn = await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'wd-after-unfreeze' });
    assert.equal(withdrawn.balance.minorUnits, '0');
    assert.ok(busEvents.filter((type) => type === 'wallet.status.changed').length >= 2);
  });

  it('refuses a replayed withdrawal key twice and never double-debits', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-widem' });
    const first = await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 400, currency: 'JPY' }, idempotencyKey: 'wd-idem' });
    const replay = await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 400, currency: 'JPY' }, idempotencyKey: 'wd-idem' });
    assert.equal(first.balance.minorUnits, '600');
    assert.equal(replay.entry.replayed, true);
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '600', 'the replay debited nothing');
    assert.equal((await wallet.listEntries(operator, { ownerReference: OWNER, currency: 'JPY' })).filter((entry) => entry.kind === 'DEBIT').length, 1);
  });

  it('is tenant-isolated: another tenant sees a genuine zero and cannot move these funds', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 5000, currency: 'KES' }, idempotencyKey: 'dep-tenant' });

    const intruderBalance = await wallet.getBalance(otherTenantOperator, OWNER, 'KES');
    assert.equal(intruderBalance?.exists, false, 'the other tenant has no account for this owner');
    assert.equal(intruderBalance?.minorUnits, '0');
    assert.notEqual(intruderBalance?.tenantId, 'acme');
    assert.deepEqual(await wallet.listBalances(otherTenantOperator, OWNER), []);

    await assert.rejects(
      () => wallet.withdraw(otherTenantOperator, { ownerReference: OWNER, amount: { amount: 5000, currency: 'KES' }, idempotencyKey: 'wd-intruder' }),
      /Insufficient KES balance/,
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'KES'))?.minorUnits, '500000', 'the acme balance is untouched');

    // Wallet identity is derived from the tenant, so the two tenants can never
    // address the same row.
    assert.notEqual(wallet.walletIdFor('acme', OWNER, 'KES'), wallet.walletIdFor('other', OWNER, 'KES'));
    const rows = await (await storage.collection<WalletAccount>(WALLETS_COLLECTION)).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenantId, 'acme');
  });

  it('never double-spends: concurrent withdrawals admit only what the balance covers', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-concurrent' });
    const results = await Promise.allSettled([0, 1, 2].map((index) => wallet.withdraw(operator, {
      ownerReference: OWNER, amount: { amount: 400, currency: 'JPY' }, idempotencyKey: `wd-concurrent-${index}`,
    })));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 2, 'exactly two 400-yen withdrawals fit in a 1000-yen balance');
    assert.equal(rejected.length, 1);
    assert.ok(rejected.every((result) => result.reason instanceof WalletError && /Insufficient JPY balance/.test(result.reason.message)));
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '200', 'no negative balance, no double spend');
    const debits = (await wallet.listEntries(operator, { ownerReference: OWNER, currency: 'JPY' })).filter((entry) => entry.kind === 'DEBIT');
    assert.equal(debits.length, 2);
  });

  it('never loses a concurrent credit: simultaneous first deposits all land on one account', async () => {
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map((index) => wallet.deposit(operator, {
      ownerReference: OWNER, amount: { amount: 100, currency: 'JPY' }, idempotencyKey: `dep-concurrent-${index}`,
    })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5, results.map((result) => result.status).join(','));
    const balances = await wallet.listBalances(operator, OWNER);
    assert.equal(balances.length, 1, 'the create election converged on ONE account');
    assert.equal(balances[0]!.minorUnits, '500', 'no lost update');
    assert.equal((await wallet.listEntries(operator, { ownerReference: OWNER, currency: 'JPY' })).length, 5);
  });

  it('records append-only movement entries with exact minor units and balance snapshots', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1.2345, currency: 'KWD' }, idempotencyKey: 'dep-ledger' });
    await wallet.withdraw(operator, { ownerReference: OWNER, amount: { amount: 0.2345, currency: 'KWD' }, idempotencyKey: 'wd-ledger' });
    const entries = await wallet.listEntries(operator, { ownerReference: OWNER, currency: 'KWD' });
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.kind), ['CREDIT', 'DEBIT']);
    assert.equal(entries[0]!.minorUnits, '1235');
    assert.equal(entries[0]!.balanceMinorAfter, '1235');
    assert.equal(entries[1]!.minorUnits, '-235', '0.2345 KWD is 235 fils (half-up at 3dp)');
    assert.equal(entries[1]!.balanceMinorAfter, '1000');
    assert.deepEqual(entries[1]!.balanceAfter, { amount: 1, currency: 'KWD' });
    assert.ok(entries.every((entry) => entry.tenantId === 'acme' && entry.scale === 3 && entry.currency === 'KWD'));
    assert.equal((await wallet.getBalance(operator, OWNER, 'KWD'))?.minorUnits, '1000');
  });

  it('publishes wallet events with the movement minor units in the payload', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'JPY' }, idempotencyKey: 'dep-event' });
    const records = await control.replayUnifiedOutbox(operator, {});
    const credited = records.filter((record) => record.eventType === 'wallet.credited');
    assert.equal(credited.length, 1);
    const payload = payloadOf(credited[0]!);
    assert.equal(payload['currency'], 'JPY');
    assert.equal(payload['minorUnits'], '1000');
    assert.equal(payload['scale'], 0);
    assert.equal(payload['balanceMinorAfter'], '1000');
    assert.deepEqual(await outboxEventTypes(), ['wallet.credited']);
  });
});

describe('T-09 AC-5 — wallet FX conversion with an injected provider', () => {
  it('converts USD to JPY in one composed movement, half-up at the target scale', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'USD' }, idempotencyKey: 'dep-usd' });
    const result = await wallet.convert(operator, {
      ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'JPY', fx, idempotencyKey: 'conv-usd-jpy', reason: 'T-09 payout conversion',
    });
    assert.equal(result.rate, 155.25);
    assert.deepEqual(result.converted, { amount: 15525, currency: 'JPY' }, '100 USD x 155.25 = 15525 yen exactly at 0dp');
    assert.equal(result.debit.minorUnits, '-10000');
    assert.equal(result.credit.minorUnits, '15525');
    assert.equal(result.debit.conversionId, result.conversionId);
    assert.equal(result.credit.conversionId, result.conversionId);
    assert.equal(result.debit.kind, 'CONVERSION_DEBIT');
    assert.equal(result.credit.kind, 'CONVERSION_CREDIT');
    assert.deepEqual(result.debit.fx, {
      from: 'USD', to: 'JPY', rate: 155.25, sourceScale: 2, targetScale: 0,
      sourceMinorUnits: '10000', targetMinorUnits: '15525', rounding: 'half-up', providerId: 'static:t09-test',
    });
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '0');
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '15525');
    const balances = await wallet.listBalances(operator, OWNER);
    assert.equal(balances.length, 2, 'each leg stays in its own currency account');
  });

  it('rounds the converted amount half-up at the TARGET scale, including exact ties', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 10, currency: 'USD' }, idempotencyKey: 'dep-usd-tie' });
    const tieFx = createStaticFxProvider({ 'USD/JPY': 155.25 });
    // 10 USD x 155.25 = 1552.5 JPY -> tie at 0dp -> 1553 yen
    const tie = await wallet.convert(operator, { ownerReference: OWNER, source: { amount: 10, currency: 'USD' }, targetCurrency: 'JPY', fx: tieFx, idempotencyKey: 'conv-tie' });
    assert.deepEqual(tie.converted, { amount: 1553, currency: 'JPY' });
    assert.equal(tie.credit.minorUnits, '1553');
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '1553');

    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1.5, currency: 'KWD' }, idempotencyKey: 'dep-kwd-tie' });
    // 1.5 KWD x 3.25 = 4.875 USD -> tie at 2dp -> 4.88
    const usd = await wallet.convert(operator, { ownerReference: OWNER, source: { amount: 1.5, currency: 'KWD' }, targetCurrency: 'USD', fx, idempotencyKey: 'conv-kwd-usd' });
    assert.deepEqual(usd.converted, { amount: 4.88, currency: 'USD' });
    assert.equal(usd.credit.minorUnits, '488');
  });

  it('fails closed when no rate is injected for the pair and moves nothing', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'USD' }, idempotencyKey: 'dep-norate' });
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'KRW', fx, idempotencyKey: 'conv-norate' }),
      (error: unknown) => error instanceof WalletError && /No injected FX rate for USD->KRW/.test(error.message),
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '10000', 'the source balance is intact');
    assert.equal((await wallet.getBalance(operator, OWNER, 'KRW'))?.exists, false, 'no target account was created');
    assert.equal((await wallet.listEntries(operator, { ownerReference: OWNER })).length, 1, 'no conversion legs were recorded');
    assert.ok(!busEvents.includes('wallet.conversion.completed'));
  });

  it('fails closed when the FX source is absent, zero, or negative', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'USD' }, idempotencyKey: 'dep-badfx' });
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'JPY', fx: undefined as never, idempotencyKey: 'conv-nofx' }),
      (error: unknown) => error instanceof WalletError && /injected FX source/.test(error.message),
    );
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'JPY', fx: () => 0, idempotencyKey: 'conv-zero' }),
      /positive finite/,
    );
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'JPY', fx: () => -155, idempotencyKey: 'conv-negative' }),
      /positive finite/,
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '10000');
    assert.equal((await wallet.listBalances(operator, OWNER)).length, 1);
  });

  it('fails closed when the source balance cannot fund the conversion', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 50, currency: 'USD' }, idempotencyKey: 'dep-poor' });
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 50.01, currency: 'USD' }, targetCurrency: 'JPY', fx, idempotencyKey: 'conv-poor' }),
      /Insufficient USD balance/,
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '5000');
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.exists, false, 'the credit leg never ran');
    assert.equal((await wallet.listEntries(operator, { ownerReference: OWNER })).length, 1, 'the debit leg was rolled back with the credit leg');
  });

  it('refuses a conversion whose target amount is zero at the target scale (no silent value destruction)', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1, currency: 'JPY' }, idempotencyKey: 'dep-dust' });
    const dustFx = createStaticFxProvider({ 'JPY/KWD': 0.0001 });
    // 1 JPY x 0.0001 = 0.0001 KWD -> 0 fils at 3dp
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 1, currency: 'JPY' }, targetCurrency: 'KWD', fx: dustFx, idempotencyKey: 'conv-dust' }),
      (error: unknown) => error instanceof WalletError && /zero at 3 decimal place\(s\)/.test(error.message),
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '1');
    assert.equal((await wallet.getBalance(operator, OWNER, 'KWD'))?.exists, false);
  });

  it('refuses a same-currency conversion and a currency mismatch on the source', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'USD' }, idempotencyKey: 'dep-same' });
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'usd', fx, idempotencyKey: 'conv-same' }),
      /different target currency/,
    );
    await assert.rejects(
      () => wallet.convert(operator, { ownerReference: OWNER, source: { amount: 100, currency: 'USD' }, targetCurrency: 'JPY', currency: 'KES', fx, idempotencyKey: 'conv-mismatch' }),
      /currency mismatch/,
    );
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '10000');
  });

  it('is idempotent per conversion key: a replay returns the recorded legs and moves nothing', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 100, currency: 'USD' }, idempotencyKey: 'dep-convidem' });
    const first = await wallet.convert(operator, { ownerReference: OWNER, source: { amount: 40, currency: 'USD' }, targetCurrency: 'JPY', fx, idempotencyKey: 'conv-idem' });
    const replay = await wallet.convert(operator, { ownerReference: OWNER, source: { amount: 40, currency: 'USD' }, targetCurrency: 'JPY', fx, idempotencyKey: 'conv-idem' });
    assert.equal(replay.conversionId, first.conversionId);
    assert.equal(replay.debit.replayed, true);
    assert.equal(replay.credit.replayed, true);
    assert.deepEqual(replay.converted, first.converted);
    assert.equal((await wallet.getBalance(operator, OWNER, 'USD'))?.minorUnits, '6000', '60.00 USD remains after ONE conversion');
    assert.equal((await wallet.getBalance(operator, OWNER, 'JPY'))?.minorUnits, '6210', '40 USD x 155.25 = 6210 yen, credited once');
    const entries = await wallet.listEntries(operator, { ownerReference: OWNER });
    assert.equal(entries.filter((entry) => entry.kind === 'CONVERSION_DEBIT').length, 1);
    assert.equal(entries.filter((entry) => entry.kind === 'CONVERSION_CREDIT').length, 1);
  });

  it('creates the target account on first conversion and keeps both currencies separate', async () => {
    await wallet.deposit(operator, { ownerReference: OWNER, amount: { amount: 1000, currency: 'KES' }, idempotencyKey: 'dep-kes-conv' });
    const result = await wallet.convert(operator, { ownerReference: OWNER, source: { amount: 1000, currency: 'KES' }, targetCurrency: 'JPY', fx, idempotencyKey: 'conv-kes-jpy' });
    assert.deepEqual(result.converted, { amount: 1100, currency: 'JPY' }, '1000 KES x 1.1 = 1100 yen at 0dp');
    assert.equal(result.targetWallet.scale, 0);
    assert.equal(result.sourceWallet.scale, 2);
    const balances = await wallet.listBalances(operator, OWNER);
    assert.deepEqual(balances.map((balance) => `${balance.currency}:${balance.minorUnits}`), ['JPY:1100', 'KES:0']);
    const records = await control.replayUnifiedOutbox(operator, {});
    assert.equal(records.filter((record) => record.eventType === 'wallet.conversion.completed').length, 2, 'one event per leg, paired by conversionId');
    const payloads = records.filter((record) => record.eventType === 'wallet.conversion.completed').map(payloadOf);
    assert.equal(new Set(payloads.map((payload) => payload['conversionId'])).size, 1);
    assert.deepEqual(payloads.map((payload) => payload['currency']).sort(), ['JPY', 'KES']);
  });
});
