// TeamCoordinatorModule — the Mission Coordinator. Declares teams of agents and
// runs an objective through them using one of three collaboration modes.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { AgentRuntimeModule } from '@jataqi/agent-runtime';
import { TeamEvents } from './types.js';
import type { CollaborationMode, Contribution, TeamConfig, TeamResult } from './types.js';

export class TeamCoordinatorModule implements IModule {
  readonly id = 'teams';
  readonly tags = ['core', 'agent'] as const;
  readonly dependsOn = ['agent-runtime'] as const;

  private api!: KernelApi;
  private teams = new Map<string, TeamConfig>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('teams', this);
    kernel.logger.info('team coordinator initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.teams.clear(); }

  /** Register a team. Member agents are auto-created (default config) if absent. */
  createTeam(team: TeamConfig): TeamConfig {
    if (this.teams.has(team.name)) throw new Error(`teams: team "${team.name}" already exists`);
    const agents = this.api.getModule<AgentRuntimeModule>('agent-runtime');
    for (const member of team.members) {
      if (!this.hasAgent(agents, member)) agents.createAgent(member);
    }
    if (team.synthesizer && !this.hasAgent(agents, team.synthesizer)) {
      agents.createAgent(team.synthesizer);
    }
    const full: TeamConfig = { mode: 'parallel', ...team };
    this.teams.set(team.name, full);
    void this.api.bus.emit(TeamEvents.TeamRegistered, { team: team.name });
    return full;
  }

  getTeam(name: string): TeamConfig {
    const t = this.teams.get(name);
    if (!t) throw new Error(`teams: team "${name}" not found`);
    return t;
  }

  listTeams(): TeamConfig[] {
    return [...this.teams.values()];
  }

  /** Run an objective through a registered (or ad-hoc) team. */
  async execute(objective: string, team: string | TeamConfig): Promise<TeamResult> {
    const config = typeof team === 'string' ? this.getTeam(team) : team;
    const agents = this.api.getModule<AgentRuntimeModule>('agent-runtime');
    // Ensure member agents exist (auto-create with default config when absent).
    for (const member of config.members) {
      if (!this.hasAgent(agents, member)) agents.createAgent(member);
    }
    const mode: CollaborationMode = config.mode ?? 'parallel';
    await this.api.bus.emit(TeamEvents.TeamRunStarted, { team: config.name, mode });

    const contributions: Contribution[] = [];
    if (mode === 'sequential') {
      let message = objective;
      for (const member of config.members) {
        const res = await agents.run(message, { agent: member });
        contributions.push({ agent: member, output: res.answer });
        message = res.answer; // each member builds on the previous
      }
    } else {
      const results = await Promise.all(
        config.members.map((m) => agents.run(objective, { agent: m })),
      );
      for (let i = 0; i < config.members.length; i++) {
        contributions.push({ agent: config.members[i]!, output: results[i]!.answer });
      }
    }

    let synthesis: string;
    if (mode === 'consensus') {
      synthesis = majorityVote(contributions);
      for (const c of contributions) (c as Contribution & { agrees?: boolean }).agrees = c.output === synthesis;
    } else if (mode === 'sequential') {
      synthesis = contributions[contributions.length - 1]?.output ?? '';
    } else {
      synthesis = await this.synthesize(objective, contributions, config.synthesizer ?? 'main');
    }

    const result: TeamResult = {
      objective,
      team: config.name,
      mode,
      contributions,
      synthesis,
    };
    await this.api.bus.emit(TeamEvents.TeamRunCompleted, { team: config.name, mode, members: config.members.length });
    return result;
  }

  /** Merge member contributions with a synthesizer agent. */
  private async synthesize(objective: string, contributions: Contribution[], synthesizer: string): Promise<string> {
    const agents = this.api.getModule<AgentRuntimeModule>('agent-runtime');
    const by = contributions.map((c) => `[${c.agent}] ${c.output}`).join('\n');
    const prompt =
      `Synthesize the following contributions from a team of agents into a single consolidated answer.\n` +
      `Objective: ${objective}\n\nContributions:\n${by}\n\nConsolidated answer:`;
    const res = await agents.run(prompt, { agent: synthesizer });
    return res.answer;
  }

  private hasAgent(agents: AgentRuntimeModule, name: string): boolean {
    try {
      agents.getAgent(name);
      return true;
    } catch {
      return false;
    }
  }
}

/** Pick the most frequent output string (ties resolved in favour of first seen). */
function majorityVote(contributions: Contribution[]): string {
  const counts = new Map<string, number>();
  for (const c of contributions) counts.set(c.output, (counts.get(c.output) ?? 0) + 1);
  let best = contributions[0]?.output ?? '';
  let bestCount = 0;
  for (const c of contributions) {
    const n = counts.get(c.output) ?? 0;
    if (n > bestCount) {
      bestCount = n;
      best = c.output;
    }
  }
  return best;
}
