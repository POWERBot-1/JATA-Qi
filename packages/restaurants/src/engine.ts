// RestaurantEngine — NYUMBANI KITCHEN core: venues, menus, tables, orders
// with kitchen-ticket flow, ingredient inventory with reorder alerts, and
// revenue analytics. Pure engine.

import { randomUUID } from 'node:crypto';
import type {
  Ingredient, MenuItem, MenuItemCategory, Order, OrderLine, OrderStatus,
  RestaurantStats, Table, Venue,
} from './types.js';

export interface RegisterVenueInput {
  name: string;
  ownerId: string;
  location?: string;
  cuisine?: string;
}

export interface AddMenuItemInput {
  venueId: string;
  name: string;
  category?: MenuItemCategory;
  price: number;
}

export interface CreateOrderInput {
  venueId: string;
  tableId?: string;
  lines: Array<{ menuItemId: string; quantity: number }>;
}

export class RestaurantEngine {
  private venues = new Map<string, Venue>();
  private menu = new Map<string, MenuItem>();
  private tables = new Map<string, Table>();
  private orders = new Map<string, Order>();
  private ingredients = new Map<string, Ingredient>();

  // ---- venues ------------------------------------------------------------

  registerVenue(input: RegisterVenueInput): Venue {
    if (!input.name || !input.ownerId) throw new Error('name and ownerId are required');
    const venue: Venue = {
      id: randomUUID(), name: input.name, ownerId: input.ownerId,
      ...(input.location ? { location: input.location } : {}),
      ...(input.cuisine ? { cuisine: input.cuisine } : {}),
      createdAt: Date.now(),
    };
    this.venues.set(venue.id, venue);
    return venue;
  }

  getVenue(id: string): Venue | undefined { return this.venues.get(id); }
  listVenues(ownerId?: string): Venue[] {
    const all = [...this.venues.values()];
    return ownerId ? all.filter((v) => v.ownerId === ownerId) : all;
  }

  // ---- menu --------------------------------------------------------------

  addMenuItem(input: AddMenuItemInput): MenuItem {
    if (!this.venues.has(input.venueId)) throw new Error(`unknown venue ${input.venueId}`);
    if (!input.name || input.price < 0) throw new Error('valid name and price are required');
    const item: MenuItem = {
      id: randomUUID(), venueId: input.venueId, name: input.name,
      category: input.category ?? 'main', price: input.price, available: true,
      createdAt: Date.now(),
    };
    this.menu.set(item.id, item);
    return item;
  }

  getMenuItem(id: string): MenuItem | undefined { return this.menu.get(id); }
  listMenu(venueId: string, category?: MenuItemCategory): MenuItem[] {
    return [...this.menu.values()].filter((m) =>
      m.venueId === venueId && (!category || m.category === category));
  }

  setMenuItemAvailable(id: string, available: boolean): MenuItem | undefined {
    const item = this.menu.get(id);
    if (!item) return undefined;
    item.available = available;
    return item;
  }

  // ---- tables ------------------------------------------------------------

  addTable(input: { venueId: string; number: string; seats?: number }): Table {
    if (!this.venues.has(input.venueId)) throw new Error(`unknown venue ${input.venueId}`);
    if (!input.number) throw new Error('table number is required');
    const table: Table = {
      id: randomUUID(), venueId: input.venueId, number: input.number,
      seats: input.seats ?? 4, status: 'free', createdAt: Date.now(),
    };
    this.tables.set(table.id, table);
    return table;
  }

  listTables(venueId: string, status?: Table['status']): Table[] {
    return [...this.tables.values()].filter((t) =>
      t.venueId === venueId && (!status || t.status === status));
  }

  setTableStatus(id: string, status: Table['status']): Table | undefined {
    const table = this.tables.get(id);
    if (!table) return undefined;
    table.status = status;
    return table;
  }

  // ---- orders ------------------------------------------------------------

