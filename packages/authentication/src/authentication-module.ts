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
import { IdentityStore } from './identity-store.js';
import { JtiReplayStore } from './jti-replay.js';
import type { ServerAuthenticator } from './types.js';

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
  /**
   * P1 (S2): factory invoked at init, AFTER the durable session/token
   * stores have opened, so production authenticators can be constructed
   * against the durable registry (e.g. registry-verified static tokens)
   * instead of a process-local constructor table. Used only when no
   * explicit `authenticators` array is supplied — an explicit array keeps
   * its exact meaning (fail-closed: never both).
   */
  readonly authenticatorFactory?: (stores: {
    readonly sessionStore?: AuthenticationEventStore;
    readonly tokenRegistry?: TokenRegistryStore;
    /**
     * P2-S1: the durable identity core + jti replay set (present whenever
     * durable sessions are open). Production authenticators (OIDC,
     * auto-linked static tokens) are constructed against these.
     */
    readonly identityStore?: IdentityStore;
    readonly jtiReplay?: JtiReplayStore;
  }) => readonly ServerAuthenticator[] | Promise<readonly ServerAuthenticator[]>;
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
  #identityStore: IdentityStore | undefined;
  #jtiReplay: JtiReplayStore | undefined;

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
      // P2-S1: the durable identity core (principals, memberships,
      // role-assignments, recovery, subject-bindings, events) and the jti
      // replay set are part of the durable authentication substrate —
      // opened (and failing closed) in the same step as S-8/S-9.
      this.#identityStore = await IdentityStore.open(storage);
      this.#jtiReplay = await JtiReplayStore.open(storage);
    }
    if (!this.#tokenRegistry) this.#tokenRegistry = this.#config.tokenRegistry;
    // P1 (S2): construct authenticators through the factory when supplied, so
    // production verification paths are built against the DURABLE registry
    // (revocation visible cross-process) rather than a process-local table.
    // Fail-closed: the factory is never combined with an explicit array, and
    // a factory that cannot operate durably must throw (boot aborts).
    let authenticators = this.#config.authenticators;
    if (this.#config.authenticatorFactory) {
      if (authenticators !== undefined) {
        throw new Error(
          'Authentication module: authenticatorFactory cannot be combined with an explicit authenticators array (fail-closed).',
        );
      }
      authenticators = await this.#config.authenticatorFactory({
        ...(eventStore ? { sessionStore: eventStore } : {}),
        ...(this.#tokenRegistry ? { tokenRegistry: this.#tokenRegistry } : {}),
        ...(this.#identityStore ? { identityStore: this.#identityStore } : {}),
        ...(this.#jtiReplay ? { jtiReplay: this.#jtiReplay } : {}),
      });
      if (!Array.isArray(authenticators)) {
        throw new Error('Authentication module: authenticatorFactory must return an array of authenticators (fail-closed).');
      }
    }
    // Construction is fail-closed: an unusable policy or an authenticator that
    // could produce an inadmissible method throws here, before boot completes.
    this.#eventStore = eventStore;
    this.#boundary = new PrincipalBoundary({
      ...this.#config,
      ...(authenticators !== undefined ? { authenticators } : {}),
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
    if (this.#identityStore) {
      kernel.container.registerValue('authentication.identity-store', this.#identityStore);
    }
    if (this.#jtiReplay) {
      kernel.container.registerValue('authentication.jti-replay', this.#jtiReplay);
    }
    kernel.logger.info(
      `principal boundary initialized (T-03): ${this.#boundary.getPolicy().describe()}; ` +
        `authenticators=[${this.#boundary.listAuthenticatorIds().join(',') || '<none>'}]` +
        (this.#eventStore ? '; durable sessions enabled (R2 S-8/S-9)' : '') +
        (this.#identityStore ? '; identity core enabled (P2-S1)' : ''),
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

  /** P2-S1 identity core; throws when durable sessions are not enabled. */
  getIdentityStore(): IdentityStore {
    if (!this.#identityStore) throw new Error('Authentication module has no durable identity store (durableSessions not enabled).');
    return this.#identityStore;
  }

  /** P2-S1 jti replay set; throws when durable sessions are not enabled. */
  getJtiReplayStore(): JtiReplayStore {
    if (!this.#jtiReplay) throw new Error('Authentication module has no durable jti replay store (durableSessions not enabled).');
    return this.#jtiReplay;
  }

  /** R2 S-9 registry; throws when durable sessions are not enabled. */
  getTokenRegistry(): TokenRegistryStore {
    if (!this.#tokenRegistry) throw new Error('Authentication module has no durable token registry (durableSessions not enabled).');
    return this.#tokenRegistry;
  }
}
