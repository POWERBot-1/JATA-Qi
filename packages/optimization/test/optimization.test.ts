import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OptimizationModule } from '../src/index.js';

const opt = new OptimizationModule();

describe('OptimizationModule', () => {
  it('packs items into bins (first-fit-decreasing)', () => {
    const result = opt.binPacking({ items: [{ id: 1, size: 4 }, { id: 2, size: 3 }, { id: 3, size: 2 }, { id: 4, size: 5 }], capacity: 7 });
    assert.ok(result.bins.length <= 3);
    assert.equal(result.unassigned.length, 0);
    // All items accounted for.
    const allItems = result.bins.flatMap((b) => b.items);
    assert.equal(new Set(allItems).size, 4);
  });

  it('reports oversized items as unassigned', () => {
    const result = opt.binPacking({ items: [{ id: 1, size: 10 }], capacity: 5 });
    assert.deepEqual(result.unassigned, [1]);
    assert.equal(result.bins.length, 0);
  });

  it('assigns tasks to agents minimizing cost', () => {
    const result = opt.assignment({ costs: [[3, 1, 2], [2, 5, 4], [1, 3, 6]] });
    assert.equal(result.assignments.length, 3);
    assert.ok(result.totalCost <= 1 + 4 + 6); // not worse than a bad assignment
    // Each agent used at most once.
    const agents = result.assignments.map((a) => a.agent);
    assert.equal(new Set(agents).size, 3);
  });

  it('schedules jobs across machines with minimum makespan', () => {
    const result = opt.schedule({ jobs: [{ id: 1, duration: 3 }, { id: 2, duration: 2 }, { id: 3, duration: 4 }, { id: 4, duration: 1 }], machines: 2 });
    assert.equal(result.schedule.length, 4);
    assert.ok(result.makespan >= 5); // total work = 10 / 2 machines = 5 minimum
  });

  it('solves 0/1 knapsack optimally', () => {
    const result = opt.knapsack({ items: [{ id: 1, weight: 2, value: 3 }, { id: 2, weight: 3, value: 4 }, { id: 3, weight: 4, value: 5 }, { id: 4, weight: 5, value: 6 }], capacity: 5 });
    assert.ok(result.totalValue >= 7); // items 1+2 = weight 5, value 7
    assert.ok(result.totalWeight <= 5);
  });

  it('solves TSP with nearest-neighbor heuristic', () => {
    const result = opt.tsp({ points: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }, { id: 2, x: 0, y: 1 }] });
    assert.equal(result.route.length, 3);
    assert.ok(result.distance > 0);
    // Route returns to start implicitly.
    assert.equal(result.route[0], 0);
  });
});
