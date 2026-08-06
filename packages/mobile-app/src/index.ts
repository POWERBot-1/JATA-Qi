// @jataqi/mobile-app — TANYA Mobile Reference App. Public API.
//
// A platform-neutral controller that wires the SDK's mobile surface into the
// exact flows a native TANYA app needs: auth persistence, device lifecycle,
// home snapshot, streaming chat, offline outbox, live push feed, and silent
// session rotation. The Expo reference app in examples/react-native-app/ layers
// screens on top of this controller.

export { MobileAppController, PUSH_FEED_TOPICS } from './controller.js';
export type {
  MobileAppOptions,
  DeviceInfo,
  HomeState,
  SessionStatus,
  StreamChatOptions,
  StreamChatResult,
  PushEvent,
  SyncSummary,
} from './controller.js';
export { MemoryStorage, JsonFileStorage } from './storage.js';
export type { MobileAppStorage } from './storage.js';
export { OutboxQueue } from './outbox.js';
export type { OutboxMessage, OutboxEnqueueInput, OutboxSyncResult } from './outbox.js';
export { JataQiError } from '@jataqi/sdk';
