// EPP server — RFC 5734 (4-byte length framing over TCP/TLS), RFC 5730 login
// authentication, and dispatch of RFC 5731 domain commands to the registry.
// Sessions are per-connection; a registrar must login before object commands.

import { createServer as createTcp, type Server as TcpServer, type Socket } from 'node:net';
import { createServer as createTls, type Server as TlsServer, type SecureContextOptions } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { encodeGreeting, encodeResponse, parseCommand, ResultCode, domainCheckResData, domainCreateResData, domainInfoResData, type EppCommand } from './codec.js';
import { XmlProtocolError } from './codec.js';
import type { Registry } from '../registry.js';
import { RegistryError } from '../registry.js';
import type { XmlNode } from './xml.js';

export interface EppServerOptions {
  svID: string;
  /** TLS material; if provided the server speaks EPP over TLS (RFC 5734). */
  tls?: SecureContextOptions;
}

interface Session { socket: Socket; registrarId?: string; clTRID?: string }

interface DispatchResp { code: number; msg: string; clTRID?: string; svTRID: string; resData?: XmlNode[] }

export class EppServer {
  private server?: TcpServer | TlsServer;
  private port = 0;

  constructor(private registry: Registry, private opts: EppServerOptions) {}

  get address(): number { return this.port; }

  start(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const onConn = (socket: Socket) => this.handleConnection(socket);
      this.server = this.opts.tls ? createTls(this.opts.tls, onConn) : createTcp(onConn);
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        const a = this.server!.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.port = 0;
  }

