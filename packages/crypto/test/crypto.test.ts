// KRT Digital Asset Platform tests — asset engine (mint/burn/transfer/NFT),
// HD wallet (derive/sign/verify), custody (hot/warm/cold), staking (accrue/
// unstake/withdraw), exchange (quote/swap/AMM), contract registry, and
// full kernel integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  AssetEngine, HdWallet, CustodyEngine, StakingEngine, ExchangeEngine, ContractRegistry,
  CryptoModule, CryptoEvents, verifySignature,
} from '../src/index.js';

describe('AssetEngine — fungible tokens', () => {
  let engine: AssetEngine;
  before(() => {
    engine = new AssetEngine();
    engine.registerAsset({ symbol: 'KRT', name: 'KART Token', type: 'fungible', decimals: 8, totalSupply: 1_000_000_000n, chain: 'native' });
  });

  it('registers an asset', () => {
    assert.ok(engine.getAssetBySymbol('KRT'));
    assert.equal(engine.getAssetBySymbol('KRT')!.type, 'fungible');
  });

  it('mints tokens to an address', () => {
    engine.mint('addr1', 'KRT', 500_000n);
    assert.equal(engine.getBalance('addr1', 'KRT'), 500_000n);
    assert.equal(engine.getAssetBySymbol('KRT')!.circulatingSupply, 500_000n);
  });

  it('rejects mint beyond total supply', () => {
    assert.throws(() => engine.mint('addr2', 'KRT', 1_000_000_000_000n), /total supply/);
  });

  it('transfers tokens between addresses', () => {
    engine.transfer('addr1', 'addr2', 'KRT', 100_000n);
    assert.equal(engine.getBalance('addr1', 'KRT'), 400_000n);
    assert.equal(engine.getBalance('addr2', 'KRT'), 100_000n);
  });

  it('burns tokens', () => {
    engine.burn('addr1', 'KRT', 50_000n);
    assert.equal(engine.getBalance('addr1', 'KRT'), 350_000n);
  });

  it('rejects transfer with insufficient balance', () => {
    assert.throws(() => engine.transfer('addr2', 'addr1', 'KRT', 999_999n), /insufficient/);
  });
});

describe('AssetEngine — NFTs', () => {
  let engine: AssetEngine;
  before(() => {
    engine = new AssetEngine();
    engine.registerAsset({ symbol: 'JQ-NFT', name: 'JATA Qi Collectible', type: 'non_fungible', decimals: 0, totalSupply: 10_000n, chain: 'native' });
  });

  it('mints an NFT to an address', () => {
    const nft = engine.mintNft(engine.listAssets()[0]!.id, 'owner1', 'ipfs://metadata/1', { rarity: 'legendary' });
    assert.equal(nft.owner, 'owner1');
    assert.equal(nft.metadata?.rarity, 'legendary');
  });

  it('transfers an NFT', () => {
    const nft = engine.mintNft(engine.listAssets()[0]!.id, 'owner1');
    engine.transferNft(nft.id, 'owner1', 'owner2');
    assert.equal(engine.getNft(nft.id)!.owner, 'owner2');
  });

  it('rejects transfer from non-owner', () => {
    const nft = engine.mintNft(engine.listAssets()[0]!.id, 'owner1');
    assert.throws(() => engine.transferNft(nft.id, 'hacker', 'owner2'), /does not own/);
  });

  it('lists NFTs by owner and collection', () => {
    assert.ok(engine.nftsByOwner('owner1').length > 0);
    assert.ok(engine.nftsByCollection(engine.listAssets()[0]!.id).length > 0);
  });
});

describe('HdWallet — key derivation + signing', () => {
  it('derives keys at different indices', () => {
    const w = HdWallet.generate();
    const k0 = w.derive(0);
    const k1 = w.derive(1);
    assert.notEqual(k0.address, k1.address);
    assert.ok(k0.address.startsWith('jq1'));
    assert.ok(k0.publicKey.length > 0);
  });

  it('returns the same key for the same index', () => {
    const w = HdWallet.generate();
    const k0a = w.derive(0);
    const k0b = w.derive(0);
    assert.equal(k0a.address, k0b.address);
  });

  it('signs and verifies data', () => {
    const w = HdWallet.generate();
    const kp = w.derive(0);
    const data = 'hello crypto world';
    const sig = w.sign(0, data);
    assert.ok(verifySignature(data, sig, kp.publicKey));
    assert.equal(verifySignature('wrong data', sig, kp.publicKey), false);
  });
});

