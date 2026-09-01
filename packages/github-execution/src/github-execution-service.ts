import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import type { CommercialAction, CommercialActor, CommercialEvidence, ConnectorCapability, ConnectorHealth } from '@jataqi/commercial-control-plane';
import { ExternalConnectorRegistry } from '@jataqi/external-connectors';
import type { ExternalConnector } from '@jataqi/external-connectors';
import {
  DefaultGitHubActions,
  type ConfigureGitHubExecutionInput,
  type GitHubExecutionClient,
  type GitHubExecutionConnection,
  type GitHubExecutionPlanInput,
  type GitHubExecutionResult,
  type GitHubExecutionRunOptions,
  type GitHubExecutionStatus,
} from './types.js';

const CONNECTIONS_COLLECTION = 'github-execution.connections';

export class GitHubExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubExecutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * GitHub operation boundary. This service never reads a token from the process
 * or source code; a caller must provide an authorized client implementation and
 * a secret-manager reference. Without one, the connection remains explicitly
 * blocked rather than attempting a GitHub write.
 */
export class GitHubExecutionService {
  private connections!: ICollection<GitHubExecutionConnection>;
  private registry!: ExternalConnectorRegistry;
  private runtime!: ActionRuntimeService;
  private readonly clients = new Map<string, GitHubExecutionClient>();

  async init(kernel: KernelApi, registry: ExternalConnectorRegistry, runtime: ActionRuntimeService): Promise<void> {
    this.connections = await kernel.getModule<StorageModule>('storage').collection<GitHubExecutionConnection>(CONNECTIONS_COLLECTION);
    this.registry = registry;
    this.runtime = runtime;
  }

  /**
   * Persist connection metadata and register an inactive GitHub connector. This
   * method does not call GitHub; activate() is an explicit later operation.
   */
  async configure(actor: CommercialActor, input: ConfigureGitHubExecutionInput = {}): Promise<GitHubExecutionConnection> {
    assertAdministrator(actor);
    const tenantId = input.tenantId ?? actor.tenantId;
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new GitHubExecutionError('Only a global administrator may configure GitHub for another tenant.');
    const environment = input.environment ?? 'sandbox';
    if (environment === 'production' && !input.productionEnabled) {
      // A production client may be staged, but cannot be activated/executed until explicit enablement.
    }
    const now = Date.now();
    const connection: GitHubExecutionConnection = {
      id: randomUUID(),
      tenantId,
      environment,
      credentialReference: input.credentialReference,
      status: input.client ? 'READY_FOR_APPROVAL' : 'BLOCKED_CREDENTIALS',
      connectorHealth: input.client ? 'DISABLED' : 'AUTHORIZATION_REQUIRED',
      supportedActions: [...(input.supportedActions ?? DefaultGitHubActions)],
      requiredPermissions: [...(input.requiredPermissions ?? defaultPermissions())],
      productionEnabled: input.productionEnabled ?? false,
      lastCheckedAt: now,
      reason: input.client
        ? environment === 'production' && !input.productionEnabled
          ? 'Production client is configured but awaits explicit production enablement.'
          : 'Client is configured but connector activation has not been requested.'
        : 'No authorized GitHub client is configured.',
    };
    const connector = this.toConnector(connection, input.client);
    const registration = await this.registry.register(actor, connector);
    connection.connectorRegistrationId = registration.id;
    await this.connections.put(connection);
    if (input.client) this.clients.set(connection.id, input.client);
    return copy(connection);
  }

  /**
   * Connect only when an authorized client exists and production has been
   * explicitly enabled. Connector health/capabilities are independently checked
   * by the external connector fabric.
   */
  async activate(actor: CommercialActor, connectionId: string): Promise<GitHubExecutionConnection> {
    const connection = await this.requireConnection(actor, connectionId);
    const client = this.clients.get(connection.id);
    if (!client) return this.update(connection, { status: 'BLOCKED_CREDENTIALS', connectorHealth: 'AUTHORIZATION_REQUIRED', reason: 'No authorized GitHub client is configured.' });
    if (connection.environment === 'production' && !connection.productionEnabled) {
      return this.update(connection, { status: 'READY_FOR_APPROVAL', connectorHealth: 'DISABLED', reason: 'Production activation requires explicit enablement.' });
    }
    if (!connection.connectorRegistrationId) throw new GitHubExecutionError('GitHub connector registration is missing. Reconfigure the connection.');

    try {
      const activated = await this.registry.activate(actor, connection.connectorRegistrationId);
      const status = statusForHealth(activated.health.health, connection);
      return this.update(connection, {
        status,
        connectorHealth: activated.health.health,
        lastCheckedAt: activated.health.observedAt,
        reason: activated.health.reason,
      });
    } catch (error) {
      const message = errorMessage(error);
      return this.update(connection, { status: 'DEGRADED', connectorHealth: 'FAILED', lastCheckedAt: Date.now(), reason: message });
    }
  }

