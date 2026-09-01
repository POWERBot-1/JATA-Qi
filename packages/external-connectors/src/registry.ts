import type { KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule, type ActionExecutionAdapter, type ActionRuntimeService } from '@jataqi/autonomous-action-runtime';
import {
  CommercialControlPlaneModule,
  type CommercialActor,
  type CommercialControlPlaneService,
  type ConnectorCapability,
} from '@jataqi/commercial-control-plane';
import type {
  ConnectorActivationResult,
  ConnectorContext,
  ConnectorContractReport,
  ConnectorRegistration,
  ExternalConnector,
} from './types.js';

export class ExternalConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalConnectorError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Connector registry that joins declared provider capability to the controlled
 * action runtime. No real connector is bundled: registration alone is not
 * activation, and activation records actual connector health before creating an
 * executable adapter.
 */
export class ExternalConnectorRegistry {
  private controlPlane!: CommercialControlPlaneService;
  private runtime!: ActionRuntimeService;
  private readonly connectors = new Map<string, ExternalConnector>();
  private readonly registrations = new Map<string, ConnectorRegistration>();
  private readonly runtimeAdapterIds = new Map<string, string>();

  async init(kernel: KernelApi): Promise<void> {
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    this.runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
  }

  /** Register a capability declaration in disabled state; no provider call is made. */
  async register(actor: CommercialActor, connector: ExternalConnector): Promise<ConnectorRegistration> {
    validateConnector(connector);
    if (this.connectors.has(connector.id)) throw new ExternalConnectorError(`Connector "${connector.id}" is already registered.`);
    if (connector.tenantId && connector.tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) {
      throw new ExternalConnectorError('A connector may only be registered for the caller tenant.');
    }

    const record = await this.controlPlane.registerConnector(actor, {
      providerId: connector.providerId,
      providerType: connector.providerType,
      tenantId: connector.tenantId ?? actor.tenantId,
      supportedActions: [...connector.supportedActions],
      authenticationMethod: connector.authenticationMethod,
      requiredPermissions: [...connector.requiredPermissions],
      rateLimits: connector.rateLimits ? { ...connector.rateLimits } : undefined,
      costModel: connector.costModel,
      regions: connector.regions ? [...connector.regions] : undefined,
      availability: connector.availability,
      rollbackSupport: typeof connector.rollback === 'function',
      webhookSupport: connector.webhookSupport,
      sandboxSupport: connector.sandboxSupport,
      productionSupport: connector.productionSupport,
      lastVerifiedAt: connector.lastVerifiedAt,
      health: 'DISABLED',
      healthReason: 'Registered but not activated.',
    });
    const registration: ConnectorRegistration = {
      id: record.id,
      providerId: connector.providerId,
      providerType: connector.providerType,
      targetSystem: connector.targetSystem,
      tenantId: record.tenantId ?? actor.tenantId,
      environment: connector.environment,
      health: 'DISABLED',
      supportedActions: [...connector.supportedActions],
      rollbackSupported: typeof connector.rollback === 'function',
      credentialReference: connector.credentialReference,
      connected: false,
    };
    this.connectors.set(registration.id, connector);
    this.registrations.set(registration.id, registration);
    return copy(registration);
  }

  /**
   * Explicitly activate a connector. Connection, authentication, capability
   * discovery, and health must all succeed before an execution adapter exists.
   */
  async activate(actor: CommercialActor, registrationId: string): Promise<ConnectorActivationResult> {
    const registration = this.requireRegistration(actor, registrationId);
    const connector = this.connectors.get(registrationId)!;
    const context = connectorContext(registration);

    try {
      await connector.connect?.(context);
      await connector.authenticate?.(context);
      const capability = await connector.capabilities(context);
      validateCapability(capability, connector);
      const health = await connector.health(context);
      await this.controlPlane.updateConnectorHealth(actor, registrationId, health.health, health.reason);

      const updated: ConnectorRegistration = {
        ...registration,
        health: health.health,
        connected: health.health === 'HEALTHY',
        lastVerifiedAt: health.observedAt,
      };
      this.registrations.set(registrationId, updated);
      if (health.health === 'HEALTHY') this.installRuntimeAdapter(registrationId, connector);
      else this.removeRuntimeAdapter(registrationId);
      return { registration: copy(updated), capability: copy(capability), health: copy(health) };
    } catch (error) {
      const reason = errorMessage(error);
      await this.controlPlane.updateConnectorHealth(actor, registrationId, 'FAILED', reason);
      const updated: ConnectorRegistration = { ...registration, health: 'FAILED', connected: false };
      this.registrations.set(registrationId, updated);
      this.removeRuntimeAdapter(registrationId);
      throw new ExternalConnectorError(`Connector activation failed: ${reason}`);
    }
  }

  /** Remove executable capability before disconnecting and mark connector disabled. */
  async deactivate(actor: CommercialActor, registrationId: string, reason = 'Disabled by authorized operator.'): Promise<ConnectorRegistration> {
    const registration = this.requireRegistration(actor, registrationId);
    const connector = this.connectors.get(registrationId)!;
    this.removeRuntimeAdapter(registrationId);
    try {
      await connector.disconnect?.(connectorContext(registration));
    } finally {
      await this.controlPlane.updateConnectorHealth(actor, registrationId, 'DISABLED', reason);
      const updated: ConnectorRegistration = { ...registration, health: 'DISABLED', connected: false };
      this.registrations.set(registrationId, updated);
      return copy(updated);
    }
  }

