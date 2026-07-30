// JATA Qi Finance — types. Immutable financial ledgers with wallets,
// transactions, and reconciliation (#19/#96). Monetary values are {amount,
// currency} — never silently converted across currencies.

export interface Wallet {
  id: string;
  ownerId: string;
  organizationId?: string;
  currency: string;
  balance: number;
  status: 'active' | 'frozen' | 'closed';
  createdAt: number;
}

export type TxType = 'credit' | 'debit' | 'transfer_in' | 'transfer_out' | 'reversal';
export type TxStatus = 'pending' | 'settled' | 'reversed';

export interface Transaction {
  id: string;
  walletId: string;
  type: TxType;
  amount: number;
  currency: string;
  description?: string;
  reference?: string;
  relatedTxId?: string; // for transfers and reversals
  status: TxStatus;
  governanceDecision?: string;
  createdAt: number;
  settledAt?: number;
}

/** Immutable, append-only ledger entry — the source of truth for balances. */
export interface LedgerEntry {
  id: string;
  seq: number; // monotonic per wallet
  transactionId: string;
  walletId: string;
  delta: number; // +credit / -debit
  balanceAfter: number;
  currency: string;
  ts: number;
}

export const FinanceEvents = Object.freeze({
  WalletCreated: 'finance.wallet.created',
  TransactionSettled: 'finance.transaction.settled',
  TransactionReversed: 'finance.transaction.reversed',
  InsufficientFunds: 'finance.insufficient_funds',
} as const);
