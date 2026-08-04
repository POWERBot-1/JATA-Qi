// DashboardModule — kernel module integrating the widget registry, layout
// engine, and AI personalization. Adapts dashboards based on role, behavior
// (via @jataqi/learning), and AI recommendations (via @jataqi/ai-learning).
// Emits bus events for analytics + observability.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { WidgetRegistry } from './widget-registry.js';
import { LayoutEngine } from './layout-engine.js';
import type { Breakpoint, DashboardAnalytics, DashboardLayout, WidgetCategory, WidgetDef, WidgetInstance, WidgetSize, WidgetSuggestion } from './types.js';

export const DashboardEvents = Object.freeze({
  LayoutCreated: 'dashboard.layout.created',
  WidgetAdded: 'dashboard.widget.added',
  WidgetRemoved: 'dashboard.widget.removed',
  AutoArranged: 'dashboard.auto-arranged',
  Adapted: 'dashboard.adapted',
} as const);

export class DashboardModule implements IModule {
  readonly id = 'dashboard';
  readonly tags = ['core', 'ui'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  readonly registry = new WidgetRegistry();
  readonly layouts = new LayoutEngine(this.registry);
  private widgetUsage = new Map<string, number>(); // widgetDefId -> view count

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('dashboard', this);
    kernel.logger.info(`dashboard module initialized (${this.registry.count} built-in widgets)`);
  }
  async start(_kernel: KernelApi): Promise<void> {}
  async stop(_kernel: KernelApi): Promise<void> {}

  // ---- layout management -------------------------------------------------

  createLayout(input: { name: string; ownerId: string; role?: string; orgId?: string }): DashboardLayout {
    const layout = this.layouts.create(input);
    void this.api.bus.emit(DashboardEvents.LayoutCreated, { layoutId: layout.id, ownerId: input.ownerId });
    return layout;
  }

  getLayout(id: string): DashboardLayout | undefined { return this.layouts.get(id); }
  layoutsForUser(ownerId: string): DashboardLayout[] { return this.layouts.listForUser(ownerId); }
  layoutsForOrg(orgId: string): DashboardLayout[] { return this.layouts.listForOrg(orgId); }

  addWidget(layoutId: string, widgetDefId: string, opts?: { size?: WidgetSize; title?: string; config?: Record<string, unknown> }): WidgetInstance {
    const instance = this.layouts.addWidget(layoutId, widgetDefId, opts);
    this.trackUsage(widgetDefId);
    void this.api.bus.emit(DashboardEvents.WidgetAdded, { layoutId, widgetDefId });
    return instance;
  }

  removeWidget(layoutId: string, widgetId: string): boolean {
    const removed = this.layouts.removeWidget(layoutId, widgetId);
    if (removed) void this.api.bus.emit(DashboardEvents.WidgetRemoved, { layoutId, widgetId });
    return removed;
  }

  moveWidget(layoutId: string, widgetId: string, col: number, row: number): void { this.layouts.moveWidget(layoutId, widgetId, col, row); }
  resizeWidget(layoutId: string, widgetId: string, size: WidgetSize): void { this.layouts.resizeWidget(layoutId, widgetId, size); }
  toggleWidget(layoutId: string, widgetId: string): void { this.layouts.toggleWidget(layoutId, widgetId); }
  updateWidgetConfig(layoutId: string, widgetId: string, config: Record<string, unknown>): void { this.layouts.updateWidgetConfig(layoutId, widgetId, config); }

  autoArrange(layoutId: string): void {
    this.layouts.autoArrange(layoutId);
    void this.api.bus.emit(DashboardEvents.AutoArranged, { layoutId });
  }

  cloneLayout(layoutId: string, newOwnerId: string, newName?: string): DashboardLayout { return this.layouts.clone(layoutId, newOwnerId, newName); }
  deleteLayout(layoutId: string): boolean { return this.layouts.delete(layoutId); }

  /** Get the responsive column count for a breakpoint. */
  columnsForBreakpoint(bp: Breakpoint): number { return this.layouts.columnsForBreakpoint(bp); }

