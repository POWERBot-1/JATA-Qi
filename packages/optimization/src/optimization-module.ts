// OptimizationModule — real optimization algorithms (#directive: Advanced Optimization Engine).
// Implements: bin packing (first-fit-decreasing), assignment (Hungarian-lite greedy),
// job scheduling (earliest-deadline-first), knapsack (0/1 dynamic programming),
// and TSP (nearest-neighbor heuristic). No external dependencies.

import type { KernelApi, IModule } from '@jataqi/core-kernel';

export interface BinPackingResult { bins: { items: number[]; total: number }[]; unassigned: number[]; }
export interface AssignmentResult { assignments: { task: number; agent: number; cost: number }[]; totalCost: number; }
export interface ScheduleResult { schedule: { job: number; start: number; end: number; machine: number }[]; makespan: number; }
export interface KnapsackResult { items: number[]; totalValue: number; totalWeight: number; }

export interface BinPackingInput { items: { id: number; size: number }[]; capacity: number; }
export interface AssignmentInput { costs: number[][]; } // costs[task][agent]
export interface ScheduleInput { jobs: { id: number; duration: number; deadline?: number }[]; machines: number; }
export interface KnapsackInput { items: { id: number; weight: number; value: number }[]; capacity: number; }
export interface TSPInput { points: { id: number; x: number; y: number }[]; }

export const OptimizationEvents = Object.freeze({
  OptimizationCompleted: 'optimization.completed',
} as const);

export class OptimizationModule implements IModule {
  readonly id = 'optimization';
  readonly tags = ['intelligence', 'optimization'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('optimization', this);
    kernel.logger.info('optimization module initialized');
  }
  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  /** First-fit-decreasing bin packing. */
  binPacking(input: BinPackingInput): BinPackingResult {
    const sorted = [...input.items].sort((a, b) => b.size - a.size);
    const bins: { items: number[]; total: number }[] = [];
    const unassigned: number[] = [];
    for (const item of sorted) {
      if (item.size > input.capacity) { unassigned.push(item.id); continue; }
      let placed = false;
      for (const bin of bins) {
        if (bin.total + item.size <= input.capacity) { bin.items.push(item.id); bin.total += item.size; placed = true; break; }
      }
      if (!placed) bins.push({ items: [item.id], total: item.size });
    }
    return { bins, unassigned };
  }

  /** Greedy assignment minimizing total cost. */
  assignment(input: AssignmentInput): AssignmentResult {
    const { costs } = input;
    const tasks = costs.length;
    const agents = costs[0]?.length ?? 0;
    if (tasks === 0 || agents === 0) return { assignments: [], totalCost: 0 };
    const assigned = new Set<number>();
    const assignments: { task: number; agent: number; cost: number }[] = [];
    for (let t = 0; t < tasks; t++) {
      let best = -1; let bestCost = Infinity;
      for (let a = 0; a < agents; a++) {
        if (assigned.has(a)) continue;
        if (costs[t]![a]! < bestCost) { bestCost = costs[t]![a]!; best = a; }
      }
      if (best === -1) break;
      assigned.add(best);
      assignments.push({ task: t, agent: best, cost: bestCost });
    }
    return { assignments, totalCost: assignments.reduce((s, a) => s + a.cost, 0) };
  }

  /** Earliest-deadline-first scheduling across multiple machines. */
  schedule(input: ScheduleInput): ScheduleResult {
    const jobs = [...input.jobs].sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity));
    const machineEnd = new Array(input.machines).fill(0);
    const schedule: { job: number; start: number; end: number; machine: number }[] = [];
    for (const job of jobs) {
      // Pick the machine that finishes earliest.
      let m = 0; for (let i = 1; i < input.machines; i++) if (machineEnd[i]! < machineEnd[m]!) m = i;
      const start = machineEnd[m]!;
      const end = start + job.duration;
      schedule.push({ job: job.id, start, end, machine: m });
      machineEnd[m] = end;
    }
    return { schedule, makespan: Math.max(...machineEnd) };
  }

  /** 0/1 Knapsack via dynamic programming. */
  knapsack(input: KnapsackInput): KnapsackResult {
    const { items, capacity } = input;
    const n = items.length;
    if (n === 0 || capacity <= 0) return { items: [], totalValue: 0, totalWeight: 0 };
    // DP table.
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(capacity + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let w = 0; w <= capacity; w++) {
        dp[i]![w] = dp[i - 1]![w]!;
        if (items[i - 1]!.weight <= w) {
          dp[i]![w] = Math.max(dp[i]![w]!, dp[i - 1]![w - items[i - 1]!.weight]! + items[i - 1]!.value);
        }
      }
    }
    // Backtrack to find selected items.
    const selected: number[] = [];
    let w = capacity;
    for (let i = n; i > 0; i--) {
      if (dp[i]![w]! !== dp[i - 1]![w]!) {
        selected.push(items[i - 1]!.id);
        w -= items[i - 1]!.weight;
      }
    }
    const totalValue = dp[n]![capacity]!;
    const totalWeight = selected.reduce((s, id) => s + items.find((i) => i.id === id)!.weight, 0);
    return { items: selected, totalValue, totalWeight };
  }

  /** TSP nearest-neighbor heuristic. Returns the route (ordered point IDs) and total distance. */
  tsp(input: TSPInput): { route: number[]; distance: number } {
    const { points } = input;
    if (points.length === 0) return { route: [], distance: 0 };
    if (points.length === 1) return { route: [points[0]!.id], distance: 0 };
    const visited = new Set<number>();
    const route: number[] = [points[0]!.id];
    visited.add(points[0]!.id);
    let totalDist = 0;
    let current = points[0]!;
    for (let step = 1; step < points.length; step++) {
      let nearest: typeof current | undefined; let minDist = Infinity;
      for (const p of points) {
        if (visited.has(p.id)) continue;
        const d = Math.hypot(p.x - current.x, p.y - current.y);
        if (d < minDist) { minDist = d; nearest = p; }
      }
      if (!nearest) break;
      totalDist += minDist;
      route.push(nearest.id);
      visited.add(nearest.id);
      current = nearest;
    }
    // Return to start.
    totalDist += Math.hypot(current.x - points[0]!.x, current.y - points[0]!.y);
    return { route, distance: Math.round(totalDist * 100) / 100 };
  }
}
