// Smart Contract Registry — a blockchain-agnostic registry of contract
// abstractions (ABI definitions, chain bindings, metadata). Does NOT compile
// or execute bytecode; it stores contract interfaces for integration, discovery,
// and auditability.

import { randomUUID } from 'node:crypto';
import type { SmartContractAbstraction } from './types.js';

export class ContractRegistry {
  private contracts = new Map<string, SmartContractAbstraction>();

  /** Register a contract abstraction. */
  register(input: Omit<SmartContractAbstraction, 'id' | 'createdAt'> & { id?: string }): SmartContractAbstraction {
    const contract: SmartContractAbstraction = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: Date.now(),
    };
    this.contracts.set(contract.id, contract);
    return contract;
  }

  get(id: string): SmartContractAbstraction | undefined { return this.contracts.get(id); }

  /** Find a contract by name and optional chain. */
  findByName(name: string, chain?: string): SmartContractAbstraction | undefined {
    return [...this.contracts.values()].find((c) => c.name === name && (!chain || c.chain === chain));
  }

  /** Find a contract by its on-chain address. */
  findByAddress(address: string, chain?: string): SmartContractAbstraction | undefined {
    return [...this.contracts.values()].find((c) => c.address === address && (!chain || c.chain === chain));
  }

  /** List all contracts (optionally filtered by chain). */
  list(chain?: string): SmartContractAbstraction[] {
    const all = [...this.contracts.values()];
    return chain ? all.filter((c) => c.chain === chain) : all;
  }

  /** List all function signatures in a contract. */
  getFunctionSignatures(id: string): string[] {
    const c = this.contracts.get(id);
    if (!c) return [];
    return c.abi.filter((m) => m.type === 'function').map((m) => `${m.name}(${m.inputs.map((i) => i.type).join(',')})`);
  }

  /** List all events in a contract. */
  getEvents(id: string): Array<{ name: string; inputs: Array<{ name: string; type: string }> }> {
    const c = this.contracts.get(id);
    if (!c) return [];
    return c.abi.filter((m) => m.type === 'event').map((m) => ({ name: m.name, inputs: m.inputs }));
  }

  /** Remove a contract. */
  remove(id: string): boolean { return this.contracts.delete(id); }

  get count(): number { return this.contracts.size; }
}
