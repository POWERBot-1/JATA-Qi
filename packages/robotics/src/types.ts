// JATA Qi Robotics — domain types (spec Step 32 "Embodied Intelligence &
// Robotics Civilization Layer"). Models a governed bridge between digital
// intelligence and physical machines: devices, missions, telemetry, and the
// digital twin metadata that mirrors each machine.

export type DeviceKind =
  | 'humanoid'
  | 'industrial'
  | 'agricultural'
  | 'medical'
  | 'service'
  | 'explorer'
  | 'vehicle'
  | 'drone'
  | string;

export type DeviceStatus = 'online' | 'offline' | 'busy' | 'error';

/** A registered physical machine and its digital twin metadata. */
export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  capabilities: string[];
  status: DeviceStatus;
  location?: { lat: number; lon: number; label?: string };
  /** Latest telemetry readings (e.g. { battery: 82, temp: 41.5 }). */
  telemetry: Record<string, number>;
  /** Digital twin: specs, operational history summary, maintenance records. */
  twin: {
    specs?: Record<string, unknown>;
    maintenance?: { at: number; note: string }[];
  };
  lastSeen: number;
  createdAt: number;
}

export type MissionStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';

/** A unit of work assigned to a device. */
export interface Mission {
  id: string;
  deviceId: string;
  objective: string;
  status: MissionStatus;
  createdAt: number;
  assignedAt?: number;
  completedAt?: number;
  result?: string;
}

export const RoboticsEvents = Object.freeze({
  DeviceRegistered: 'robotics.device.registered',
  StatusChanged: 'robotics.device.status_changed',
  TelemetryRecorded: 'robotics.device.telemetry',
  MissionAssigned: 'robotics.mission.assigned',
  MissionCompleted: 'robotics.mission.completed',
} as const);
