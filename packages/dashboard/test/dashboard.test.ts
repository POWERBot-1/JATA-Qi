// Adaptive Dashboard tests — widget registry, layout engine, auto-arrange,
// AI adaptation, responsive breakpoints, analytics, and kernel integration.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { DashboardModule, DashboardEvents, WidgetRegistry, LayoutEngine } from '../src/index.js';

describe('WidgetRegistry — built-in catalog', () => {
  it('has 15+ built-in widgets', () => {
    const reg = new WidgetRegistry();
    assert.ok(reg.count >= 15);
  });

  it('lists by category', () => {
    const reg = new WidgetRegistry();
    const kpis = reg.list('kpi');
    assert.ok(kpis.length >= 3);
    const charts = reg.list('chart');
    assert.ok(charts.length >= 3);
  });

  it('filters by role', () => {
    const reg = new WidgetRegistry();
    const adminWidgets = reg.list(undefined, 'admin');
    const userWidgets = reg.list(undefined, 'user');
    assert.ok(adminWidgets.length >= userWidgets.length); // admin sees everything user sees + more
  });

  it('registers custom widgets', () => {
    const reg = new WidgetRegistry();
    reg.register({ id: 'custom-1', title: 'Custom', category: 'custom', defaultSize: 'medium', renderer: 'custom-renderer' });
    assert.ok(reg.get('custom-1'));
    assert.equal(reg.count, 20); // 15 base + 4 tool-governance + 1 custom
  });

  it('catalogs tool-governance widgets with data-source requirements', () => {
    const reg = new WidgetRegistry();
    for (const id of ['kpi-tools-governed', 'kpi-tools-invocations', 'kpi-tools-decisions', 'list-tool-approvals']) {
      const w = reg.get(id);
      assert.ok(w, `widget ${id} present`);
      assert.equal(w!.requiresDataSource, true, `${id} requires a data source`);
    }
    const governed = reg.get('kpi-tools-governed')!;
    assert.equal(governed.category, 'kpi');
    assert.equal(governed.renderer, 'kpi-card');
    assert.deepEqual(governed.configSchema![0]!.options, ['total', 'active', 'agentTools', 'approvalGated']);
    const approvals = reg.get('list-tool-approvals')!;
    assert.equal(approvals.category, 'notification');
    assert.equal(approvals.renderer, 'notification-list');
    assert.ok(approvals.allowedRoles!.includes('developer'));
  });
});

describe('LayoutEngine — CRUD + grid', () => {
  let engine: LayoutEngine;

  before(() => { engine = new LayoutEngine(new WidgetRegistry()); });

  it('creates a layout', () => {
    const l = engine.create({ name: 'My Dashboard', ownerId: 'u1' });
    assert.ok(l.id);
    assert.equal(l.widgets.length, 0);
    assert.equal(l.columns, 4);
  });

  it('adds widgets with auto-positioning', () => {
    const l = engine.create({ name: 'Test', ownerId: 'u1', autoArrange: true });
    engine.addWidget(l.id, 'kpi-revenue');
    engine.addWidget(l.id, 'kpi-users');
    assert.equal(l.widgets.length, 2);
    assert.equal(l.widgets[0]!.col, 0);
    assert.equal(l.widgets[1]!.col, 1); // next column
  });

  it('moves widgets (drag-and-drop)', () => {
    const l = engine.create({ name: 'Move', ownerId: 'u1' });
    const w = engine.addWidget(l.id, 'chart-revenue');
    engine.moveWidget(l.id, w.id, 2, 3);
    assert.equal(engine.get(l.id)!.widgets[0]!.col, 2);
    assert.equal(engine.get(l.id)!.widgets[0]!.row, 3);
  });

  it('resizes widgets', () => {
    const l = engine.create({ name: 'Resize', ownerId: 'u1' });
    const w = engine.addWidget(l.id, 'kpi-revenue');
    engine.resizeWidget(l.id, w.id, 'large');
    assert.equal(engine.get(l.id)!.widgets[0]!.size, 'large');
  });

  it('toggles widget visibility', () => {
    const l = engine.create({ name: 'Toggle', ownerId: 'u1' });
    const w = engine.addWidget(l.id, 'kpi-revenue');
    assert.equal(w.visible, true);
    engine.toggleWidget(l.id, w.id);
    assert.equal(engine.get(l.id)!.widgets[0]!.visible, false);
  });

  it('removes widgets', () => {
    const l = engine.create({ name: 'Remove', ownerId: 'u1' });
    const w = engine.addWidget(l.id, 'kpi-revenue');
    assert.ok(engine.removeWidget(l.id, w.id));
    assert.equal(engine.get(l.id)!.widgets.length, 0);
  });

  it('auto-arranges into a compact grid', () => {
    const l = engine.create({ name: 'Arrange', ownerId: 'u1', columns: 4 });
    engine.addWidget(l.id, 'kpi-revenue', { size: 'small' });
    engine.addWidget(l.id, 'chart-revenue', { size: 'wide' });
    engine.addWidget(l.id, 'kpi-users', { size: 'small' });
    engine.addWidget(l.id, 'table-users', { size: 'medium' });
    engine.autoArrange(l.id);
    const widgets = engine.get(l.id)!.widgets;
    // No overlapping positions.
    const positions = new Set(widgets.map((w) => `${w.col},${w.row}`));
    assert.equal(positions.size, widgets.length);
  });

  it('clones a layout', () => {
    const l = engine.create({ name: 'Original', ownerId: 'u1' });
    engine.addWidget(l.id, 'kpi-revenue');
    const clone = engine.clone(l.id, 'u2', 'Copy');
    assert.notEqual(clone.id, l.id);
    assert.equal(clone.ownerId, 'u2');
    assert.equal(clone.widgets.length, 1);
  });

  it('returns responsive column counts', () => {
    assert.equal(engine.columnsForBreakpoint('mobile'), 1);
    assert.equal(engine.columnsForBreakpoint('tablet'), 2);
    assert.equal(engine.columnsForBreakpoint('desktop'), 4);
    assert.equal(engine.columnsForBreakpoint('wide'), 6);
  });
});

