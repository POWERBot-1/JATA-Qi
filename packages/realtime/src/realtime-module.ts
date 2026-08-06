// RealtimeModule — kernel module that accepts WebSocket upgrade requests on an
// HTTP server, authenticates clients, and broadcasts real-time events from the
// kernel event bus. Clients can subscribe to event-type prefixes.

import type { Server, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { upgrade } from './ws-handshake.js';
import type { WebSocket } from './websocket.js';

export interface PrincipalLike { userId: string; username: string; roles: string[] }

export interface RealtimeConfig {
  /** URL path for WebSocket upgrades (default '/ws'). */
  path?: string;
  /** Authentication: resolves a bearer token to a principal, or undefined. */
  authenticate?: (token: string | undefined) => Promise<PrincipalLike | undefined>;
  /** Bus event types to auto-broadcast (default curated set). */
  eventTypes?: string[];
  /** Custom message handler — receives parsed client messages + the client's WebSocket for replies. */
  onMessage?: (msg: Record<string, unknown>, ws: { send: (data: string) => void }, principal: PrincipalLike | undefined) => void;
  /** Server keepalive interval in ms — pings clients and prunes silent ones (default 30_000). */
  pingIntervalMs?: number;
  /** Ping timeout in ms — a client silent for this long is pruned (default 3 × pingIntervalMs). */
  pingTimeoutMs?: number;
}

interface Client { ws: WebSocket; principal?: PrincipalLike; topics: Set<string>; lastSeen: number }

const DEFAULT_EVENTS = [
  'security.user.login', 'security.user.logout', 'security.user.registered', 'security.auth.denied',
  'security.session.revoked', 'security.session.expired', 'security.audit.appended',
  'orchestrator.run', 'orchestrator.execution.started', 'orchestrator.step.completed',
  'dr.backup.run', 'readiness.capability.updated',
  'memory.recorded', 'memory.expired', 'memory.purged',
  'tool.registered', 'tool.invoked', 'tool.failed', 'tool.approval.requested', 'tool.approval.decided',
  'tanya.chat.completed',
  // Mobile native: push delivery observability, in-app notifications, and
  // conversation shares — consumed by the reference mobile app's live feed.
  'mobile.push.sent', 'notification.created', 'conversation.shared_to',
  'defense.finding.created', 'defense.containment.started', 'defense.containment.approval.requested',
  'defense.incident.recorded', 'defense.recovery.completed', 'defense.ban.added',
  'soc.incident.opened', 'soc.abuse.alert', 'soc.insider.alert', 'soc.intel.matched', 'soc.hunt.complete',
  'supplychain.dependency.vulnerable', 'supplychain.deployment.mismatch', 'supplychain.integrity.drift',
  'infra.firmware.mismatch', 'infra.config.drift', 'infra.physical.access.denied',
  'resilience.failover.completed', 'resilience.dr.executed', 'resilience.fault.injected',
  'resilience.test.completed', 'resilience.slo.violated',
  'review.scheduled', 'review.completed', 'review.signed_off', 'review.finding.critical',
];

export class RealtimeModule implements IModule {
  readonly id = 'realtime';
  readonly tags = ['core', 'realtime'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private clients = new Set<Client>();
  private cfg: RealtimeConfig = {};
  private unsubs: Array<() => void> = [];
  private keepalive?: ReturnType<typeof setInterval>;
  private connectedAt = 0;
  private totalConnections = 0;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('realtime', this);
  }

  /** Attach to an HTTP server to accept WebSocket upgrades on the configured path. */
  attach(server: Server, cfg: RealtimeConfig = {}): void {
    this.cfg = { path: '/ws', ...cfg };
    server.on('upgrade', (req, socket: Socket, _head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== this.cfg.path) return;
      void this.handleUpgrade(req, socket, url);
    });
    // Auto-broadcast selected bus events to all connected clients.
    for (const ev of cfg.eventTypes ?? DEFAULT_EVENTS) {
      const h = (payload: unknown): void => this.broadcast(ev, payload);
      this.api.bus.on(ev, h);
      this.unsubs.push(() => this.api.bus.off(ev, h));
    }
    // Keepalive: ping every client; prune those silent past the timeout.
    this.connectedAt = Date.now();
    const pingInterval = cfg.pingIntervalMs ?? 30_000;
    const pingTimeout = cfg.pingTimeoutMs ?? pingInterval * 3;
    this.keepalive = setInterval(() => {
      const now = Date.now();
      for (const c of [...this.clients]) {
        if (now - c.lastSeen > pingTimeout) {
          this.clients.delete(c);
          c.ws.close(1001, 'keepalive timeout');
          void this.api.bus.emit('realtime.client.disconnected', { reason: 'keepalive timeout', clientCount: this.clients.size });
          continue;
        }
        c.ws.ping();
      }
    }, pingInterval);
    this.keepalive.unref?.();
    this.api.logger.info(`realtime attached at ${this.cfg.path}`);
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, url: URL): Promise<void> {
    const token = url.searchParams.get('token') ?? this.extractProtocol(req);
    let principal: PrincipalLike | undefined;
    if (this.cfg.authenticate) {
      principal = await this.cfg.authenticate(token ?? undefined);
      if (!principal) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    }
    const client: Client = { ws: undefined as never, topics: new Set(), lastSeen: Date.now(), ...(principal ? { principal } : {}) };
    const ws = upgrade(socket, req.headers['sec-websocket-key'], req.headers['sec-websocket-protocol']?.split(',').map((s) => s.trim()),
      (data) => { client.lastSeen = Date.now(); this.onClientMessage(client, data); },
      () => { this.clients.delete(client); void this.api.bus.emit('realtime.client.disconnected', { clientCount: this.clients.size }); },
      () => { client.lastSeen = Date.now(); },
      () => { client.lastSeen = Date.now(); },
    );
    if (!ws) return;
    client.ws = ws;
    this.clients.add(client);
    this.totalConnections++;
    void this.api.bus.emit('realtime.client.connected', { clientCount: this.clients.size });
    ws.send(JSON.stringify({ type: 'realtime.connected', data: { clientCount: this.clients.size }, ts: Date.now() }));
  }

  private onClientMessage(client: Client, data: string | Buffer): void {
    try {
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      if (msg.op === 'subscribe' && Array.isArray(msg.topics)) msg.topics.forEach((t: string) => client.topics.add(t));
      if (msg.op === 'unsubscribe' && Array.isArray(msg.topics)) msg.topics.forEach((t: string) => client.topics.delete(t));
      // Forward to custom handler (e.g. streaming chat).
      if (this.cfg.onMessage && !msg.op) this.cfg.onMessage(msg, client.ws, client.principal);
    } catch { /* not JSON — ignore */ }
  }

  /** Broadcast a typed event to all connected clients (respecting subscriptions). */
  broadcast(type: string, data: unknown): void {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    for (const c of this.clients) {
      if (c.ws.isClosed) { this.clients.delete(c); continue; }
      if (c.topics.size === 0 || [...c.topics].some((t) => type === t || type.startsWith(t + '.') || type.startsWith(t))) c.ws.send(msg);
    }
  }

  get clientCount(): number { return this.clients.size; }

  /** Realtime observability: connection stats + configuration. */
  stats(): { clients: number; totalConnections: number; connectedAt: number; uptimeMs: number; path: string; pingIntervalMs: number } {
    return {
      clients: this.clients.size,
      totalConnections: this.totalConnections,
      connectedAt: this.connectedAt,
      uptimeMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
      path: this.cfg.path ?? '/ws',
      pingIntervalMs: this.cfg.pingIntervalMs ?? 30_000,
    };
  }

  private extractProtocol(req: IncomingMessage): string | undefined {
    const p = req.headers['sec-websocket-protocol'];
    if (!p) return undefined;
    return p.split(',').map((s) => s.trim()).find((s) => s.startsWith('bearer.'))?.slice(7);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    this.unsubs.forEach((u) => u()); this.unsubs = [];
    this.clients.forEach((c) => c.ws.close(1001, 'shutdown'));
    this.clients.clear();
  }
}
