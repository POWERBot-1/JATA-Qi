// @jataqi/restaurants — NYUMBANI KITCHEN Restaurant Intelligence (Phase 7).
// Public API.

export { RestaurantsModule, RestaurantEvents } from './restaurants-module.js';
export { RestaurantEngine } from './engine.js';
export type { RegisterVenueInput, AddMenuItemInput, CreateOrderInput } from './engine.js';
export type {
  Venue, MenuItem, MenuItemCategory, Table, Order, OrderLine, OrderStatus,
  Ingredient, RestaurantStats,
} from './types.js';