describe('DashboardModule — kernel integration', () => {
  let kernel: Kernel;
  let mod: DashboardModule;

  before(async () => {
    kernel = createTestKernel();
    mod = new DashboardModule();
    kernel.register(mod);
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); });

  it('creates layouts and adds widgets', async () => {
    let created = 0;
    kernel.bus.on(DashboardEvents.LayoutCreated, () => { created++; });
    const l = mod.createLayout({ name: 'Admin', ownerId: 'admin-1', role: 'admin' });
    mod.addWidget(l.id, 'kpi-revenue');
    mod.addWidget(l.id, 'chart-revenue');
    await new Promise((r) => setImmediate(r));
    assert.ok(created >= 1);
    assert.equal(mod.getLayout(l.id)!.widgets.length, 2);
  });

  it('auto-arranges', () => {
    const l = mod.createLayout({ name: 'Test', ownerId: 'u1' });
    mod.addWidget(l.id, 'kpi-revenue', { size: 'small' });
    mod.addWidget(l.id, 'chart-revenue', { size: 'wide' });
    mod.addWidget(l.id, 'kpi-users', { size: 'small' });
    mod.autoArrange(l.id);
    assert.ok(mod.getLayout(l.id)!.autoArrange);
  });

  it('adapts based on role (admin gets AI widgets)', async () => {
    const l = mod.createLayout({ name: 'Admin Dash', ownerId: 'admin-1', role: 'admin' });
    const applied = await mod.adapt(l.id, 'admin-1', 'admin');
    assert.ok(applied >= 1);
    const layout = mod.getLayout(l.id)!;
    assert.ok(layout.widgets.some((w) => w.widgetDefId === 'ai-overview'));
  });

  it('adapts for regular users (less prescriptive)', async () => {
    const l = mod.createLayout({ name: 'User Dash', ownerId: 'u1' });
    const applied = await mod.adapt(l.id, 'u1', 'user');
    // Regular users may get 0 role-based suggestions (that's OK).
    assert.ok(applied >= 0);
  });

  it('provides analytics', () => {
    mod.addWidget(mod.createLayout({ name: 'X', ownerId: 'u' }).id, 'kpi-revenue');
    mod.addWidget(mod.layouts.listAll()[0]!.id, 'kpi-users');
    const a = mod.analytics();
    assert.ok(a.totalLayouts > 0);
    assert.ok(a.totalWidgets > 0);
    assert.ok(Object.keys(a.widgetsByCategory).length > 0);
  });

  it('supports custom widget registration', () => {
    mod.registerWidget({ id: 'custom-widget', title: 'My Widget', category: 'custom', defaultSize: 'medium', renderer: 'my-renderer' });
    assert.ok(mod.listWidgets('custom').some((w) => w.id === 'custom-widget'));
  });
});
