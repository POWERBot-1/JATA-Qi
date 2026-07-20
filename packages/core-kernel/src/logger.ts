// Structured JSON logger. Stderr for levels, supports child loggers and redaction.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
  silent: 100,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  scope?: string;
  data?: Record<string, unknown>;
  err?: { message: string; stack?: string; name?: string };
}

export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  sink?: LogSink;
  /** Top-level keys whose values will be replaced with "[REDACTED]". */
  redact?: string[];
}

const defaultSink: LogSink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === 'error' || entry.level === 'fatal') {
    process.stderr.write(line + '\n');
  } else {
    process.stderr.write(line + '\n');
  }
};

export class Logger {
  private readonly level: LogLevel;
  private readonly scope?: string;
  private readonly sink: LogSink;
  private readonly redact: Set<string>;
  private readonly baseData?: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
    this.scope = opts.scope;
    this.sink = opts.sink ?? defaultSink;
    this.redact = new Set(opts.redact ?? ['password', 'token', 'secret', 'authorization']);
  }

  /** Create a child logger bound to a scope, inheriting config and base fields. */
  child(scope: string, extra?: Record<string, unknown>): Logger {
    const child = Object.create(Logger.prototype) as Logger;
    Object.assign(child, {
      level: this.level,
      scope: this.scope ? `${this.scope}:${scope}` : scope,
      sink: this.sink,
      redact: this.redact,
      baseData: this.baseData ? { ...this.baseData, ...(extra ?? {}) } : extra,
    });
    return child;
  }

  trace(msg: string, data?: Record<string, unknown>): void { this.log('trace', msg, data); }
  debug(msg: string, data?: Record<string, unknown>): void { this.log('debug', msg, data); }
  info(msg: string, data?: Record<string, unknown>): void  { this.log('info', msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void  { this.log('warn', msg, data); }
  error(msg: string, data?: Record<string, unknown> | Error): void { this.log('error', msg, data); }
  fatal(msg: string, data?: Record<string, unknown> | Error): void { this.log('fatal', msg, data); }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown> | Error): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
    if (this.scope) entry.scope = this.scope;

    let merged: Record<string, unknown> | undefined;
    if (this.baseData) merged = { ...this.baseData };

    if (data instanceof Error) {
      entry.err = { message: data.message, stack: data.stack, name: data.name };
    } else if (data) {
      const sanitized = this.sanitize(data);
      merged = merged ? { ...merged, ...sanitized } : sanitized;
    }
    if (merged && Object.keys(merged).length > 0) entry.data = merged;

    this.sink(entry);
  }

  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (this.redact.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else if (v && typeof v === 'object' && !(v instanceof Error)) {
        out[k] = this.sanitize(v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}
