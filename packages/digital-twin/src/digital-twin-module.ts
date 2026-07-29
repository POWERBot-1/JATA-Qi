// DigitalTwinModule — registry of digital twins with persisted state, snapshot
// history, stepping, and trajectory projection.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { DigitalTwinEvents } from './types.js';
import type { Snapshot, TransitionSpec, Twin, TwinState } from './types.js';
import { project, snapshot as takeSnapshot, step as stepState } from './twin-engine.js';

const COL_TWINS = 'digital-twin.twins';

export interface RegisterTwinInput {
  type: string;
  name: string;
  state: TwinState;
  metadata?: Record<string, unknown>;
}

export class DigitalTwinModule implements IModule {
  readonly id = 'digital-twin';
  readonly tags = ['intelligence', 'twin'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private twins!: ICollection<Twin>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.twins = await storage.collection<Twin>(COL_TWINS);
    kernel.container.registerValue('digital-twin', this);
    kernel.logger.info('digital-twin module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  async register(input: RegisterTwinInput): Promise<Twin> {
    if (!input.name || !input.type) throw new Error('digital-twin: name and type are required');
    const now = Date.now();
    const twin: Twin = {
      id: randomUUID(),
      type: input.type,
      name: input.name,
      state: { ...input.state },
      ...(input.metadata ? { metadata: input.metadata } : {}),
      history: [takeSnapshot(input.state, 0)],
      createdAt: now,
    };
    await this.twins.put(twin);
    await this.api.bus.emit(DigitalTwinEvents.TwinRegistered, { id: twin.id, type: twin.type });
    return twin;
  }

  async get(id: string): Promise<Twin | undefined> {
    return this.twins.get(id);
  }

  async list(type?: string): Promise<Twin[]> {
    const all = await this.twins.all();
    return type ? all.filter((t) => t.type === type) : all;
  }

  /** Merge partial state into the twin (does not advance time). */
  async update(id: string, partial: TwinState): Promise<Twin> {
    const t = await this.twins.get(id);
    if (!t) throw new Error(`digital-twin: twin "${id}" not found`);
    const updated: Twin = { ...t, state: { ...t.state, ...partial } };
    await this.twins.put(updated);
    return updated;
  }

  /** Apply one transition step (advances time, records a snapshot). */
  async step(id: string, rules: TransitionSpec[]): Promise<Twin> {
    const t = await this.twins.get(id);
    if (!t) throw new Error(`digital-twin: twin "${id}" not found`);
    const nextT = (t.history[t.history.length - 1]?.t ?? 0) + 1;
    const newState = stepState(t.state, rules);
    const snap: Snapshot = takeSnapshot(newState, nextT);
    const updated: Twin = { ...t, state: newState, history: [...t.history, snap] };
    await this.twins.put(updated);
    await this.api.bus.emit(DigitalTwinEvents.TwinStepped, { id, t: nextT });
    return updated;
  }

  /** Project N steps without persisting; returns the trajectory of states. */
  async project(id: string, rules: TransitionSpec[], steps: number): Promise<TwinState[]> {
    const t = await this.twins.get(id);
    if (!t) throw new Error(`digital-twin: twin "${id}" not found`);
    return project(t.state, rules, steps);
  }
}
