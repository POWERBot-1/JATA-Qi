// Layout Engine — manages dashboard layouts (create, update, persist, clone),
// handles responsive grid column counts per breakpoint, auto-arranges widgets
// based on size + position, and supports drag-and-drop reordering.

import { randomUUID } from 'node:crypto';
import type { Breakpoint, DashboardLayout, WidgetInstance, WidgetSize, WidgetSuggestion } from './types.js';
import type { WidgetRegistry } from './widget-registry.js';

const COLUMNS_BY_BREAKPOINT: Record<Breakpoint, number> = {
  mobile: 1, tablet: 2, desktop: 4, wide: 6,
};

const SIZE_TO_SPAN: Record<WidgetSize, number> = {
  small: 1, medium: 2, large: 3, wide: 4, tall: 2, full: 6,
};

export class LayoutEngine {
  private layouts = new Map<string, DashboardLayout>();
  private registry: WidgetRegistry;

  constructor(registry: WidgetRegistry) {
    this.registry = registry;
  }

  /** Create a new dashboard layout. */
  create(input: { name: string; ownerId: string; role?: string; orgId?: string; columns?: number; autoArrange?: boolean }): DashboardLayout {
    const layout: DashboardLayout = {
      id: randomUUID(), name: input.name, ownerId: input.ownerId,
      ...(input.role ? { role: input.role } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
      widgets: [], columns: input.columns ?? 4,
      autoArrange: input.autoArrange ?? false,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.layouts.set(layout.id, layout);
    return layout;
  }

  get(id: string): DashboardLayout | undefined { return this.layouts.get(id); }

  /** Get layouts for a user (optionally by role or org). */
  listForUser(ownerId: string): DashboardLayout[] {
    return [...this.layouts.values()].filter((l) => l.ownerId === ownerId);
  }
  listForOrg(orgId: string): DashboardLayout[] {
    return [...this.layouts.values()].filter((l) => l.orgId === orgId);
  }
  listAll(): DashboardLayout[] { return [...this.layouts.values()]; }

  /** Add a widget to a layout. */
  addWidget(layoutId: string, widgetDefId: string, opts?: { size?: WidgetSize; col?: number; row?: number; config?: Record<string, unknown>; title?: string }): WidgetInstance {
    const layout = this.require(layoutId);
    const def = this.registry.get(widgetDefId);
    if (!def) throw new Error(`widget ${widgetDefId} not registered`);
    const size = opts?.size ?? def.defaultSize;
    const { col, row } = opts?.col !== undefined && opts?.row !== undefined ? { col: opts.col, row: opts.row } : this.findFreeSlot(layout, size);
    const instance: WidgetInstance = {
      id: randomUUID(), widgetDefId, title: opts?.title ?? def.title,
      size, col, row, visible: true,
      ...(opts?.config ? { config: opts.config } : {}),
    };
    layout.widgets.push(instance);
    layout.updatedAt = Date.now();
    return instance;
  }

  /** Remove a widget from a layout. */
  removeWidget(layoutId: string, widgetId: string): boolean {
    const layout = this.require(layoutId);
    const before = layout.widgets.length;
    layout.widgets = layout.widgets.filter((w) => w.id !== widgetId);
    const removed = layout.widgets.length !== before;
    if (removed) layout.updatedAt = Date.now();
    return removed;
  }

  /** Move a widget to a new position (drag-and-drop). */
  moveWidget(layoutId: string, widgetId: string, col: number, row: number): void {
    const layout = this.require(layoutId);
    const w = layout.widgets.find((w) => w.id === widgetId);
    if (!w) throw new Error(`widget ${widgetId} not in layout`);
    w.col = col;
    w.row = row;
    layout.updatedAt = Date.now();
  }

  /** Resize a widget. */
  resizeWidget(layoutId: string, widgetId: string, size: WidgetSize): void {
    const layout = this.require(layoutId);
    const w = layout.widgets.find((w) => w.id === widgetId);
    if (!w) throw new Error(`widget ${widgetId} not in layout`);
    w.size = size;
    layout.updatedAt = Date.now();
  }

  /** Toggle widget visibility. */
  toggleWidget(layoutId: string, widgetId: string): void {
    const layout = this.require(layoutId);
    const w = layout.widgets.find((w) => w.id === widgetId);
    if (!w) throw new Error(`widget ${widgetId} not in layout`);
    w.visible = !w.visible;
    layout.updatedAt = Date.now();
  }

  /** Update widget config. */
  updateWidgetConfig(layoutId: string, widgetId: string, config: Record<string, unknown>): void {
    const layout = this.require(layoutId);
    const w = layout.widgets.find((w) => w.id === widgetId);
    if (!w) throw new Error(`widget ${widgetId} not in layout`);
    w.config = { ...w.config, ...config };
    layout.updatedAt = Date.now();
  }

  /** Auto-arrange widgets in a compact grid layout (no overlaps). */
  autoArrange(layoutId: string): void {
    const layout = this.require(layoutId);
    let col = 0, row = 0;
    const sorted = [...layout.widgets].sort((a, b) => SIZE_TO_SPAN[b.size] - SIZE_TO_SPAN[a.size]);
    for (const w of sorted) {
      const span = SIZE_TO_SPAN[w.size] ?? 1;
      if (col + span > layout.columns) { col = 0; row++; }
      w.col = col; w.row = row;
      col += span;
    }
    layout.autoArrange = true;
    layout.updatedAt = Date.now();
  }

  /** Clone a layout (for templates / sharing). */
  clone(layoutId: string, newOwnerId: string, newName?: string): DashboardLayout {
    const src = this.require(layoutId);
    const clone: DashboardLayout = {
      ...src, id: randomUUID(), name: newName ?? `${src.name} (copy)`,
      ownerId: newOwnerId, widgets: src.widgets.map((w) => ({ ...w, id: randomUUID() })),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.layouts.set(clone.id, clone);
    return clone;
  }

  /** Delete a layout. */
  delete(layoutId: string): boolean { return this.layouts.delete(layoutId); }

  /** Get the column count for a breakpoint. */
  columnsForBreakpoint(bp: Breakpoint): number { return COLUMNS_BY_BREAKPOINT[bp]; }

  /** Apply AI suggestions to a layout (add/reposition widgets). */
  applySuggestions(layoutId: string, suggestions: WidgetSuggestion[]): number {
    const layout = this.require(layoutId);
    let applied = 0;
    for (const s of suggestions) {
      const existing = layout.widgets.find((w) => w.widgetDefId === s.widgetDefId);
      if (existing && s.position) {
        existing.col = s.position.col;
        existing.row = s.position.row;
        existing.size = s.position.size;
        applied++;
      } else if (!existing) {
        const def = this.registry.get(s.widgetDefId);
        if (!def) continue;
        this.addWidget(layoutId, s.widgetDefId, {
          ...(s.position ? { col: s.position.col, row: s.position.row, size: s.position.size } : {}),
          title: def.title,
        });
        applied++;
      }
    }
    if (applied > 0) layout.updatedAt = Date.now();
    return applied;
  }

  // ---- internal ----------------------------------------------------------

  private findFreeSlot(layout: DashboardLayout, size: WidgetSize): { col: number; row: number } {
    const span = SIZE_TO_SPAN[size] ?? 1;
    if (layout.autoArrange || layout.widgets.length === 0) {
      // Append to the end of the current row.
      const lastWidget = layout.widgets[layout.widgets.length - 1];
      if (!lastWidget) return { col: 0, row: 0 };
      const lastSpan = SIZE_TO_SPAN[lastWidget.size] ?? 1;
      const nextCol = lastWidget.col + lastSpan;
      if (nextCol + span <= layout.columns) return { col: nextCol, row: lastWidget.row };
      return { col: 0, row: lastWidget.row + 1 };
    }
    return { col: 0, row: 0 };
  }

  private require(id: string): DashboardLayout {
    const l = this.layouts.get(id);
    if (!l) throw new Error(`layout ${id} not found`);
    return l;
  }

  get layoutCount(): number { return this.layouts.size; }
}