  get(actor: CommercialActor, registrationId: string): ConnectorRegistration | undefined {
    const registration = this.registrations.get(registrationId);
    if (!registration || !canRead(actor, registration.tenantId)) return undefined;
    return copy(registration);
  }

  list(actor: CommercialActor): ConnectorRegistration[] {
    return [...this.registrations.values()].filter((registration) => canRead(actor, registration.tenantId)).map(copy);
  }

  /** Read-only contract assessment; it never calls execute, verify, or rollback. */
  async contractReport(actor: CommercialActor, registrationId: string): Promise<ConnectorContractReport> {
    const registration = this.requireRegistration(actor, registrationId);
    const connector = this.connectors.get(registrationId)!;
    const reasons: string[] = [];
    let capabilityDeclared = false;
    let healthChecked = false;
    try {
      const capability = await connector.capabilities(connectorContext(registration));
      validateCapability(capability, connector);
      capabilityDeclared = true;
    } catch (error) {
      reasons.push(`Capability discovery failed: ${errorMessage(error)}`);
    }
    try {
      const health = await connector.health(connectorContext(registration));
      healthChecked = true;
      if (health.health !== 'HEALTHY') reasons.push(`Connector health is ${health.health}${health.reason ? `: ${health.reason}` : ''}.`);
    } catch (error) {
      reasons.push(`Health check failed: ${errorMessage(error)}`);
    }
    if (!connector.credentialReference) reasons.push('No credential reference is configured.');
    if (!connector.rollback) reasons.push('Connector does not declare rollback support.');
    const actionContractReady = capabilityDeclared && healthChecked && registration.supportedActions.length > 0;
    return {
      connectorId: registrationId,
      capabilityDeclared,
      healthChecked,
      actionContractReady,
      rollbackContractReady: typeof connector.rollback === 'function',
      credentialReferencePresent: Boolean(connector.credentialReference),
      status: actionContractReady && registration.health === 'HEALTHY' ? 'READY' : 'BLOCKED',
      reasons,
    };
  }

  private requireRegistration(actor: CommercialActor, registrationId: string): ConnectorRegistration {
    const registration = this.registrations.get(registrationId);
    if (!registration || !canRead(actor, registration.tenantId)) throw new ExternalConnectorError('Connector registration not found.');
    return registration;
  }

  private installRuntimeAdapter(registrationId: string, connector: ExternalConnector): void {
    this.removeRuntimeAdapter(registrationId);
    const adapterId = `connector:${registrationId}`;
    const adapter: ActionExecutionAdapter = {
      id: adapterId,
      targetSystem: connector.targetSystem,
      actionTypes: [...connector.supportedActions],
      environment: connector.environment,
      maxAttempts: connector.maxAttempts,
      defaultTimeoutMs: connector.defaultTimeoutMs,
      execute: (context) => connector.execute(context),
      verify: (context) => connector.verify(context),
      rollback: connector.rollback ? (context) => connector.rollback!(context) : undefined,
    };
    this.runtime.registerAdapter(adapter);
    this.runtimeAdapterIds.set(registrationId, adapterId);
  }

  private removeRuntimeAdapter(registrationId: string): void {
    const adapterId = this.runtimeAdapterIds.get(registrationId);
    if (!adapterId) return;
    this.runtime.unregisterAdapter(adapterId);
    this.runtimeAdapterIds.delete(registrationId);
  }
}

function connectorContext(registration: ConnectorRegistration): ConnectorContext {
  return {
    tenantId: registration.tenantId,
    environment: registration.environment,
    credentialReference: registration.credentialReference,
    signal: new AbortController().signal,
  };
}

function validateConnector(connector: ExternalConnector): void {
  if (!connector.id?.trim()) throw new ExternalConnectorError('Connector id is required.');
  if (!connector.providerId?.trim() || !connector.providerType?.trim() || !connector.targetSystem?.trim()) throw new ExternalConnectorError('Connector provider id, type, and target system are required.');
  if (!Array.isArray(connector.supportedActions) || connector.supportedActions.length === 0 || connector.supportedActions.some((action) => !action.trim())) throw new ExternalConnectorError('Connector must declare supported actions.');
  if (!connector.authenticationMethod?.trim()) throw new ExternalConnectorError('Connector authentication method is required.');
  if (!Array.isArray(connector.requiredPermissions)) throw new ExternalConnectorError('Connector required permissions must be declared.');
  if (connector.environment !== 'sandbox' && connector.environment !== 'production') throw new ExternalConnectorError('Connector environment must be sandbox or production.');
}

function validateCapability(capability: ConnectorCapability, connector: ExternalConnector): void {
  if (capability.providerId !== connector.providerId || capability.providerType !== connector.providerType) throw new ExternalConnectorError('Discovered capability does not match the registered provider identity.');
  for (const action of connector.supportedActions) {
    if (!capability.supportedActions.includes(action)) throw new ExternalConnectorError(`Discovered capability does not include registered action ${action}.`);
  }
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
