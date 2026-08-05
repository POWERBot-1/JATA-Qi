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
}

interface Client { ws: WebSocket; principal?: PrincipalLike; topics: Set<string> }

const DEFAULT_EVENTS = [
  'security.user.login', 'security.user.logout', 'security.user.registered', 'security.auth.denied',
  'security.session.revoked', 'security.session.expired', 'security.audit.appended',
  'orchestrator.run', 'orchestrator.execution.started', 'orchestrator.step.completed',
  'dr.backup.run', 'readiness.capability.updated',
  'memory.recorded', 'memory.expired', 'memory.purged',
  'tool.registered', 'tool.invoked', 'tool.failed', 'tool.approval.requested', 'tool.approval.decided',
  'tanya.chat.completed',
];

export class RealtimeModule implements IModule {
  readonly id = 'realtime';
  readonly tags = ['core', 'realtime'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private clients = new Set<Client>();
  private cfg: RealtimeConfig = {};
  private unsubs: Array<() => void> = [];

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
    this.api.logger.info(`realtime attached at ${this.cfg.path}`);
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, url: URL): Promise<void> {
    const token = url.searchParams.get('token') ?? this.extractProtocol(req);
    let principal: PrincipalLike | undefined;
    if (this.cfg.authenticate) {
      principal = await this.cfg.authenticate(token ?? undefined);
      if (!principal) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    }
    const ws = upgrade(socket, req.headers['sec-websocket-key'], req.headers['sec-websocket-protocol']?.split(',').map((s) => s.trim()),
      (data) => this.onClientMessage(client, data),
      () => this.clients.delete(client),
    );
    if (!ws) return;
    const client: Client = { ws, topics: new Set(), ...(principal ? { principal } : {}) };
    this.clients.add(client);
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

  private extractProtocol(req: IncomingMessage): string | undefined {
    const p = req.headers['sec-websocket-protocol'];
    if (!p) return undefined;
    return p.split(',').map((s) => s.trim()).find((s) => s.startsWith('bearer.'))?.slice(7);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {
    this.unsubs.forEach((u) => u()); this.unsubs = [];
    this.clients.forEach((c) => c.ws.close(1001, 'shutdown'));
    this.clients.clear();
  }
}
