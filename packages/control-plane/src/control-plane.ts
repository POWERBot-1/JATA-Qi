// Unified Capability Control Plane Orchestration Fabric

import type { SystemTelemetryEvent, ControlPlaneState, SystemStateStatus } from './types.js';

export class ControlPlane {
  private status: SystemStateStatus = 'BOOTING';
  private readonly registeredModules = new Set<string>();
  private readonly telemetryLog: SystemTelemetryEvent[] = [];
  private lastHealthCheck = new Date().toISOString();

  registerModule(moduleId: string): void {
    this.registeredModules.add(moduleId);
  }

  emitTelemetry(layer: string, eventType: string, payload: Record<string, unknown>, actor = 'system'): SystemTelemetryEvent {
    const event: SystemTelemetryEvent = {
      eventId: `tel-${Math.random().toString(36).substring(2, 10)}`,
      layer,
      eventType,
      payload,
      timestamp: new Date().toISOString(),
      actor,
    };
    this.telemetryLog.push(event);
    if (this.telemetryLog.length > 1000) {
      this.telemetryLog.shift();
    }
    return event;
  }

  setHealthy(): void {
    this.status = 'HEALTHY';
    this.lastHealthCheck = new Date().toISOString();
  }

  getState(): ControlPlaneState {
    return {
      status: this.status,
      activeModules: Array.from(this.registeredModules),
      totalTelemetryEvents: this.telemetryLog.length,
      lastHealthCheck: this.lastHealthCheck,
    };
  }

  getRecentTelemetry(limit = 50): SystemTelemetryEvent[] {
    return this.telemetryLog.slice(-limit);
  }
}
