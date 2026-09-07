// T-03 authentication module — makes the T-01 principal boundary reachable
// from a real kernel composition instead of only from test code.
//
// Before T-03 `@jataqi/authentication` shipped as a library with no
// `IModule` and no composition-root wiring: `bootstrap.ts` never imported it
// and no production code ever constructed an authenticator, so T-01's
// boundary and T-02's durable carry-through were exercised exclusively by
// tests. This module closes that gap without adding a second authority
// system — it constructs the existing T-01 registry behind the T-03 policy
// and publishes one boundary object.
//
// Boot performs no authentication, opens no socket, reads no credential, and
// starts no background work.

import type { IModule, KernelApi } from '@jataqi/core-kernel';
import type { SecurityCollectionSource } from '@jataqi/storage';
import { PrincipalBoundary, type PrincipalBoundaryConfig } from './principal-boundary.js';
import { AuthenticationEventStore } from './authentication-event-store.js';
import { TokenRegistryStore } from './token-registry.js';

export interface AuthenticationDurableSessionsConfig {
  /**
   * Master switch. When true, `init` resolves the `storage` module from
   * the kernel (throwing when absent — boot fails closed), opens the
   * S-8 session store and the S-9 token registry against it, and wires
   * the boundary to record every success durably. When false/absent,
   * R1 behavior is preserved exactly.
   */
  readonly enabled: boolean;
  /** Session lifetime override (ms); validated by the boundary. */
  readonly sessionLifetimeMs?: number;
}

export interface AuthenticationModuleConfig extends PrincipalBoundaryConfig {
  readonly durableSessions?: AuthenticationDurableSessionsConfig;
  /**
   * R2 S-9: an explicitly supplied registry (tests / custom roots).
   * When `durableSessions.enabled` opens one from storage, the opened
   * registry wins; otherwise this one is published (if present).
   */
  readonly tokenRegistry?: TokenRegistryStore;
}

export class AuthenticationModule implements IModule {
  readonly id = 'authentication';
  readonly tags = ['authentication', 'principal', 'authority', 'boundary'] as const;
  // A leaf boundary: it verifies credentials and depends on no other module.
  // (R2 keeps dependsOn empty on purpose — `topology()` throws on missing
  // deps, and standalone compositions must keep booting. Durable sessions
  // resolve `storage` lazily at init and fail closed when it is absent.)
  readonly dependsOn: readonly string[] = [];

  readonly #config: AuthenticationModuleConfig;
  #boundary: PrincipalBoundary | undefined;
  #eventStore: AuthenticationEventStore | undefined;
  #tokenRegistry: TokenRegistryStore | undefined;

  constructor(config: AuthenticationModuleConfig = {}) {
    this.#config = { ...config };
  }

  async init(kernel: KernelApi): Promise<void> {
    // R2: resolve durable session dependencies BEFORE constructing the
    // boundary, so the boundary is born with its store attached (the
    // boundary is the sole S-8 writer; no post-hoc attachment exists).
    let eventStore = this.#config.eventStore;
    if (this.#config.durableSessions?.enabled === true && !eventStore) {
      let storage: SecurityCollectionSource;
      try {
        storage = kernel.getModule('storage') as unknown as SecurityCollectionSource;
      } catch {
        throw new Error(
          'Authentication module: durableSessions.enabled requires the storage module (fail-closed).',
        );
      }
      eventStore = await AuthenticationEventStore.open(storage);
      this.#tokenRegistry = await TokenRegistryStore.open(storage);
    }
    if (!this.#tokenRegistry) this.#tokenRegistry = this.#config.tokenRegistry;
    // Construction is fail-closed: an unusable policy or an authenticator that
    // could produce an inadmissible method throws here, before boot completes.
    this.#eventStore = eventStore;
    this.#boundary = new PrincipalBoundary({
      ...this.#config,
      ...(eventStore ? { eventStore } : {}),
      ...(this.#config.durableSessions?.sessionLifetimeMs !== undefined
        ? { sessionLifetimeMs: this.#config.durableSessions.sessionLifetimeMs }
        : {}),
    });
    kernel.container.registerValue('authentication.boundary', this.#boundary);
    kernel.container.registerValue('authentication', this.#boundary);
    if (this.#eventStore) {
      kernel.container.registerValue('authentication.session-store', this.#eventStore);
    }
    if (this.#tokenRegistry) {
      kernel.container.registerValue('authentication.token-registry', this.#tokenRegistry);
    }
    kernel.logger.info(
      `principal boundary initialized (T-03): ${this.#boundary.getPolicy().describe()}; ` +
        `authenticators=[${this.#boundary.listAuthenticatorIds().join(',') || '<none>'}]` +
        (this.#eventStore ? '; durable sessions enabled (R2 S-8/S-9)' : ''),
    );
  }

  getService(): PrincipalBoundary {
    if (!this.#boundary) throw new Error('Authentication module is not initialized.');
    return this.#boundary;
  }

  /** R2 S-8 store; throws when durable sessions are not enabled. */
  getSessionStore(): AuthenticationEventStore {
    if (!this.#eventStore) throw new Error('Authentication module has no durable session store (durableSessions not enabled).');
    return this.#eventStore;
  }

  /** R2 S-9 registry; throws when durable sessions are not enabled. */
  getTokenRegistry(): TokenRegistryStore {
    if (!this.#tokenRegistry) throw new Error('Authentication module has no durable token registry (durableSessions not enabled).');
    return this.#tokenRegistry;
  }
}
