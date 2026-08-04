// JATA Qi API Gateway — request/response types.

import type { Principal } from '@jataqi/security';

export interface GatewayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  principal?: Principal;
  /** The originating socket address for audit/logging. */
  remoteAddress?: string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
  /** Override the default JSON content type (e.g. for Prometheus text). */
  contentType?: string;
  /** Extra response headers (e.g. rate-limit metadata). */
  headers?: Record<string, string>;
}

export type RouteHandler = (req: GatewayRequest) => Promise<GatewayResponse> | GatewayResponse;

/**
 * TLS/HTTPS configuration (PR4 — Security Hardening). When provided with a
 * certificate + private key, the gateway serves HTTPS with secure defaults
 * (minVersion TLSv1.2, HSTS) instead of plain HTTP.
 */
export interface TlsConfig {
  /** PEM-encoded certificate (use this or {@link TlsConfig.certPath}). */
  cert?: string | Buffer;
  /** PEM-encoded private key (use this or {@link TlsConfig.keyPath}). */
  key?: string | Buffer;
  /** PEM-encoded CA bundle for mutual-TLS / client-cert verification. */
  ca?: string | Buffer;
  /** Filesystem path to a PEM certificate. */
  certPath?: string;
  /** Filesystem path to a PEM private key. */
  keyPath?: string;
  /** Filesystem path to a PEM CA bundle. */
  caPath?: string;
  /** Request a client certificate (mutual TLS). Default false. */
  requestCert?: boolean;
  /** Reject unauthorized client certificates. Default true when requestCert. */
  rejectUnauthorized?: boolean;
  /** Minimum TLS protocol version. Default 'TLSv1.2'. */
  minVersion?: string;
  /** TLS handshake timeout in ms. */
  handshakeTimeout?: number;
}

/**
 * Configurable CORS policy (PR4 — Security Hardening). Replaces the legacy
 * boolean `cors` flag with origin/method/header/credentials control and proper
 * OPTIONS preflight handling.
 */
export interface CorsConfig {
  /**
   * Allowed origins. Use `'*'` for any origin (cannot be combined with
   * `credentials: true`), or an explicit allow-list (origins are reflected).
   * Default: no origins allowed (CORS disabled).
   */
  origins?: string[] | '*';
  /** Allowed methods (default derived from registered routes). */
  methods?: string[];
  /** Allowed request headers (default sensible set). */
  headers?: string[];
  /** Response headers exposed to the browser. */
  exposeHeaders?: string[];
  /** Allow cookies / credentials. Default false. */
  credentials?: boolean;
  /** Preflight cache lifetime in seconds (default 600). */
  maxAge?: number;
}

/** Normalized CORS policy used internally. */
export interface ResolvedCorsPolicy {
  origins: Set<string> | '*';
  methods: string[];
  headers: string[];
  exposeHeaders: string[];
  credentials: boolean;
  maxAge: number;
  enabled: boolean;
}

export interface GatewayOptions {
  /** Max request body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /**
   * CORS policy. `true` enables a permissive policy (legacy behavior),
   * a {@link CorsConfig} enables fine-grained control, `false`/undefined
   * disables CORS.
   */
  cors?: boolean | CorsConfig;
  /** Per-key (principal/IP) request rate limit. Default { limit: 1000, windowMs: 60000 }. */
  rateLimit?: { limit: number; windowMs: number } | null;
  /**
   * TLS/HTTPS configuration. When set (with cert + key) the gateway serves
   * HTTPS instead of HTTP (PR4).
   */
  tls?: TlsConfig;
  /**
   * API version segment applied as a URL prefix. Defaults to `'v1'` so every
   * route is reachable at both `/v1/<path>` and the legacy `/<path>` (PR4).
   * Set to `false` or `null` to disable versioned routing.
   */
  apiVersion?: string | false | null;
  /**
   * Emit standard security response headers (HSTS on TLS, no-sniff,
   * frame-deny, referrer-policy). Default true (PR4).
   */
  securityHeaders?: boolean;
}

export interface GatewayHandle {
  /** The actual port the server is listening on (after listen). */
  port: number;
  /** Wire protocol in use: 'https' when TLS is configured, else 'http'. */
  protocol: 'http' | 'https';
  /** True when the server is serving over TLS. */
  secure: boolean;
  close(): Promise<void>;
}
