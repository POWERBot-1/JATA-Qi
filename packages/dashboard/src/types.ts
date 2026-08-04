// JATA Qi Adaptive Dashboard — types. A widget-based dashboard engine that
// organizes content into responsive grids, persists layouts per user/role,
// and adapts widget placement based on behavior (via the learning module),
// role, and AI recommendations.

/** Widget size on the grid (1 unit = 1 column). */
export type WidgetSize = 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'full';

/** Widget category for grouping + filtering. */
export type WidgetCategory = 'kpi' | 'chart' | 'table' | 'list' | 'calendar' | 'notification' | 'task' | 'ai' | 'custom';

/** A widget definition — describes what a widget renders + its config schema. */
export interface WidgetDef {
  id: string;
  title: string;
  category: WidgetCategory;
  defaultSize: WidgetSize;
  /** Minimum size the widget can be resized to. */
  minSize?: WidgetSize;
  /** Config properties the widget accepts. */
  configSchema?: Array<{ key: string; type: 'string' | 'number' | 'boolean' | 'select'; label: string; options?: string[]; default?: unknown }>;
  /** Roles allowed to see this widget. Empty = all roles. */
  allowedRoles?: string[];
  /** Whether this widget requires a data source. */
  requiresDataSource?: boolean;
  /** The render function key (the client-side renderer maps this to a component). */
  renderer: string;
}

/** A placed widget instance on a dashboard. */
export interface WidgetInstance {
  id: string;
  widgetDefId: string;
  title: string;
  size: WidgetSize;
  /** Grid position (column, row) — 0-indexed. */
  col: number;
  row: number;
  /** Config values for this instance. */
  config?: Record<string, unknown>;
  /** Whether the widget is visible. */
  visible: boolean;
}

/** A dashboard layout — a named arrangement of widgets. */
export interface DashboardLayout {
  id: string;
  name: string;
  ownerId: string;
  role?: string;
  orgId?: string;
  widgets: WidgetInstance[];
  /** Number of grid columns (responsive). */
  columns: number;
  /** Whether this layout is auto-arranged by the AI. */
  autoArrange: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Grid breakpoint for responsive layouts. */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

/** AI suggestion for widget placement. */
export interface WidgetSuggestion {
  widgetDefId: string;
  reason: string;
  position?: { col: number; row: number; size: WidgetSize };
  confidence: number;
}

/** Dashboard analytics — widget usage metrics. */
export interface DashboardAnalytics {
  totalLayouts: number;
  totalWidgets: number;
  widgetsByCategory: Record<string, number>;
  mostUsedWidgets: Array<{ widgetDefId: string; title: string; count: number }>;
  avgWidgetsPerLayout: number;
}
