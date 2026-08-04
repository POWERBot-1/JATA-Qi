// Asset Engine — manages fungible tokens (KRT), NFT collections, minting,
// burning, transfers, and balances. The core of the blockchain-agnostic
// digital asset platform.

import { randomUUID } from 'node:crypto';
import type { ChainTransaction, DigitalAsset, NftToken, AssetType } from './types.js';

export class AssetEngine {
  private assets = new Map<string, DigitalAsset>();
  private nfts = new Map<string, NftToken>();
  private transactions: ChainTransaction[] = [];
  /** address -> assetSymbol -> balance */
  private balances = new Map<string, Map<string, bigint>>();

  /** Register a new digital asset (token or NFT collection). */
  registerAsset(input: Omit<DigitalAsset, 'id' | 'circulatingSupply' | 'createdAt'> & { id?: string }): DigitalAsset {
    const asset: DigitalAsset = {
      ...input,
      id: input.id ?? randomUUID(),
      circulatingSupply: 0n,
      createdAt: Date.now(),
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  getAsset(id: string): DigitalAsset | undefined { return this.assets.get(id); }
  getAssetBySymbol(symbol: string): DigitalAsset | undefined {
    return [...this.assets.values()].find((a) => a.symbol === symbol);
  }
  listAssets(type?: AssetType): DigitalAsset[] {
    const all = [...this.assets.values()];
    return type ? all.filter((a) => a.type === type) : all;
  }

  /** Mint fungible tokens to an address. */
  mint(toAddress: string, symbol: string, amount: bigint): ChainTransaction {
    const asset = this.getAssetBySymbol(symbol);
    if (!asset) throw new Error(`asset ${symbol} not registered`);
    if (asset.type !== 'fungible') throw new Error(`${symbol} is not a fungible token`);
    if (asset.totalSupply > 0n && asset.circulatingSupply + amount > asset.totalSupply) {
      throw new Error(`mint would exceed total supply (${asset.totalSupply})`);
    }
    asset.circulatingSupply += amount;
    this.credit(toAddress, symbol, amount);
    return this.recordTx('mint', '0x0', toAddress, symbol, amount);
  }

  /** Burn (destroy) tokens from an address. */
  burn(fromAddress: string, symbol: string, amount: bigint): ChainTransaction {
    const asset = this.getAssetBySymbol(symbol);
    if (!asset) throw new Error(`asset ${symbol} not registered`);
    const balance = this.getBalance(fromAddress, symbol);
    if (balance < amount) throw new Error(`insufficient balance: ${balance} < ${amount}`);
    asset.circulatingSupply -= amount;
    this.debit(fromAddress, symbol, amount);
    return this.recordTx('burn', fromAddress, '0x0', symbol, amount);
  }

  /** Transfer tokens between addresses. */
  transfer(from: string, to: string, symbol: string, amount: bigint): ChainTransaction {
    const balance = this.getBalance(from, symbol);
    if (balance < amount) throw new Error(`insufficient balance: ${balance} < ${amount}`);
    this.debit(from, symbol, amount);
    this.credit(to, symbol, amount);
    return this.recordTx('transfer', from, to, symbol, amount);
  }

  /** Mint an NFT token within a collection. */
  mintNft(collectionId: string, toAddress: string, tokenURI?: string, metadata?: Record<string, unknown>): NftToken {
    const collection = this.assets.get(collectionId);
    if (!collection) throw new Error(`collection ${collectionId} not registered`);
    if (collection.type === 'fungible') throw new Error(`${collectionId} is not an NFT collection`);
    const tokenId = randomUUID();
    const nft: NftToken = {
      id: tokenId, collectionId, owner: toAddress,
      ...(tokenURI ? { tokenURI } : {}),
      ...(metadata ? { metadata } : {}),
      mintedAt: Date.now(),
    };
    this.nfts.set(tokenId, nft);
    collection.circulatingSupply += 1n;
    this.recordTx('mint', '0x0', toAddress, collection.symbol, 1n, { tokenId });
    return nft;
  }

  /** Transfer an NFT to a new owner. */
  transferNft(tokenId: string, from: string, to: string): NftToken {
    const nft = this.nfts.get(tokenId);
    if (!nft) throw new Error(`NFT ${tokenId} not found`);
    if (nft.owner !== from) throw new Error(`${from} does not own NFT ${tokenId}`);
    nft.owner = to;
    const collection = this.assets.get(nft.collectionId);
    this.recordTx('transfer', from, to, collection?.symbol ?? 'NFT', 1n, { tokenId });
    return nft;
  }

  getNft(tokenId: string): NftToken | undefined { return this.nfts.get(tokenId); }
  nftsByOwner(owner: string): NftToken[] { return [...this.nfts.values()].filter((n) => n.owner === owner); }
  nftsByCollection(collectionId: string): NftToken[] { return [...this.nfts.values()].filter((n) => n.collectionId === collectionId); }

  /** Get the balance of an address for a given asset. */
  getBalance(address: string, symbol: string): bigint {
    return this.balances.get(address)?.get(symbol) ?? 0n;
  }

  /** Get all balances for an address. */
  getBalances(address: string): Map<string, bigint> {
    return new Map(this.balances.get(address) ?? []);
  }

  /** Get transaction history (optionally filtered). */
  getHistory(filter?: { address?: string; symbol?: string; type?: string; limit?: number }): ChainTransaction[] {
    let results = this.transactions;
    if (filter?.address) results = results.filter((t) => t.from === filter.address || t.to === filter.address);
    if (filter?.symbol) results = results.filter((t) => t.assetSymbol === filter.symbol);
    if (filter?.type) results = results.filter((t) => t.type === filter.type);
    const limit = filter?.limit ?? 100;
    return results.slice(-limit);
  }

  get assetCount(): number { return this.assets.size; }
  get nftCount(): number { return this.nfts.size; }
  get txCount(): number { return this.transactions.length; }

  // ---- internal ----------------------------------------------------------

  private credit(address: string, symbol: string, amount: bigint): void {
    let bal = this.balances.get(address);
    if (!bal) { bal = new Map(); this.balances.set(address, bal); }
    bal.set(symbol, (bal.get(symbol) ?? 0n) + amount);
  }

  private debit(address: string, symbol: string, amount: bigint): void {
    const bal = this.balances.get(address);
    if (!bal) return;
    bal.set(symbol, (bal.get(symbol) ?? 0n) - amount);
  }

  private recordTx(
    type: ChainTransaction['type'], from: string, to: string,
    symbol: string, amount: bigint, metadata?: Record<string, unknown>,
  ): ChainTransaction {
    const tx: ChainTransaction = {
      hash: `0x${randomUUID().replace(/-/g, '')}`,
      from, to, assetSymbol: symbol, amount, type,
      status: 'confirmed', timestamp: Date.now(),
      ...(metadata ? { metadata } : {}),
    };
    this.transactions.push(tx);
    return tx;
  }
}