  // ---- widgets ------------------------------------------------------------

  listWidgets(category?: WidgetCategory, role?: string): WidgetDef[] { return this.registry.list(category, role); }
  registerWidget(def: WidgetDef): void { this.registry.register(def); }

  // ---- AI personalization -------------------------------------------------

  /**
   * Adapt a dashboard layout based on the user's role and behavior. Uses the
   * learning module (if available) to derive widget suggestions from frequently
   * used features, and applies them to the layout.
   */
  async adapt(layoutId: string, userId: string, role?: string): Promise<number> {
    const suggestions = await this.generateSuggestions(userId, role);
    if (suggestions.length === 0) return 0;
    const applied = this.layouts.applySuggestions(layoutId, suggestions);
    if (applied > 0) void this.api.bus.emit(DashboardEvents.Adapted, { layoutId, userId, applied });
    return applied;
  }

  /** Generate AI-driven widget suggestions based on role + behavior. */
  private async generateSuggestions(userId: string, role?: string): Promise<WidgetSuggestion[]> {
    const suggestions: WidgetSuggestion[] = [];

    // Role-based defaults.
    if (role === 'admin') {
      suggestions.push({ widgetDefId: 'ai-overview', reason: 'Admin role: AI insights panel', position: { col: 0, row: 0, size: 'wide' }, confidence: 0.9 });
      suggestions.push({ widgetDefId: 'kpi-health', reason: 'Admin role: system health', position: { col: 4, row: 0, size: 'small' }, confidence: 0.8 });
    }
    if (role === 'manager') {
      suggestions.push({ widgetDefId: 'chart-revenue', reason: 'Manager role: revenue trend', confidence: 0.85 });
      suggestions.push({ widgetDefId: 'kpi-revenue', reason: 'Manager role: revenue KPI', confidence: 0.8 });
    }

    // Behavior-based (from learning module if available).
    try {
      const learning = this.api.getModule('learning') as unknown as {
        adapt: (userId: string) => { navOrder: string[]; shortcutSuggestions: Array<{ action: string; frequency: number }> } | undefined;
      };
      const adaptation = learning.adapt(userId);
      if (adaptation) {
        for (const navItem of adaptation.navOrder.slice(0, 3)) {
          const matching = this.registry.list().find((w) => w.title.toLowerCase().includes(navItem.toLowerCase().split(' ')[0] ?? ''));
          if (matching) suggestions.push({ widgetDefId: matching.id, reason: `Frequently used: ${navItem}`, confidence: 0.6 });
        }
      }
    } catch { /* learning module not registered */ }

    return suggestions;
  }

  // ---- analytics ---------------------------------------------------------

  /** Record widget usage (called when a widget is viewed). */
  trackUsage(widgetDefId: string): void {
    this.widgetUsage.set(widgetDefId, (this.widgetUsage.get(widgetDefId) ?? 0) + 1);
  }

  /** Dashboard analytics — layout/widget counts + most-used widgets. */
  analytics(): DashboardAnalytics {
    const allLayouts = this.layouts.listAll();
    const widgetsByCategory: Record<string, number> = {};
    let totalWidgets = 0;
    for (const l of allLayouts) {
      for (const w of l.widgets) {
        totalWidgets++;
        const def = this.registry.get(w.widgetDefId);
        const cat = def?.category ?? 'custom';
        widgetsByCategory[cat] = (widgetsByCategory[cat] ?? 0) + 1;
      }
    }
    const mostUsed = [...this.widgetUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ widgetDefId: id, title: this.registry.get(id)?.title ?? id, count }));
    return {
      totalLayouts: allLayouts.length,
      totalWidgets,
      widgetsByCategory,
      mostUsedWidgets: mostUsed,
      avgWidgetsPerLayout: allLayouts.length > 0 ? totalWidgets / allLayouts.length : 0,
    };
  }

  get widgetCount(): number { return this.registry.count; }
  get layoutCount(): number { return this.layouts.layoutCount; }
}
