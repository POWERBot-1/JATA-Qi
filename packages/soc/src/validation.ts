// Continuous adversarial validation — red-team / purple-team exercises,
// attack simulations, and tabletop scenarios. Each campaign emits realistic
// telemetry and scores whether the defense controls detect it.

import { randomUUID } from 'node:crypto';
import type { CampaignKind, CampaignStep, ExerciseCampaign, TabletopScenario } from './types.js';
import type { TelemetryPipeline } from './telemetry.js';

export const DEFAULT_CAMPAIGNS: Record<CampaignKind, { name: string; steps: CampaignStep[] }> = {
  credential_stuffing: {
    name: 'Credential stuffing simulation',
    steps: [
      {
        name: 'brute-force burst', expectedControl: 'failed-login detection / abuse engine',
        telemetry: [
          { type: 'security.auth.denied', actor: 'attacker-1', origin: '203.0.113.10', data: { reason: 'bad password' } },
          { type: 'security.auth.denied', actor: 'attacker-1', origin: '203.0.113.10', data: { reason: 'bad password' } },
          { type: 'security.auth.denied', actor: 'attacker-1', origin: '203.0.113.10', data: { reason: 'bad password' } },
          { type: 'security.auth.denied', actor: 'attacker-1', origin: '203.0.113.10', data: { reason: 'bad password' } },
          { type: 'security.auth.denied', actor: 'attacker-1', origin: '203.0.113.10', data: { reason: 'bad password' } },
        ],
      },
      {
        name: 'successful login after stuffing', expectedControl: 'risk scoring / step-up',
        telemetry: [
          { type: 'security.user.login', actor: 'attacker-1', origin: '203.0.113.10', data: { unusual: true } },
          { type: 'security.user.login', actor: 'attacker-1', origin: '203.0.113.10', data: { newDevice: true } },
        ],
      },
    ],
  },
  phishing_lure: {
    name: 'Phishing lure simulation',
    steps: [
      {
        name: 'phishing content posted', expectedControl: 'abuse detection (phishing patterns)',
        telemetry: [
          { type: 'content.submitted', actor: 'lure-1', origin: '198.51.100.20', data: { text: 'URGENT: verify your account at http://evil.example/wallet' } },
        ],
      },
      {
        name: 'honeytoken harvested', expectedControl: 'deception / honeytoken touch',
        telemetry: [
          { type: 'defense.honeytoken.touched', actor: 'lure-1', origin: '198.51.100.20', data: { label: 'db-cred' } },
        ],
      },
    ],
  },
  privilege_escalation: {
    name: 'Privilege escalation simulation',
    steps: [
      {
        name: 'RBAC escalation attempts', expectedControl: 'permission escalation detection',
        telemetry: [
          { type: 'security.permission.denied', actor: 'insider-1', data: { perm: 'admin:*' } },
          { type: 'security.permission.denied', actor: 'insider-1', data: { perm: 'pki:write' } },
          { type: 'security.permission.denied', actor: 'insider-1', data: { perm: 'cloud:write' } },
        ],
      },
      {
        name: 'privileged action burst', expectedControl: 'insider risk (privileged burst)',
        telemetry: [
          { type: 'audit.action', actor: 'insider-1', data: { sensitivity: 'critical', action: 'admin.user.export' } },
          { type: 'audit.action', actor: 'insider-1', data: { sensitivity: 'critical', action: 'admin.db.dump' } },
          { type: 'audit.action', actor: 'insider-1', data: { sensitivity: 'critical', action: 'admin.secret.read' } },
          { type: 'audit.action', actor: 'insider-1', data: { sensitivity: 'critical', action: 'admin.secret.read' } },
          { type: 'audit.action', actor: 'insider-1', data: { sensitivity: 'critical', action: 'admin.secret.read' } },
        ],
      },
    ],
  },
  data_exfiltration: {
    name: 'Data exfiltration simulation',
    steps: [
      {
        name: 'mass export burst', expectedControl: 'insider risk / hunt.data_exfil',
        telemetry: [
          { type: 'audit.export', actor: 'leaky-1', data: { rows: 5000 } },
          { type: 'audit.export', actor: 'leaky-1', data: { rows: 5000 } },
          { type: 'audit.export', actor: 'leaky-1', data: { rows: 5000 } },
          { type: 'audit.export', actor: 'leaky-1', data: { rows: 5000 } },
        ],
      },
    ],
  },
  lateral_movement: {
    name: 'Lateral movement simulation',
    steps: [
      {
        name: 'same actor across services', expectedControl: 'hunt.lateral_movement correlation',
        telemetry: [
          { type: 'cloud.instance.provisioned', actor: 'mover-1', origin: '10.0.0.5' },
          { type: 'network.connection', actor: 'mover-1', origin: '10.0.0.9' },
          { type: 'database.query', actor: 'mover-1', origin: '10.0.0.12' },
        ],
      },
    ],
  },
  supply_chain_tamper: {
    name: 'Supply-chain tamper simulation',
    steps: [
      {
        name: 'unverified artifact deployed', expectedControl: 'provenance / integrity validation',
        telemetry: [
          { type: 'deployment.verify.failed', actor: 'ci-bot', data: { artifact: 'web-1.2.3', signed: false } },
        ],
      },
    ],
  },
};

