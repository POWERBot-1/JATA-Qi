// JATA Qi SDK — typed WebSocket streaming client for the gateway's realtime
// /ws channel.
//
// Protocols supported:
//   - tanya.chat  → tanya.chunk… → tanya.done    (TANYA conversational AI)
//   - qil.run     → qil.step…     → qil.done     (QiL live plan execution)
//   - chat        → chat.chunk…   → chat.done    (unified streaming chat)
//
// The client authenticates with the SDK bearer token, reconnects on transport
// failure (exponential backoff), and resolves on the terminal `done` frame (or
// rejects on `*error` frames). All handlers are optional — a missing handler
// never breaks the stream. Uses the WHATWG WebSocket available in browsers and
// Node 22+ (no external dependencies).

export interface StreamMessage {
  type: string;
  [key: string]: unknown;
}

export interface StreamHandlers {
  /** Called with each word chunk (`*.chunk` frames). */
  onChunk?: (chunk: string) => void;
  /** Called with each `*.step` frame (QiL plan steps). */
  onStep?: (step: Record<string, unknown>, index: number, total: number) => void;
  /** Called with every received frame. */
  onAny?: (msg: StreamMessage) => void;
  /** Called when a terminal `*error` frame arrives. */
  onError?: (error: string) => void;
}

export interface StreamResult {
  type: string;
  [key: string]: unknown;
}

export interface StreamingClientOptions {
  /** baseUrl of the gateway, e.g. 'http://localhost:7400'. */
  baseUrl: string;
  /** Bearer token (also settable via setToken / auth.login). */
  token?: string;
  /** Path of the realtime endpoint (default '/ws'). */
  path?: string;
  /** Max reconnect attempts before rejecting (default 3). */
  maxReconnects?: number;
  /** Reconnect base delay in ms (default 250, doubles each attempt). */
  reconnectBaseMs?: number;
  /** Handshake timeout in ms before the run rejects (default 5000). */
  handshakeTimeoutMs?: number;
}

