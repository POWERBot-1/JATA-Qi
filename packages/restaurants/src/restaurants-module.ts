// RestaurantsModule — NYUMBANI KITCHEN kernel module. Wraps the engine,
// emits bus events, and records orders into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { RestaurantEngine, type AddMenuItemInput, type CreateOrderInput, type RegisterVenueInput } from './engine.js';
import type {
  Ingredient, MenuItem, MenuItemCategory, Order, OrderStatus, RestaurantStats,
  Table, Venue,
} from './types.js';

export const RestaurantEvents = Object.freeze({
  VenueRegistered: 'restaurants.venue.registered',
  MenuItemAdded: 'restaurants.menu_item.added',
  OrderCreated: 'restaurants.order.created',
  OrderSubmitted: 'restaurants.order.submitted',
  OrderPaid: 'restaurants.order.paid',
  LowStock: 'restaurants.low_stock',
} as const);

export class RestaurantsModule implements IModule {
  readonly id = 'restaurants';
  readonly tags = ['core', 'restaurants', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new RestaurantEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('restaurants', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('restaurants module initialized (NYUMBANI KITCHEN)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerVenue(input: RegisterVenueInput): Venue {
    const venue = this.engine.registerVenue(input);
    void this.api.bus.emit(RestaurantEvents.VenueRegistered, { id: venue.id, name: venue.name });
    return venue;
  }
  listVenues(ownerId?: string): Venue[] { return this.engine.listVenues(ownerId); }

  addMenuItem(input: AddMenuItemInput): MenuItem {
    const item = this.engine.addMenuItem(input);
    void this.api.bus.emit(RestaurantEvents.MenuItemAdded, { id: item.id, venueId: item.venueId, name: item.name });
    return item;
  }
  listMenu(venueId: string, category?: MenuItemCategory): MenuItem[] { return this.engine.listMenu(venueId, category); }
  setMenuItemAvailable(id: string, available: boolean): MenuItem | undefined {
    return this.engine.setMenuItemAvailable(id, available);
  }

  addTable(input: { venueId: string; number: string; seats?: number }): Table { return this.engine.addTable(input); }
  listTables(venueId: string, status?: Table['status']): Table[] { return this.engine.listTables(venueId, status); }
  setTableStatus(id: string, status: Table['status']): Table | undefined { return this.engine.setTableStatus(id, status); }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const order = this.engine.createOrder(input);
    void this.api.bus.emit(RestaurantEvents.OrderCreated, { id: order.id, venueId: order.venueId, lines: order.lines.length });
    await this.recordMemory('restaurant_order', `order ${order.id} opened (${order.lines.length} lines)`, {
      orderId: order.id, venueId: order.venueId, lines: order.lines.length,
    });
    return order;
  }
  listOrders(filter?: { venueId?: string; status?: OrderStatus }): Order[] { return this.engine.listOrders(filter); }

  async submitOrder(id: string): Promise<Order | undefined> {
    const order = this.engine.submitOrder(id);
    if (order) {
      void this.api.bus.emit(RestaurantEvents.OrderSubmitted, { id: order.id, total: order.total });
      await this.recordMemory('restaurant_order', `order ${order.id} submitted — ${order.total} minor units`, {
        orderId: order.id, total: order.total,
      });
    }
    return order;
  }

  async updateOrderStatus(id: string, status: OrderStatus): Promise<Order | undefined> {
    const order = this.engine.updateOrderStatus(id, status);
    if (order && status === 'paid') {
      void this.api.bus.emit(RestaurantEvents.OrderPaid, { id: order.id, total: order.total });
      await this.recordMemory('restaurant_order', `order ${order.id} paid — ${order.total} minor units`, {
        orderId: order.id, total: order.total,
      });
    }
    return order;
  }

  addIngredient(input: { venueId: string; name: string; stock?: number; reorderLevel?: number }): Ingredient {
    return this.engine.addIngredient(input);
  }
  listIngredients(venueId: string): Ingredient[] { return this.engine.listIngredients(venueId); }
  async adjustStock(id: string, delta: number): Promise<Ingredient | undefined> {
    const ingredient = this.engine.adjustStock(id, delta);
    if (ingredient && ingredient.stock <= ingredient.reorderLevel) {
      void this.api.bus.emit(RestaurantEvents.LowStock, { id: ingredient.id, name: ingredient.name, stock: ingredient.stock });
    }
    return ingredient;
  }
  lowStock(venueId: string): Ingredient[] { return this.engine.lowStock(venueId); }

  stats(venueId?: string): RestaurantStats { return this.engine.stats(venueId); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['restaurants', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
