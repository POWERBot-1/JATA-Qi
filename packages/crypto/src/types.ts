// JATA Qi Crypto Platform — types. A blockchain-agnostic digital asset framework
// supporting KRT tokens, NFTs, smart-contract abstractions, staking, HD wallets,
// key management, hot/cold custody, and exchange abstraction. Pure Node
// (node:crypto), zero external dependencies.

/** Asset type on the platform. */
export type AssetType = 'fungible' | 'non_fungible' | 'semi_fungible';

/** A registered digital asset (token or NFT collection). */
export interface DigitalAsset {
  id: string;
  symbol: string;          // KRT, NFT-COLLECTION-ID, etc.
  name: string;
  type: AssetType;
  decimals: number;
  totalSupply: bigint;     // for fungible; for NFT, the max mint count
  circulatingSupply: bigint;
  /** Blockchain this asset lives on (abstract — 'native', 'ethereum', 'solana', etc.). */
  chain: string;
  /** Contract address (if applicable). */
  contractAddress?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/** A single NFT token instance within a collection. */
export interface NftToken {
  id: string;              // token id within the collection
  collectionId: string;   // parent DigitalAsset id
  owner: string;          // wallet address / ownerId
  tokenURI?: string;      // metadata URI (IPFS, HTTP)
  metadata?: Record<string, unknown>;
  mintedAt: number;
}

/** A blockchain-agnostic transaction record. */
export interface ChainTransaction {
  hash: string;
  from: string;
  to: string;
  assetSymbol: string;
  amount: bigint;
  type: 'transfer' | 'mint' | 'burn' | 'stake' | 'unstake' | 'reward' | 'approve';
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
  gasUsed?: bigint;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** An HD wallet key pair (BIP-39/BIP-44 style abstraction). */
export interface HdKeyPair {
  address: string;        // derived public address
  publicKey: string;      // hex
  privateKey: string;     // hex (encrypted at rest in production)
  derivationPath: string; // e.g. m/44'/0'/0'/0/0
  index: number;
}

/** A custody wallet designation. */
export type CustodyType = 'hot' | 'cold' | 'warm';

export interface CustodyWallet {
  id: string;
  address: string;
  type: CustodyType;
  /** Owner (userId or system). */
  owner: string;
  /** Balance by asset symbol. */
  balances: Map<string, bigint>;
  /** Whether this wallet can initiate transactions. */
  canTransact: boolean;
  createdAt: number;
}

/** A staking position. */
export interface StakePosition {
  id: string;
  staker: string;
  assetSymbol: string;
  amount: bigint;
  apr: number;             // annual percentage rate (0.05 = 5%)
  stakedAt: number;
  unlockAt: number;        // earliest unstake timestamp
  rewardsAccrued: bigint;
  lastRewardCalc: number;
  status: 'active' | 'unstaking' | 'withdrawn';
}

/** An exchange rate quote. */
export interface ExchangeQuote {
  fromAsset: string;
  toAsset: string;
  fromAmount: bigint;
  toAmount: bigint;
  rate: number;
  fee: bigint;
  expiresAt: number;
}

/** A smart contract abstraction (interface definition, not bytecode). */
export interface SmartContractAbstraction {
  id: string;
  name: string;
  chain: string;
  address?: string;
  abi: Array<{
    name: string;
    type: 'function' | 'event' | 'constructor';
    inputs: Array<{ name: string; type: string }>;
    outputs?: Array<{ name: string; type: string }>;
    stateMutability?: 'view' | 'pure' | 'nonpayable' | 'payable';
  }>;
  metadata?: Record<string, unknown>;
  createdAt: number;
}
