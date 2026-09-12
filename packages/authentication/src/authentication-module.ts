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
import { SessionTokenService } from './session-tokens.js';
import { PrivilegeStore } from './privilege-store.js';
import { DelegationStore } from './delegation-store.js';
import { SecretMaterialStore } from './secret-material.js';
import { MfaFactorStore } from './mfa.js';
import { BreakGlassStore } from './break-glass.js';
import type { KeyManagementSeam } from './key-management.js';
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

/**
 * P2-S7 — the credential-material seam configuration.
 *
 * Both fields are required when the object is present: there is deliberately
 * NO default key seam and NO default key identifier. A composition that wants
 * credential material must name the seam and the sealing key explicitly, so a
 * development double can never be reached by omission and production can never
 * inherit a dev seam through a defaulted value.
 */
export interface AuthenticationCredentialMaterialConfig {
  /** The key-management seam. In production this MUST be `kind: 'external'`. */
  readonly keySeam: KeyManagementSeam;
  /** Identifier of the ACTIVE encryption key used to seal secrets. */
  readonly encryptionKeyId: string;
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
  /**
   * P2-S7: credential-material seam. Absent ⇒ `getSecretMaterial()` and
   * `getKeySeam()` throw; nothing falls back to a development implementation.
   */
  readonly credentialMaterial?: AuthenticationCredentialMaterialConfig;
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
    /**
     * P2-S2: the session-token lifecycle service (present whenever durable
     * sessions are open). Compositions register session-token verification
     * by constructing a `SessionTokenAuthenticator` against it.
     */
    readonly sessionTokens?: SessionTokenService;
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
  #sessionTokens: SessionTokenService | undefined;
  #privilegeStore: PrivilegeStore | undefined;
  #delegationStore: DelegationStore | undefined;
  #keySeam: KeyManagementSeam | undefined;
  #secretMaterial: SecretMaterialStore | undefined;
  #mfa: MfaFactorStore | undefined;
  #breakGlass: BreakGlassStore | undefined;

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
      // P2-S7: the credential-material seam over the SAME authoritative
      // substrate. Only opened when a seam was EXPLICITLY configured — the
      // module never constructs a development seam, so a composition that
      // forgets it fails closed at first use rather than silently storing
      // secrets against an in-memory double.
      //
      // Opened BEFORE the privilege plane on purpose: the plane needs the S5
      // assurance provider at construction time, and a store cannot be handed
      // to a constructor that has already run.
      if (this.#config.credentialMaterial) {
        this.#keySeam = this.#config.credentialMaterial.keySeam;
        this.#secretMaterial = await SecretMaterialStore.open(
          storage,
          this.#config.credentialMaterial.keySeam,
          this.#config.credentialMaterial.encryptionKeyId,
        );
        // P2-S5: the MFA factor store over the same substrate and the same
        // sealing key. Its secrets use S7's reserved 'totp' purpose.
        this.#mfa = await MfaFactorStore.open(storage, this.#secretMaterial);
      }
      // P2-S3: the durable privileged access plane (elevations) over the same
      // authoritative substrate. Fails closed at open exactly like the other
      // durable stores (a non-transactional source refuses the plane).
      //
      // P2-S5 SECURE BY DEFAULT. This is the ONLY production composition of the
      // privilege plane, and it previously passed no options — so the §8
      // step-up enforcement existed in the library but was never wired, the
      // same vacuity shape as P2-INV-08. The plane is now constructed
      // `strictStepUp: true` ALWAYS: when an assurance provider exists its
      // evidence is verified, and when none exists a step-up-requiring grant is
      // REFUSED rather than accepted on assertion. A plane that cannot verify
      // step-up evidence must not accept it.
      this.#privilegeStore = await PrivilegeStore.open(storage, {
        ...(this.#mfa ? { stepUpVerifier: this.#mfa } : {}),
        strictStepUp: true,
      });
      // P2-S4: the durable delegation + policy store over the same
      // authoritative substrate. Fails closed at open exactly like the other
      // durable stores (a non-transactional source refuses delegation state).
      this.#delegationStore = await DelegationStore.open(storage);
      // P2-S6: break-glass over the same substrate. Only opened when S5+S7 are
      // present — activation must consume verified step-up and the S7 seal.
      if (this.#secretMaterial && this.#mfa && this.#privilegeStore) {
        this.#breakGlass = await BreakGlassStore.open(storage, this.#secretMaterial, this.#mfa, this.#privilegeStore);
      }
      // P2-S2: the session-token lifecycle service over the same durable
      // substrate (mint/verify/rotate/revoke + identity-state gate). The
      // session lifetime is wired from the SAME configuration as the
      // boundary's so both recording paths agree on expiry.
      this.#sessionTokens = new SessionTokenService({
        eventStore,
        identityStore: this.#identityStore,
        ...(this.#config.durableSessions?.sessionLifetimeMs !== undefined
          ? { sessionLifetimeMs: this.#config.durableSessions.sessionLifetimeMs }
          : {}),
      });
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
        ...(this.#sessionTokens ? { sessionTokens: this.#sessionTokens } : {}),
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
      ...(this.#sessionTokens ? { sessionTokenService: this.#sessionTokens } : {}),
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
    if (this.#sessionTokens) {
      kernel.container.registerValue('authentication.session-tokens', this.#sessionTokens);
    }
    if (this.#privilegeStore) {
      kernel.container.registerValue('authentication.privilege-store', this.#privilegeStore);
    }
    if (this.#delegationStore) {
      kernel.container.registerValue('authentication.delegation-store', this.#delegationStore);
    }
    if (this.#breakGlass) {
      kernel.container.registerValue('authentication.break-glass-store', this.#breakGlass);
    }
    kernel.logger.info(
      `principal boundary initialized (T-03): ${this.#boundary.getPolicy().describe()}; ` +
        `authenticators=[${this.#boundary.listAuthenticatorIds().join(',') || '<none>'}]` +
        (this.#eventStore ? '; durable sessions enabled (R2 S-8/S-9)' : '') +
        (this.#identityStore ? '; identity core enabled (P2-S1)' : '') +
        (this.#sessionTokens ? '; session tokens enabled (P2-S2)' : '') +
        (this.#privilegeStore ? '; privilege plane enabled (P2-S3)' : '') +
        (this.#delegationStore ? '; delegation plane enabled (P2-S4)' : ''),
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

  /** P2-S2 session-token service; throws when durable sessions are not enabled. */
  getSessionTokenService(): SessionTokenService {
    if (!this.#sessionTokens) throw new Error('Authentication module has no session-token service (durableSessions not enabled).');
    return this.#sessionTokens;
  }

  /** R2 S-9 registry; throws when durable sessions are not enabled. */
  getTokenRegistry(): TokenRegistryStore {
    if (!this.#tokenRegistry) throw new Error('Authentication module has no durable token registry (durableSessions not enabled).');
    return this.#tokenRegistry;
  }

  /** P2-S3 privilege plane; throws when durable sessions are not enabled. */
  getPrivilegeStore(): PrivilegeStore {
    if (!this.#privilegeStore) throw new Error('Authentication module has no durable privilege store (durableSessions not enabled).');
    return this.#privilegeStore;
  }

  /** P2-S4 delegation store; throws when durable sessions are not enabled. */
  getDelegationStore(): DelegationStore {
    if (!this.#delegationStore) throw new Error('Authentication module has no durable delegation store (durableSessions not enabled).');
    return this.#delegationStore;
  }

  /**
   * P2-S7 key-management seam. Throws when no seam was configured — it never
   * constructs or returns a development seam, so there is no implicit
   * production-to-dev fallback reachable from this getter.
   */
  getKeySeam(): KeyManagementSeam {
    if (!this.#keySeam) {
      throw new Error('Authentication module has no credential-material seam (credentialMaterial not configured; no dev fallback exists).');
    }
    return this.#keySeam;
  }

  /**
   * P2-S5: the MFA factor store, or a refusal. Like the other S7/S5 accessors
   * this NEVER constructs a fallback — a composition without
   * `credentialMaterial` has no MFA capability, and the privilege plane is
   * built `strictStepUp` so it fails closed rather than accepting asserted
   * step-up evidence.
   */
  getMfa(): MfaFactorStore {
    if (!this.#mfa) {
      throw new Error('Authentication module has no MFA factor store (credentialMaterial not configured; no dev fallback exists).');
    }
    return this.#mfa;
  }

  /** P2-S6 break-glass store; throws when S5/S7 are not configured. */
  getBreakGlassStore(): BreakGlassStore {
    if (!this.#breakGlass) {
      throw new Error('Authentication module has no break-glass store (credentialMaterial/S5 not configured; no standing emergency path exists).');
    }
    return this.#breakGlass;
  }

  /** P2-S7 secret-material store; throws when no seam was configured. */
  getSecretMaterial(): SecretMaterialStore {
    if (!this.#secretMaterial) {
      throw new Error('Authentication module has no secret-material store (credentialMaterial not configured; no dev fallback exists).');
    }
    return this.#secretMaterial;
  }
}