export class AdversarialValidationEngine {
  private campaigns: ExerciseCampaign[] = [];
  private scenarios: TabletopScenario[] = [];
  private lake: TelemetryPipeline;
  /** Callback: detection observer (e.g. SOC checks its detection engines). */
  private detect: (eventType: string) => boolean;

  constructor(lake: TelemetryPipeline, detect: (eventType: string) => boolean = () => true) {
    this.lake = lake;
    this.detect = detect;
  }

  /**
   * Run a campaign: emits each step's telemetry into the lake, then asks the
   * detection observer whether the expected control caught it. Score = the
   * fraction of steps detected.
   */
  runCampaign(kind: CampaignKind): ExerciseCampaign {
    const template = DEFAULT_CAMPAIGNS[kind];
    if (!template) throw new Error(`unknown campaign ${kind}`);
    const campaign: ExerciseCampaign = {
      id: randomUUID(), kind, name: template.name, steps: template.steps,
      startedAt: Date.now(), results: [], score: 0,
    };
    for (const step of template.steps) {
      this.lake.ingestBatch(step.telemetry.map((t) => ({
        source: 'soc' as const, type: t.type, ...(t.actor ? { actor: t.actor } : {}),
        ...(t.origin ? { origin: t.origin } : {}), ...(t.data ? { data: t.data } : {}),
      })));
      const detected = step.telemetry.some((t) => this.detect(t.type));
      campaign.results.push({ step: step.name, detected, control: step.expectedControl });
    }
    campaign.finishedAt = Date.now();
    campaign.score = campaign.results.length === 0 ? 0
      : Math.round((campaign.results.filter((r) => r.detected).length / campaign.results.length) * 100) / 100;
    this.campaigns.push(campaign);
    return campaign;
  }

  campaignsList(): ExerciseCampaign[] {
    return [...this.campaigns].reverse();
  }

  /** Overall detection coverage across all exercises. */
  validationScore(): number {
    const all = this.campaigns.flatMap((c) => c.results);
    if (all.length === 0) return 0;
    return Math.round((all.filter((r) => r.detected).length / all.length) * 100) / 100;
  }

  addScenario(input: { title: string; description: string; injects: string[]; facilitatorNotes?: string[] }): TabletopScenario {
    const scenario: TabletopScenario = {
      id: randomUUID(), title: input.title, description: input.description,
      injects: input.injects, facilitatorNotes: input.facilitatorNotes ?? [],
      createdAt: Date.now(),
    };
    this.scenarios.push(scenario);
    return scenario;
  }

  scenariosList(): TabletopScenario[] {
    return [...this.scenarios];
  }
}
