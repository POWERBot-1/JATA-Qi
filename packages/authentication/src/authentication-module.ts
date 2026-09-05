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
import { PrincipalBoundary, type PrincipalBoundaryConfig } from './principal-boundary.js';

export type AuthenticationModuleConfig = PrincipalBoundaryConfig;

export class AuthenticationModule implements IModule {
  readonly id = 'authentication';
  readonly tags = ['authentication', 'principal', 'authority', 'boundary'] as const;
  // A leaf boundary: it verifies credentials and depends on no other module.
  readonly dependsOn: readonly string[] = [];

  readonly #config: AuthenticationModuleConfig;
  #boundary: PrincipalBoundary | undefined;

  constructor(config: AuthenticationModuleConfig = {}) {
    this.#config = { ...config };
  }

  async init(kernel: KernelApi): Promise<void> {
    // Construction is fail-closed: an unusable policy or an authenticator that
    // could produce an inadmissible method throws here, before boot completes.
    this.#boundary = new PrincipalBoundary(this.#config);
    kernel.container.registerValue('authentication.boundary', this.#boundary);
    kernel.container.registerValue('authentication', this.#boundary);
    kernel.logger.info(
      `principal boundary initialized (T-03): ${this.#boundary.getPolicy().describe()}; ` +
        `authenticators=[${this.#boundary.listAuthenticatorIds().join(',') || '<none>'}]`,
    );
  }

  getService(): PrincipalBoundary {
    if (!this.#boundary) throw new Error('Authentication module is not initialized.');
    return this.#boundary;
  }
}