  /**
   * Records a production-ready state only with supplied independent evidence.
   * An administrator assertion or a successful API response alone is not enough.
   */
  async markLiveVerified(actor: CommercialActor, connectionId: string, evidence: CommercialEvidence[]): Promise<GitHubExecutionConnection> {
    assertAdministrator(actor);
    const connection = await this.requireConnection(actor, connectionId);
    if (connection.environment !== 'production' || !connection.productionEnabled) {
      throw new GitHubExecutionError('Only an explicitly enabled production connection may be marked live verified.');
    }
    if (connection.connectorHealth !== 'HEALTHY') throw new GitHubExecutionError('Only a healthy connection may be marked live verified.');
    if (!evidence.length || evidence.some((item) => !['MEASURED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED'].includes(item.status))) {
      throw new GitHubExecutionError('LIVE_VERIFIED requires one or more independently measured or verified evidence records.');
    }
    const now = Date.now();
    return this.update(connection, {
      status: 'LIVE_VERIFIED',
      lastCheckedAt: now,
      liveVerifiedAt: now,
      verificationEvidence: copy(evidence),
      reason: 'Authorized operator recorded independently evidenced live verification.',
    });
  }

  /** Plan through the control plane and require decision/connection correlation. */
  async plan(actor: CommercialActor, decisionId: string, input: GitHubExecutionPlanInput): Promise<CommercialAction> {
    const connection = await this.requireConnection(actor, input.connectionId);
    if (connection.status !== 'CONNECTED' && connection.status !== 'LIVE_VERIFIED') {
      throw new GitHubExecutionError(`GitHub connection is ${connection.status}; action planning is blocked.`);
    }
    const decision = await this.runtime.getDecision(actor, decisionId);
    if (!decision) throw new GitHubExecutionError('Commercial decision not found.');
    if (decision.connectorId !== connection.connectorRegistrationId) {
      throw new GitHubExecutionError('Commercial decision is not bound to this GitHub connector registration.');
    }
    const { connectionId: _connectionId, ...planInput } = input;
    return this.runtime.plan(actor, decisionId, { ...planInput, targetSystem: targetSystem(connection) });
  }

  async execute(actor: CommercialActor, connectionId: string, actionId: string, options: GitHubExecutionRunOptions = {}): Promise<GitHubExecutionResult> {
    const connection = await this.requireConnection(actor, connectionId);
    const requireLiveVerification = options.requireLiveVerification ?? connection.environment === 'production';
    if (connection.status !== 'CONNECTED' && connection.status !== 'LIVE_VERIFIED') {
      throw new GitHubExecutionError(`GitHub execution is blocked: connection status is ${connection.status}.`);
    }
    if (requireLiveVerification && connection.status !== 'LIVE_VERIFIED') {
      throw new GitHubExecutionError('GitHub production execution requires a LIVE_VERIFIED connection.');
    }
    const result = await this.runtime.execute(actor, actionId, options);
    return {
      actionId,
      status: connection.status,
      executedExternally: result.executedExternally,
      executionState: result.action.executionStatus,
    };
  }

  async verify(actor: CommercialActor, connectionId: string, actionId: string, timeoutMs?: number): Promise<CommercialAction> {
    const connection = await this.requireConnection(actor, connectionId);
    if (connection.status !== 'CONNECTED' && connection.status !== 'LIVE_VERIFIED') throw new GitHubExecutionError(`GitHub verification is blocked: connection status is ${connection.status}.`);
    return this.runtime.verify(actor, actionId, timeoutMs);
  }

  async rollback(actor: CommercialActor, connectionId: string, actionId: string, timeoutMs?: number): Promise<CommercialAction> {
    const connection = await this.requireConnection(actor, connectionId);
    if (connection.status !== 'CONNECTED' && connection.status !== 'LIVE_VERIFIED') throw new GitHubExecutionError(`GitHub rollback is blocked: connection status is ${connection.status}.`);
    return this.runtime.rollback(actor, actionId, timeoutMs);
  }