  createOrder(input: CreateOrderInput): Order {
    if (!this.venues.has(input.venueId)) throw new Error(`unknown venue ${input.venueId}`);
    if (input.lines.length === 0) throw new Error('order requires at least one line');
    const lines: OrderLine[] = [];
    for (const line of input.lines) {
      const item = this.menu.get(line.menuItemId);
      if (!item || item.venueId !== input.venueId) throw new Error(`unknown menu item ${line.menuItemId}`);
      if (!item.available) throw new Error(`menu item "${item.name}" is not available`);
      if (line.quantity <= 0) throw new Error('quantity must be positive');
      lines.push({ menuItemId: item.id, name: item.name, quantity: line.quantity, unitPrice: item.price });
    }
    const now = Date.now();
    const order: Order = {
      id: randomUUID(), venueId: input.venueId,
      ...(input.tableId ? { tableId: input.tableId } : {}),
      status: 'open',
      lines,
      total: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.id, order);
    if (input.tableId) {
      const table = this.tables.get(input.tableId);
      if (table) table.status = 'occupied';
    }
    return order;
  }

  getOrder(id: string): Order | undefined { return this.orders.get(id); }
  listOrders(filter?: { venueId?: string; status?: OrderStatus }): Order[] {
    return [...this.orders.values()].filter((o) =>
      (!filter?.venueId || o.venueId === filter.venueId) &&
      (!filter?.status || o.status === filter.status));
  }

  /** Submit an order to the kitchen: computes the total. */
  submitOrder(id: string): Order | undefined {
    const order = this.orders.get(id);
    if (!order) return undefined;
    if (order.status !== 'open') throw new Error(`order ${id} is ${order.status} (not submittable)`);
    order.total = order.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    order.status = 'submitted';
    order.updatedAt = Date.now();
    return order;
  }

  updateOrderStatus(id: string, status: OrderStatus): Order | undefined {
    const order = this.orders.get(id);
    if (!order) return undefined;
    order.status = status;
    order.updatedAt = Date.now();
    // Free the table when the order is paid or cancelled.
    if ((status === 'paid' || status === 'cancelled') && order.tableId) {
      const table = this.tables.get(order.tableId);
      if (table) table.status = 'free';
    }
    return order;
  }

  // ---- ingredients -------------------------------------------------------

  addIngredient(input: { venueId: string; name: string; stock?: number; reorderLevel?: number }): Ingredient {
    if (!this.venues.has(input.venueId)) throw new Error(`unknown venue ${input.venueId}`);
    if (!input.name) throw new Error('ingredient name is required');
    const ingredient: Ingredient = {
      id: randomUUID(), venueId: input.venueId, name: input.name,
      stock: input.stock ?? 0, reorderLevel: input.reorderLevel ?? 100,
      createdAt: Date.now(),
    };
    this.ingredients.set(ingredient.id, ingredient);
    return ingredient;
  }

  listIngredients(venueId: string): Ingredient[] {
    return [...this.ingredients.values()].filter((i) => i.venueId === venueId);
  }

  adjustStock(id: string, delta: number): Ingredient | undefined {
    const ingredient = this.ingredients.get(id);
    if (!ingredient) return undefined;
    const next = ingredient.stock + delta;
    if (next < 0) throw new Error('stock cannot go negative');
    ingredient.stock = next;
    return ingredient;
  }

  lowStock(venueId: string): Ingredient[] {
    return this.listIngredients(venueId).filter((i) => i.stock <= i.reorderLevel);
  }

  // ---- analytics ---------------------------------------------------------

  stats(venueId?: string): RestaurantStats {
    const venues = venueId ? this.listVenues().filter((v) => v.id === venueId) : this.listVenues();
    const venueIds = new Set(venues.map((v) => v.id));
    const orders = this.listOrders().filter((o) => !venueId || venueIds.has(o.venueId));
    const menuItems = [...this.menu.values()].filter((m) => !venueId || venueIds.has(m.venueId));
    const tables = [...this.tables.values()].filter((t) => !venueId || venueIds.has(t.venueId));
    const ingredients = [...this.ingredients.values()].filter((i) => !venueId || venueIds.has(i.venueId));
    const paid = orders.filter((o) => o.status === 'paid');
    const revenue = paid.reduce((s, o) => s + o.total, 0);
    return {
      venues: venues.length,
      menuItems: menuItems.length,
      tables: tables.length,
      orders: orders.length,
      openOrders: orders.filter((o) => o.status === 'open' || o.status === 'submitted').length,
      paidOrders: paid.length,
      cancelledOrders: orders.filter((o) => o.status === 'cancelled').length,
      revenueMinorUnits: revenue,
      ingredients: ingredients.length,
      lowStockIngredients: ingredients.filter((i) => i.stock <= i.reorderLevel).length,
      ...(paid.length > 0 ? { avgOrderValueMinorUnits: Math.round(revenue / paid.length) } : {}),
    };
  }
}
