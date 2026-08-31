// Types for Unified Capability Control Plane

export type SystemStateStatus = 'BOOTING' | 'HEALTHY' | 'DEGRADED' | 'MAINTENANCE' | 'SHUTTING_DOWN';

export interface SystemTelemetryEvent {
  eventId: string;
  layer: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: string;
  actor: string;
}

export interface ControlPlaneState {
  status: SystemStateStatus;
  activeModules: string[];
  totalTelemetryEvents: number;
  lastHealthCheck: string;
}
