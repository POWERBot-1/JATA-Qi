// Widget Registry — manages widget definitions. Widgets are registered with
// their metadata (title, category, size, config schema, role permissions) and
// can be queried by category, role, or data-source requirements.

import type { WidgetCategory, WidgetDef } from './types.js';

/** Built-in widget definitions — the default catalog. */
const BUILTIN_WIDGETS: WidgetDef[] = [
  { id: 'kpi-revenue', title: 'Revenue', category: 'kpi', defaultSize: 'small', renderer: 'kpi-card', configSchema: [{ key: 'metric', type: 'select', label: 'Metric', options: ['revenue', 'mrr', 'arr', 'arpu'], default: 'revenue' }] },
  { id: 'kpi-users', title: 'Active Users', category: 'kpi', defaultSize: 'small', renderer: 'kpi-card', configSchema: [{ key: 'period', type: 'select', label: 'Period', options: ['today', '7d', '30d'], default: '7d' }] },
  { id: 'kpi-ai-usage', title: 'AI Requests', category: 'kpi', defaultSize: 'small', renderer: 'kpi-card', configSchema: [{ key: 'model', type: 'string', label: 'Model filter', default: 'all' }] },
  { id: 'chart-revenue', title: 'Revenue Trend', category: 'chart', defaultSize: 'wide', renderer: 'line-chart', configSchema: [{ key: 'range', type: 'select', label: 'Range', options: ['7d', '30d', '90d', '1y'], default: '30d' }] },
  { id: 'chart-funnel', title: 'Conversion Funnel', category: 'chart', defaultSize: 'medium', renderer: 'funnel-chart' },
  { id: 'chart-cohort', title: 'Retention Cohort', category: 'chart', defaultSize: 'large', renderer: 'heatmap-chart' },
  { id: 'table-users', title: 'Recent Users', category: 'table', defaultSize: 'medium', renderer: 'data-table', configSchema: [{ key: 'limit', type: 'number', label: 'Rows', default: 10 }] },
  { id: 'table-transactions', title: 'Transactions', category: 'table', defaultSize: 'medium', renderer: 'data-table' },
  { id: 'list-notifications', title: 'Notifications', category: 'notification', defaultSize: 'small', renderer: 'notification-list' },
  { id: 'list-tasks', title: 'Tasks', category: 'task', defaultSize: 'small', renderer: 'task-list' },
  { id: 'calendar-upcoming', title: 'Calendar', category: 'calendar', defaultSize: 'medium', renderer: 'mini-calendar' },
  { id: 'ai-recommendations', title: 'AI Recommendations', category: 'ai', defaultSize: 'medium', renderer: 'ai-suggestion-list', allowedRoles: ['admin', 'manager'] },
  { id: 'ai-overview', title: 'AI Overview', category: 'ai', defaultSize: 'wide', renderer: 'ai-insight-panel', allowedRoles: ['admin', 'manager'] },
  { id: 'kpi-health', title: 'System Health', category: 'kpi', defaultSize: 'small', renderer: 'health-gauge' },
  { id: 'chart-performance', title: 'Performance', category: 'chart', defaultSize: 'medium', renderer: 'area-chart' },
  // Tool-governance widgets (powered by the tool-intelligence governanceStats endpoint).
  { id: 'kpi-tools-governed', title: 'Governed Tools', category: 'kpi', defaultSize: 'small', renderer: 'kpi-card', requiresDataSource: true, configSchema: [{ key: 'metric', type: 'select', label: 'Metric', options: ['total', 'active', 'agentTools', 'approvalGated'], default: 'total' }] },
  { id: 'kpi-tools-invocations', title: 'Tool Invocations', category: 'kpi', defaultSize: 'small', renderer: 'kpi-card', requiresDataSource: true, configSchema: [{ key: 'metric', type: 'select', label: 'Metric', options: ['total', 'success', 'denied', 'pending_approval'], default: 'total' }] },
  { id: 'kpi-tools-decisions', title: 'Governance Decisions', category: 'kpi', defaultSize: 'small', renderer: 'kpi-card', requiresDataSource: true, configSchema: [{ key: 'metric', type: 'select', label: 'Metric', options: ['ALLOW', 'DENY', 'REQUIRES_APPROVAL'], default: 'ALLOW' }] },
  { id: 'list-tool-approvals', title: 'Pending Tool Approvals', category: 'notification', defaultSize: 'medium', renderer: 'notification-list', requiresDataSource: true, allowedRoles: ['admin', 'manager', 'developer'] },
];

export class WidgetRegistry {
  private widgets = new Map<string, WidgetDef>();

  constructor(registerBuiltins = true) {
    if (registerBuiltins) for (const w of BUILTIN_WIDGETS) this.widgets.set(w.id, w);
  }

  register(def: WidgetDef): void { this.widgets.set(def.id, def); }
  unregister(id: string): boolean { return this.widgets.delete(id); }
  get(id: string): WidgetDef | undefined { return this.widgets.get(id); }
  list(category?: WidgetCategory, role?: string): WidgetDef[] {
    return [...this.widgets.values()].filter((w) =>
      (!category || w.category === category) &&
      (!role || !w.allowedRoles || w.allowedRoles.length === 0 || w.allowedRoles.includes(role)));
  }
  get count(): number { return this.widgets.size; }
}
