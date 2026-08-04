// JATA Qi Supply Chain — types (#22). Suppliers, inventory, purchase orders, deliveries.

export type SupplierStatus = 'active' | 'inactive' | 'blacklisted';
export type OrderStatus = 'draft' | 'submitted' | 'approved' | 'delivered' | 'cancelled';
export type DeliveryStatus = 'pending' | 'in_transit' | 'delivered' | 'failed';

export interface Supplier {
  id: string;
  name: string;
  category?: string;
  contactEmail?: string;
  rating?: number;
  status: SupplierStatus;
  organizationId?: string;
  createdAt: number;
}

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  reorderLevel: number;
  unitCost?: number;
  supplierId?: string;
  organizationId?: string;
  updatedAt: number;
}

export interface OrderLine { sku: string; name: string; quantity: number; unitCost: number; }

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  lines: OrderLine[];
  total: number;
  currency: string;
  status: OrderStatus;
  createdBy: string;
  organizationId?: string;
  createdAt: number;
  approvedAt?: number;
}

export interface Delivery {
  id: string;
  orderId: string;
  status: DeliveryStatus;
  estimatedArrival?: number;
  actualArrival?: number;
  trackingRef?: string;
  createdAt: number;
}

export const SupplyChainEvents = Object.freeze({
  LowStock: 'supply.low_stock',
  OrderApproved: 'supply.order.approved',
  DeliveryCompleted: 'supply.delivery.completed',
} as const);
