// JATA Qi Environment — types (#31). Monitoring, readings, alerts, sustainability.

export type StationType = 'air' | 'water' | 'soil' | 'noise' | 'weather';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface MonitoringStation {
  id: string; name: string; type: StationType; location?: string;
  organizationId?: string; status: 'active' | 'inactive'; createdAt: number;
}

export interface EnvironmentalReading {
  id: string; stationId: string; parameter: string; value: number; unit: string;
  timestamp: number;
}

export interface EnvironmentalAlert {
  id: string; stationId: string; parameter: string; threshold: number; value: number;
  severity: AlertSeverity; message: string; acknowledged: boolean; createdAt: number;
}

export interface SustainabilityMetric {
  id: string; organizationId?: string; metric: string; value: number; unit: string;
  period: string; createdAt: number;
}

export const EnvironmentEvents = Object.freeze({
  AlertTriggered: 'env.alert.triggered',
  ReadingRecorded: 'env.reading.recorded',
} as const);
