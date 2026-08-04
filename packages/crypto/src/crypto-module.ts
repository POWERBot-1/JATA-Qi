// CryptoModule — kernel module integrating the entire KRT Digital Asset
// Platform: asset engine, HD wallet, custody, staking, exchange, and contract
// registry. Emits bus events and provides the unified API surface.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { AssetEngine } from './asset-engine.js';
import { HdWallet } from './hd-wallet.js';
import { CustodyEngine } from './custody.js';
import { StakingEngine } from './staking.js';
import { ExchangeEngine } from './exchange.js';
import { ContractRegistry } from './contract-registry.js';
import type { ChainTransaction, DigitalAsset, NftToken, ExchangeQuote, CustodyWallet, StakePosition, SmartContractAbstraction } from './types.js';

export const CryptoEvents = Object.freeze({
  AssetRegistered: 'crypto.asset.registered',
  Mint: 'crypto.mint',
  Burn: 'crypto.burn',
  Transfer: 'crypto.transfer',
  NftMinted: 'crypto.nft.minted',
  Staked: 'crypto.staked',
  Swap: 'crypto.swap',
} as const);

export class CryptoModule implements IModule {
  readonly id = 'crypto';
  readonly tags = ['core', 'financial'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly assets = new AssetEngine();
  readonly wallet = HdWallet.generate();
  readonly custody = new CustodyEngine();
  readonly staking = new StakingEngine();
  readonly exchange = new ExchangeEngine();
  readonly contracts = new ContractRegistry();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('crypto', this);
    kernel.logger.info('crypto module initialized (KRT Digital Asset Platform)');
  }
  async start(_kernel: KernelApi): Promise<void> {}
  async stop(_kernel: KernelApi): Promise<void> {}

  // ---- asset management --------------------------------------------------

  registerAsset(input: Parameters<AssetEngine['registerAsset']>[0]): DigitalAsset {
    const asset = this.assets.registerAsset(input);
    void this.api.bus.emit(CryptoEvents.AssetRegistered, { id: asset.id, symbol: asset.symbol, type: asset.type });
    return asset;
  }

  mint(to: string, symbol: string, amount: bigint): ChainTransaction {
    const tx = this.assets.mint(to, symbol, amount);
    void this.api.bus.emit(CryptoEvents.Mint, { to, symbol, amount: amount.toString() });
    return tx;
  }

  burn(from: string, symbol: string, amount: bigint): ChainTransaction {
    const tx = this.assets.burn(from, symbol, amount);
    void this.api.bus.emit(CryptoEvents.Burn, { from, symbol, amount: amount.toString() });
    return tx;
  }

  transfer(from: string, to: string, symbol: string, amount: bigint): ChainTransaction {
    const tx = this.assets.transfer(from, to, symbol, amount);
    void this.api.bus.emit(CryptoEvents.Transfer, { from, to, symbol, amount: amount.toString() });
    return tx;
  }

  mintNft(collectionId: string, to: string, tokenURI?: string, metadata?: Record<string, unknown>): NftToken {
    const nft = this.assets.mintNft(collectionId, to, tokenURI, metadata);
    void this.api.bus.emit(CryptoEvents.NftMinted, { tokenId: nft.id, collectionId, to });
    return nft;
  }

  transferNft(tokenId: string, from: string, to: string): NftToken {
    return this.assets.transferNft(tokenId, from, to);
  }

  getBalance(address: string, symbol: string): bigint { return this.assets.getBalance(address, symbol); }

  /** All registered assets (tokens + NFT collections). */
  listAssets(): DigitalAsset[] { return this.assets.listAssets(); }

  /** Look up an asset by id or symbol. */
  getAsset(idOrSymbol: string): DigitalAsset | undefined {
    return this.assets.getAsset(idOrSymbol) ?? this.assets.getAssetBySymbol(idOrSymbol);
  }

  // ---- staking ------------------------------------------------------------

  stake(staker: string, assetSymbol: string, amount: bigint, opts?: { apr?: number; lockupDays?: number }): StakePosition {
    const pos = this.staking.stake(staker, assetSymbol, amount, opts);
    void this.api.bus.emit(CryptoEvents.Staked, { positionId: pos.id, staker, amount: amount.toString() });
    return pos;
  }

  // ---- exchange -----------------------------------------------------------

  quote(from: string, to: string, amount: bigint): ExchangeQuote { return this.exchange.quote(from, to, amount); }
  swap(quote: ExchangeQuote, fromAddress: string): { id: string; toAmount: bigint } {
    const result = this.exchange.swap(quote, fromAddress);
    void this.api.bus.emit(CryptoEvents.Swap, { id: result.id, from: quote.fromAsset, to: quote.toAsset });
    return result;
  }

  // ---- custody ------------------------------------------------------------

  createCustodyWallet(address: string, type: 'hot' | 'cold' | 'warm', owner: string): CustodyWallet {
    return this.custody.createWallet(address, type, owner);
  }

  // ---- contracts ----------------------------------------------------------

  registerContract(input: Parameters<ContractRegistry['register']>[0]): SmartContractAbstraction {
    return this.contracts.register(input);
  }

  // ---- summary ------------------------------------------------------------

  summary(): { assets: number; nfts: number; transactions: number; custodyWallets: number; stakePositions: number; swaps: number; contracts: number } {
    return {
      assets: this.assets.assetCount,
      nfts: this.assets.nftCount,
      transactions: this.assets.txCount,
      custodyWallets: this.custody.walletCount,
      stakePositions: this.staking.positionCount,
      swaps: this.exchange.swapCount,
      contracts: this.contracts.count,
    };
  }
}
