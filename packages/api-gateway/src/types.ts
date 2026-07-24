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

export interface GatewayOptions {
  /** Max request body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Enable permissive CORS headers (default false). */
  cors?: boolean;
  /** Per-key (principal/IP) request rate limit. Default { limit: 1000, windowMs: 60000 }. */
  rateLimit?: { limit: number; windowMs: number } | null;
}

export interface GatewayHandle {
  /** The actual port the server is listening on (after listen). */
  port: number;
  close(): Promise<void>;
}