describe('CustodyEngine — hot/warm/cold wallets', () => {
  let engine: CustodyEngine;
  before(() => {
    engine = new CustodyEngine();
    engine.createWallet('0xhot', 'hot', 'system');
    engine.createWallet('0xcold', 'cold', 'system');
    engine.createWallet('0xwarm', 'warm', 'system');
    engine.credit(engine.listWallets({ type: 'hot' })[0]!.id, 'KRT', 1000n);
    engine.credit(engine.listWallets({ type: 'warm' })[0]!.id, 'KRT', 500n);
    engine.credit(engine.listWallets({ type: 'cold' })[0]!.id, 'KRT', 500n);
  });

  it('hot wallet executes withdrawal immediately', () => {
    const hot = engine.listWallets({ type: 'hot' })[0]!;
    const result = engine.withdraw(hot.id, '0xrecipient', 'KRT', 200n);
    assert.equal(result.executed, true);
    assert.equal(hot.balances.get('KRT'), 800n);
  });

  it('cold wallet rejects withdrawals', () => {
    const cold = engine.listWallets({ type: 'cold' })[0]!;
    const result = engine.withdraw(cold.id, '0xrecipient', 'KRT', 10n);
    assert.equal(result.executed, false);
    assert.match(result.message, /cold/);
  });

  it('warm wallet creates an approval request', () => {
    const warm = engine.listWallets({ type: 'warm' })[0]!;
    const result = engine.withdraw(warm.id, '0xrecipient', 'KRT', 100n);
    assert.equal(result.executed, false);
    assert.ok(result.requestId);
    // Approve.
    const approved = engine.approveWithdrawal(result.requestId!);
    assert.equal(approved.executed, true);
    assert.equal(warm.balances.get('KRT'), 400n);
  });
});

describe('StakingEngine — stake + accrue + unstake', () => {
  it('stakes, accrues rewards, and withdraws', () => {
    const engine = new StakingEngine({ defaultApr: 0.1, defaultLockupDays: 0 });
    const pos = engine.stake('staker1', 'KRT', 100_000n);
    assert.equal(pos.status, 'active');
    // Fast-forward 1 year.
    const oneYearLater = Date.now() + 365 * 86_400_000;
    const reward = engine.accrueRewards(pos.id, oneYearLater);
    assert.ok(reward > 0n); // ~10% APR
    // Unstake (lockupDays=0 → immediately unlockable).
    engine.unstake(pos.id, oneYearLater);
    const withdrawn = engine.withdraw(pos.id);
    assert.equal(withdrawn.principal, 100_000n);
    assert.ok(withdrawn.rewards > 0n);
  });

  it('rejects unstaking before lockup expires', () => {
    const engine = new StakingEngine({ defaultLockupDays: 30 });
    const pos = engine.stake('s', 'KRT', 1000n);
    assert.throws(() => engine.unstake(pos.id), /lockup/);
  });
});

describe('ExchangeEngine — quotes + AMM swaps', () => {
  it('quotes with a manual rate', () => {
    const engine = new ExchangeEngine();
    engine.setRate('KRT', 'USD', 0.50);
    const quote = engine.quote('KRT', 'USD', 1000n);
    assert.equal(quote.toAmount, 500n);
    assert.ok(quote.fee > 0n);
  });

  it('creates an AMM pool and swaps', () => {
    const engine = new ExchangeEngine();
    engine.createPool('KRT', 'USD', 100_000n, 50_000n);
    const quote = engine.quote('KRT', 'USD', 1_000n);
    assert.ok(quote.toAmount > 0n);
    assert.ok(quote.toAmount < 1000n); // AMM + fee reduces output
    const swap = engine.swap(quote, '0xtrader');
    assert.equal(swap.toAmount, quote.toAmount);
    assert.equal(engine.swapCount, 1);
  });

  it('rejects expired quotes', () => {
    const engine = new ExchangeEngine();
    engine.setRate('KRT', 'USD', 1);
    const quote = engine.quote('KRT', 'USD', 100n);
    quote.expiresAt = Date.now() - 1000;
    assert.throws(() => engine.swap(quote, '0x'));
  });
});

