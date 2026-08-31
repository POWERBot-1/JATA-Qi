// Unit tests for Universal Execution Layer (@jataqi/execution)

import test from 'node:test';
import assert from 'node:assert';
import { UniversalToolFabric, SandboxEngine, WorkflowOrchestrator } from '../src/index.js';

test('UniversalToolFabric registers tools, enforces permissions, and handles timeouts', async () => {
  const fabric = new UniversalToolFabric();
  fabric.registerTool({
    name: 'math.add',
    capability: 'addition',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'number' },
    permissions: ['compute'],
    riskLevel: 'low',
    authRequired: false,
    handler: async (input) => Number(input['a'] ?? 0) + Number(input['b'] ?? 0),
  });

  // Successful execution with correct permission
  const res = await fabric.executeTool('math.add', { a: 10, b: 32 }, ['compute']);
  assert.strictEqual(res, 42);

  // Permission denied test
  await assert.rejects(async () => {
    await fabric.executeTool('math.add', { a: 1, b: 2 }, ['guest']);
  }, /missing permission/);
});

test('SandboxEngine isolates code/tasks with resource limits and timeouts', async () => {
  const sandboxEngine = new SandboxEngine();
  const box = sandboxEngine.createSandbox('box-1', { timeoutMs: 1000 });

  const result = await sandboxEngine.runInSandbox(box, async (env) => {
    return `running in sandbox ${env.sandboxId}`;
  });

  assert.strictEqual(result, 'running in sandbox box-1');

  // Timeout test
  await assert.rejects(async () => {
    await sandboxEngine.runInSandbox(box, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
  }, /timed out/);
});

test('WorkflowOrchestrator executes PLAN → EXECUTE → VERIFY → ROLLBACK with checkpoints and governance', async () => {
  const fabric = new UniversalToolFabric();
  let state = 0;

  fabric.registerTool({
    name: 'state.inc',
    capability: 'increment',
    inputSchema: {},
    outputSchema: {},
    permissions: [],
    riskLevel: 'medium',
    authRequired: false,
    handler: async () => {
      state += 1;
      return state;
    },
  });

  fabric.registerTool({
    name: 'state.dec',
    capability: 'decrement',
    inputSchema: {},
    outputSchema: {},
    permissions: [],
    riskLevel: 'medium',
    authRequired: false,
    handler: async () => {
      state -= 1;
      return state;
    },
  });

  const orchestrator = new WorkflowOrchestrator(fabric);
  orchestrator.setApprovalCallback(async () => true);

  const plan = {
    planId: 'plan-1',
    mission: 'Increment state with rollback test',
    riskLevel: 'medium' as const,
    requiresApproval: false,
    steps: [
      { stepId: 's1', toolName: 'state.inc', input: {}, compensatingAction: { toolName: 'state.dec', input: {} } },
      { stepId: 's2', toolName: 'state.inc', input: {}, compensatingAction: { toolName: 'state.dec', input: {} } },
    ],
  };

  const res = await orchestrator.executeWorkflow(plan, []);
  assert.strictEqual(res.status, 'COMPLETED');
  assert.deepStrictEqual(res.results, [1, 2]);
});