  async get(actor: CommercialActor, connectionId: string): Promise<GitHubExecutionConnection | undefined> {
    const connection = await this.connections.get(connectionId);
    return connection && canRead(actor, connection.tenantId) ? copy(connection) : undefined;
  }

  async list(actor: CommercialActor): Promise<GitHubExecutionConnection[]> {
    return (await this.connections.all()).filter((connection) => canRead(actor, connection.tenantId)).map(copy);
  }

  private async requireConnection(actor: CommercialActor, connectionId: string): Promise<GitHubExecutionConnection> {
    const connection = await this.get(actor, connectionId);
    if (!connection) throw new GitHubExecutionError('GitHub connection not found.');
    return connection;
  }

  private async update(connection: GitHubExecutionConnection, patch: Partial<GitHubExecutionConnection>): Promise<GitHubExecutionConnection> {
    const updated: GitHubExecutionConnection = { ...connection, ...patch };
    await this.connections.put(updated);
    return copy(updated);
  }

  private toConnector(connection: GitHubExecutionConnection, client: GitHubExecutionClient | undefined): ExternalConnector {
    const staticCapability: ConnectorCapability = {
      providerId: 'github',
      providerType: 'source-control',
      supportedActions: [...connection.supportedActions],
      authenticationMethod: 'github-app-or-oauth',
      requiredPermissions: [...connection.requiredPermissions],
      rollbackSupport: Boolean(client?.rollback),
      webhookSupport: true,
      sandboxSupport: true,
      productionSupport: true,
    };
    return {
      id: `github-connector:${connection.id}`,
      tenantId: connection.tenantId,
      providerId: staticCapability.providerId,
      providerType: staticCapability.providerType,
      targetSystem: targetSystem(connection),
      environment: connection.environment,
      supportedActions: staticCapability.supportedActions,
      authenticationMethod: staticCapability.authenticationMethod,
      requiredPermissions: staticCapability.requiredPermissions,
      rollbackSupport: staticCapability.rollbackSupport,
      webhookSupport: staticCapability.webhookSupport,
      sandboxSupport: staticCapability.sandboxSupport,
      productionSupport: staticCapability.productionSupport,
      credentialReference: connection.credentialReference,
      connect: client?.connect ? async (context) => client.connect!({ tenantId: context.tenantId, credentialReference: context.credentialReference, signal: context.signal }) : undefined,
      authenticate: client?.authenticate ? async (context) => client.authenticate!({ tenantId: context.tenantId, credentialReference: context.credentialReference, signal: context.signal }) : undefined,
      health: async (context) => client
        ? client.health({ tenantId: context.tenantId, signal: context.signal })
        : { health: 'AUTHORIZATION_REQUIRED', reason: 'No authorized GitHub client is configured.', observedAt: Date.now() },
      capabilities: async (context) => client
        ? client.capabilities({ tenantId: context.tenantId, signal: context.signal })
        : staticCapability,
      execute: async (context) => {
        if (!client) throw new GitHubExecutionError('GitHub execution is blocked: no authorized client is configured.');
        return client.execute(context);
      },
      verify: async (context) => {
        if (!client) throw new GitHubExecutionError('GitHub verification is blocked: no authorized client is configured.');
        return client.verify(context);
      },
      rollback: client?.rollback ? (context) => client.rollback!(context) : undefined,
      disconnect: client?.disconnect ? async (context) => client.disconnect!({ tenantId: context.tenantId, credentialReference: context.credentialReference, signal: context.signal }) : undefined,
    };
  }
}

function targetSystem(connection: GitHubExecutionConnection): string {
  return `github:${connection.id}`;
}

function statusForHealth(health: ConnectorHealth, connection: GitHubExecutionConnection): GitHubExecutionStatus {
  if (health === 'HEALTHY') return 'CONNECTED';
  if (health === 'AUTHORIZATION_REQUIRED' || health === 'CREDENTIAL_EXPIRED') {
    return connection.credentialReference ? 'BLOCKED_PERMISSION' : 'BLOCKED_CREDENTIALS';
  }
  return 'DEGRADED';
}

function defaultPermissions(): string[] {
  return ['contents:read', 'contents:write', 'pull_requests:write', 'workflows:write'];
}

function assertAdministrator(actor: CommercialActor): void {
  if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new GitHubExecutionError('Commercial administrator role is required for GitHub connection configuration.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
