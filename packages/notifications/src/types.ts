// JATA Qi Notifications — types.

export type Priority = 'low' | 'normal' | 'high' | 'critical';

export type ChannelType = 'inapp' | 'webhook' | 'email' | 'sms' | 'push';

export interface NotificationPayload {
  type: string;
  title: string;
  body?: string;
  priority?: Priority;
  data?: Record<string, unknown>;
}

export interface Notification {
  id: string;
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  priority: Priority;
  data?: Record<string, unknown>;
  channels: string[]; // channels attempted
  read: boolean;
  createdAt: number;
}

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/** A delivery adapter. In-app is built-in; webhook/email/sms are pluggable. */
export interface NotificationChannel {
  readonly id: string;
  readonly type: ChannelType;
  send(notification: Notification): Promise<DeliveryResult>;
}

/** Per-recipient preferences by notification type. */
export interface PreferenceEntry {
  enabled: boolean;
  channels: string[]; // channel ids
}
export type Preferences = Record<string, PreferenceEntry>; // type -> entry

export const NotificationEvents = Object.freeze({
  NotificationCreated: 'notification.created',
  DeliveryFailed: 'notification.delivery.failed',
} as const);