describe('ContractRegistry — ABI storage', () => {
  it('registers and queries contracts', () => {
    const registry = new ContractRegistry();
    const c = registry.register({
      name: 'KRTToken', chain: 'native',
      abi: [
        { name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: 'success', type: 'bool' }], stateMutability: 'nonpayable' },
        { name: 'Transfer', type: 'event', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
      ],
    });
    assert.ok(c.id);
    assert.equal(registry.count, 1);
    const sigs = registry.getFunctionSignatures(c.id);
    assert.ok(sigs.includes('transfer(address,uint256)'));
    const events = registry.getEvents(c.id);
    assert.equal(events[0]!.name, 'Transfer');
  });
});

describe('CryptoModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: CryptoModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new CryptoModule();
    kernel.register(mod);
    await kernel.boot();
    mod.registerAsset({ symbol: 'KRT', name: 'KART Token', type: 'fungible', decimals: 8, totalSupply: 1_000_000_000n, chain: 'native' });
    mod.registerAsset({ symbol: 'JQ-NFT', name: 'Collectible', type: 'non_fungible', decimals: 0, totalSupply: 10_000n, chain: 'native' });
  });
  after(async () => { await kernel.shutdown(); });

  it('mints KRT and emits events', async () => {
    let minted = 0;
    kernel.bus.on(CryptoEvents.Mint, () => { minted++; });
    mod.mint('0xuser1', 'KRT', 10_000n);
    assert.equal(mod.getBalance('0xuser1', 'KRT'), 10_000n);
    await new Promise((r) => setImmediate(r));
    assert.ok(minted >= 1);
  });

  it('transfers KRT between addresses', () => {
    mod.transfer('0xuser1', '0xuser2', 'KRT', 3_000n);
    assert.equal(mod.getBalance('0xuser1', 'KRT'), 7_000n);
    assert.equal(mod.getBalance('0xuser2', 'KRT'), 3_000n);
  });

  it('mints and transfers NFTs', () => {
    const collection = mod.assets.listAssets('non_fungible')[0]!;
    const nft = mod.mintNft(collection.id, '0xuser1', 'ipfs://meta/1');
    assert.equal(nft.owner, '0xuser1');
    mod.transferNft(nft.id, '0xuser1', '0xuser2');
    assert.equal(mod.assets.getNft(nft.id)!.owner, '0xuser2');
  });

  it('creates custody wallets and stakes', () => {
    mod.createCustodyWallet('0xcold1', 'cold', 'treasury');
    mod.stake('0xuser1', 'KRT', 5_000n, { apr: 0.08, lockupDays: 7 });
    assert.equal(mod.staking.positionCount, 1);
  });

  it('quotes and swaps', () => {
    mod.exchange.setRate('KRT', 'USD', 0.25);
    const q = mod.quote('KRT', 'USD', 1_000n);
    const result = mod.swap(q, '0xuser1');
    assert.ok(result.toAmount > 0n);
  });

  it('registers a smart contract', () => {
    mod.registerContract({ name: 'StakingPool', chain: 'native', abi: [{ name: 'stake', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }] });
    assert.equal(mod.contracts.count, 1);
  });

  it('provides a summary', () => {
    const s = mod.summary();
    assert.ok(s.assets >= 2);
    assert.ok(s.nfts >= 1);
    assert.ok(s.transactions > 0);
    assert.ok(s.custodyWallets >= 1);
    assert.ok(s.stakePositions >= 1);
    assert.ok(s.swaps >= 1);
  });
});
