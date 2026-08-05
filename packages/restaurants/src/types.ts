// NYUMBANI KITCHEN — Restaurant Intelligence (Phase 7) types.

export interface Venue {
  id: string;
  name: string;
  ownerId: string;
  location?: string;
  cuisine?: string;
  createdAt: number;
}

export type MenuItemCategory = 'appetizer' | 'main' | 'dessert' | 'drink' | 'side';

export interface MenuItem {
  id: string;
  venueId: string;
  name: string;
  category: MenuItemCategory;
  /** Price in minor units. */
  price: number;
  available: boolean;
  createdAt: number;
}

export interface Table {
  id: string;
  venueId: string;
  number: string;
  seats: number;
  status: 'free' | 'occupied' | 'reserved';
  createdAt: number;
}

export type OrderStatus = 'open' | 'submitted' | 'served' | 'paid' | 'cancelled';

export interface OrderLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  venueId: string;
  tableId?: string;
  status: OrderStatus;
  lines: OrderLine[];
  /** Total in minor units (computed on submit). */
  total: number;
  createdAt: number;
  updatedAt: number;
}

export interface Ingredient {
  id: string;
  venueId: string;
  name: string;
  /** Stock in grams/units. */
  stock: number;
  /** Reorder threshold. */
  reorderLevel: number;
  createdAt: number;
}

export interface RestaurantStats {
  venues: number;
  menuItems: number;
  tables: number;
  orders: number;
  openOrders: number;
  paidOrders: number;
  cancelledOrders: number;
  revenueMinorUnits: number;
  ingredients: number;
  lowStockIngredients: number;
  avgOrderValueMinorUnits?: number;
}