  private handleConnection(socket: Socket): void {
    const session: Session = { socket };
    // Greet immediately on connect (RFC 5730).
    socket.write(frame(encodeGreeting({ svID: this.opts.svID })));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const total = buf.readUInt32BE(0);
        if (buf.length < total) break;
        const msg = buf.subarray(4, total);
        buf = buf.subarray(total);
        const out = this.handleMessage(session, msg);
        socket.write(frame(out));
        if (out.subtype === 'logout') socket.end();
      }
    });
    socket.on('error', () => { /* connection reset */ });
  }

  /** Pure handler — parses one framed message and returns the response buffer. */
  handleMessage(session: Session, xmlBuf: Buffer): Buffer & { subtype?: string } {
    let command: EppCommand;
    try {
      command = parseCommand(xmlBuf.toString('utf8'));
    } catch (e) {
      const code = e instanceof XmlProtocolError ? ResultCode.SyntaxError : ResultCode.InternalError;
      const buf = encodeResponse({ code, msg: e instanceof Error ? e.message : 'parse error', svTRID: this.svtrid() });
      return Object.assign(buf, { subtype: 'error' });
    }
    const resp = this.dispatch(session, command);
    const buf = encodeResponse(resp);
    return Object.assign(buf, { subtype: command.type });
  }

  private dispatch(session: Session, command: EppCommand): DispatchResp {
    const svTRID = this.svtrid();
    const ok = (resData?: XmlNode): DispatchResp =>
      ({ code: ResultCode.SuccessCompleted, msg: 'Command completed successfully', clTRID: command.clTRID, svTRID, ...(resData ? { resData: [resData] } : {}) });

    switch (command.type) {
      case 'login': {
        const reg = this.registry.authenticateRegistrar(command.clID, command.pw);
        if (!reg) return { code: ResultCode.AuthenticationError, msg: 'Authentication error', clTRID: command.clTRID, svTRID };
        session.registrarId = reg.id;
        return ok();
      }
      case 'logout':
        return { code: ResultCode.EndingSession, msg: 'Command completed successfully; ending session', clTRID: command.clTRID, svTRID };
      case 'poll':
        return { code: ResultCode.SuccessNoMessages, msg: 'Command completed successfully; no messages', clTRID: command.clTRID, svTRID };
      default:
        break;
    }

    // All remaining commands require an authenticated registrar.
    if (!session.registrarId) {
      return { code: ResultCode.AuthenticationError, msg: 'Authentication error: login required', clTRID: command.clTRID, svTRID };
    }
    const rid = session.registrarId;
    try {
      switch (command.type) {
        case 'domain:check': {
          const results = this.registry.checkAvailabilityBatch(command.names).map((r) => ({ name: r.name, avail: r.available, ...(r.reason ? { reason: r.reason } : {}) }));
          return ok(domainCheckResData(results));
        }
        case 'domain:create': {
          const d = this.registry.createDomain({
            name: command.name, registrarId: rid,
            registrant: command.registrant ?? `${rid}-default-contact`,
            nameservers: command.ns, periodYears: command.periodYears, authInfo: command.authInfo ?? randomUUID(),
          });
          return ok(domainCreateResData(d.name, d.createdAt, d.expiresAt));
        }
        case 'domain:info': {
          const d = this.registry.info(command.name);
          if (!d) return { code: ResultCode.ObjectDoesNotExist, msg: `domain ${command.name} does not exist`, clTRID: command.clTRID, svTRID };
          return ok(domainInfoResData({ name: d.name, registrarId: d.registrarId, statuses: d.statuses, registrant: d.registrant, ns: d.nameservers, createdAt: d.createdAt, expiresAt: d.expiresAt, updatedAt: d.updatedAt }));
        }
        case 'domain:renew': {
          this.registry.renew(command.name, rid, command.periodYears ?? 1);
          return ok();
        }
        case 'domain:delete': {
          this.registry.deleteDomain(command.name, rid);
          return ok();
        }
        case 'domain:update': {
          this.registry.updateDomain(command.name, rid, { addNameservers: command.addNs, remNameservers: command.remNs, authInfo: command.authInfo });
          return ok();
        }
        case 'domain:transfer': {
          if (command.op === 'request') {
            const rec = this.registry.requestTransfer(command.name, rid, command.authInfo ?? '');
            if (rec.state === 'rejected') return { code: ResultCode.AuthorizationError, msg: 'Transfer rejected: authorization error', clTRID: command.clTRID, svTRID };
            return { code: ResultCode.SuccessActionPending, msg: 'Transfer requested; pending', clTRID: command.clTRID, svTRID };
          }
          return { code: ResultCode.UseError, msg: `unsupported transfer op ${command.op}`, clTRID: command.clTRID, svTRID };
        }
        default:
          return { code: ResultCode.UnknownCommand, msg: 'Unimplemented command', clTRID: command.clTRID, svTRID };
      }
    } catch (e) {
      return mapRegistryError(e, command.clTRID, svTRID);
    }
  }

  private svtrid(): string {
    return `${this.opts.svID}-${randomUUID().slice(0, 13)}`;
  }
}

function mapRegistryError(e: unknown, clTRID: string | undefined, svTRID: string): DispatchResp {
  const msg = e instanceof Error ? e.message : 'command failed';
  let code: number = ResultCode.CommandFailed;
  if (/not available: registered|already exists|exists/i.test(msg)) code = ResultCode.ObjectExists;
  else if (/not found|does not exist/i.test(msg)) code = ResultCode.ObjectDoesNotExist;
  else if (/prohibited/i.test(msg)) code = ResultCode.StatusProhibitsOperation;
  else if (/reserved|claims|policy|term|invalid/i.test(msg)) code = ResultCode.PolicyError;
  else if (/sponsor|does not sponsor|unknown registrar/i.test(msg)) code = ResultCode.AuthorizationError;
  return { code, msg, clTRID, svTRID };
}

/** EPP framing: 4-byte big-endian total length (header + unit) per RFC 5734. */
function frame(xml: Buffer): Buffer {
  const total = 4 + xml.length;
  const out = Buffer.allocUnsafe(total);
  out.writeUInt32BE(total, 0);
  out.set(xml, 4);
  return out;
}

export { RegistryError, frame as frameMessage };