function isNode(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

/**
 * Streaming client — connect to /ws, send protocol frames, and receive typed
 * events until the terminal frame arrives.
 */
export class StreamingClient {
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly maxReconnects: number;
  private readonly reconnectBaseMs: number;
  private readonly handshakeTimeoutMs: number;
  private token?: string;
  private closed = false;

  constructor(opts: StreamingClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.path = opts.path ?? '/ws';
    this.maxReconnects = opts.maxReconnects ?? 3;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 250;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;
    this.token = opts.token;
  }

  setToken(token: string): void { this.token = token; }
  getToken(): string | undefined { return this.token; }

  /** ws(s) URL with the auth token. */
  url(): string {
    const u = new URL(this.baseUrl);
    const proto = u.protocol === 'https:' ? 'wss' : 'ws';
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    return `${proto}://${u.host}${this.path}${query}`;
  }

  /**
   * Run a streaming protocol exchange.
   *
   * @param frame     initial frame to send (e.g. `{ type: 'qil.run', source }`)
   * @param doneType  terminal frame type that resolves the promise
   * @param handlers  optional chunk/step/any/error handlers
   * @returns the terminal frame payload
   */
  run<T extends StreamResult = StreamResult>(
    frame: Record<string, unknown>,
    doneType: string,
    handlers: StreamHandlers = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let attempt = 0;
      let ws: WebSocket | null = null;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        try { ws?.close(); } catch { /* ignore */ }
        reject(err);
      };

      const onMessage = (data: string): void => {
        let msg: StreamMessage;
        try { msg = JSON.parse(data) as StreamMessage; } catch { return; }
        handlers.onAny?.(msg);
        if (msg.type === doneType) {
          if (!settled) { settled = true; try { ws?.close(); } catch { /* ignore */ } resolve(msg as T); }
          return;
        }
        if (msg.type.endsWith('.error') || msg.type === 'chat.error') {
          const errText = typeof msg.error === 'string' ? msg.error : `stream error (${msg.type})`;
          handlers.onError?.(errText);
          fail(new Error(errText));
          return;
        }
        if (msg.type.endsWith('.chunk') && typeof msg.content === 'string') handlers.onChunk?.(msg.content);
        if (msg.type.endsWith('.step')) {
          handlers.onStep?.(
            (msg.step as Record<string, unknown>) ?? {},
            Number(msg.index ?? 0),
            Number(msg.total ?? 0),
          );
        }
      };

      const connect = (): void => {
        if (this.closed || settled) return;
        let opened = false;
        let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          ws = new WebSocket(this.url());
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        // Some stacks (undici) never fire error/close when the handshake is
        // rejected (e.g. 401 without a token) — guard with a watchdog.
        handshakeTimer = setTimeout(() => {
          if (!opened && !settled) fail(new Error('websocket handshake timed out'));
        }, this.handshakeTimeoutMs);
        ws.onopen = () => {
          opened = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          attempt = 0;
          try { ws?.send(JSON.stringify(frame)); } catch (e) { fail(new Error(`ws send failed: ${(e as Error).message}`)); }
        };
        ws.onmessage = (ev) => onMessage(String(ev.data));
        ws.onclose = () => {
          if (handshakeTimer) clearTimeout(handshakeTimer);
          if (settled || this.closed) return;
          attempt++;
          if (attempt > this.maxReconnects) {
            fail(new Error('websocket closed before stream completed'));
            return;
          }
          const delay = this.reconnectBaseMs * 2 ** (attempt - 1);
          setTimeout(connect, delay);
        };
        ws.onerror = () => {
          if (!opened && !settled) fail(new Error('websocket connection failed'));
          /* after the handshake, onclose drives reconnects */
        };
      };

      connect();
    });
  }

  /** TANYA conversational streaming — tanya.chunk… → tanya.done. */
  tanyaChat(message: string, opts: { persona?: string; conversationId?: string; orgId?: string; modelRouting?: boolean } & StreamHandlers = {}): Promise<StreamResult> {
    const { persona, conversationId, orgId, modelRouting, ...handlers } = opts;
    return this.run({
      type: 'tanya.chat',
      message,
      ...(persona ? { persona } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(modelRouting ? { modelRouting: true } : {}),
    }, 'tanya.done', handlers);
  }

  /** QiL live plan execution — qil.step… → qil.done. */
  qilRun(source: string, handlers: StreamHandlers = {}): Promise<StreamResult> {
    return this.run({ type: 'qil.run', source }, 'qil.done', handlers);
  }

  /** QiL objective (natural language) — compiled to a retrieve→reason→report plan. */
  qilObjective(objective: string, handlers: StreamHandlers = {}): Promise<StreamResult> {
    return this.run({ type: 'qil.run', objective }, 'qil.done', handlers);
  }

  /** Unified chat streaming — chat.chunk… → chat.done. */
  chat(message: string, opts: { conversationId?: string } & StreamHandlers = {}): Promise<StreamResult> {
    const { conversationId, ...handlers } = opts;
    return this.run({ type: 'chat', message, ...(conversationId ? { conversationId } : {}) }, 'chat.done', handlers);
  }

  /**
   * Subscribe to platform bus events broadcast over /ws (security, workflow,
   * memory, tool governance, ...). Returns an unsubscribe function.
   *
   * Topics match by exact name or prefix — e.g. 'security' receives
   * security.user.login, security.user.logout, security.auth.denied.
   */
  subscribe(topics: string | string[], handler: (event: { type: string; data: unknown; ts: number }) => void): () => void {
    const list = Array.isArray(topics) ? topics : [topics];
    const ws = new WebSocket(this.url());
    let closed = false;
    const send = (): void => {
      try { ws.send(JSON.stringify({ op: 'subscribe', topics: list })); } catch { /* socket may be mid-close */ }
    };
    ws.onopen = send;
    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: unknown; ts?: number };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg.type || msg.type === 'realtime.connected') return;
      handler({ type: msg.type, data: msg.data, ts: msg.ts ?? Date.now() });
    };
    const unsubscribe = (): void => {
      if (closed) return;
      closed = true;
      try { ws.send(JSON.stringify({ op: 'unsubscribe', topics: list })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    };
    return unsubscribe;
  }

  close(): void { this.closed = true; }
}
