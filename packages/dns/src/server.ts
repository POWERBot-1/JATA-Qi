// AuthoritativeServer — serves DNS over UDP (node:dgram) and TCP (node:net),
// EDNS0-aware, with AXFR zone transfer, GeoDNS/round-robin shaping, and query
// analytics. The pure query handler (handleQuery) is exported for unit testing
// without sockets.

import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server as TcpServer, type Socket as TcpSocket } from 'node:net';
import { CLASS_IN, DnsOpcode, Rcode, Rtype } from './types.js';
import { decodeMessage, encodeMessage, WireFormatError } from './wire.js';
import type { ZoneStore } from './zones.js';
import type { GeoBalancer } from './geo.js';
import type { DnsMessage, DnsRecord, DnsQuestion } from './types.js';

export const RTYPE_AXFR = 252;
export const RTYPE_IXFR = 251;

export interface ServerAnalytics {
  totalQueries: number;
  byKey: Record<string, number>;
  topQnames: Array<{ name: string; count: number }>;
}

export interface AuthoritativeServerOptions {
  /** GeoDNS balancer (optional). */
  geo?: GeoBalancer;
  /** Default UDP payload size advertised (default 1232). */
  udpSize?: number;
  /** Whether AXFR is permitted (default true; real deployments use ACLs/TSIG). */
  allowAxfr?: boolean;
  /** Called for every answered query (audit/observability hook). */
  onQuery?: (info: { question: DnsQuestion; rcode: number; clientIp?: string; zone?: string }) => void;
}

export class AuthoritativeServer {
  private udp?: UdpSocket;
  private tcp?: TcpServer;
  private analyticsCount = 0;
  private analyticsByKey = new Map<string, number>();
  private qnameCounts = new Map<string, number>();
  private udpPort = 0;
  private tcpPort = 0;

  constructor(private store: ZoneStore, private opts: AuthoritativeServerOptions = {}) {
    this.opts.udpSize ??= 1232;
    this.opts.allowAxfr ??= true;
  }

  /** Ports the server is listening on (0 until started). */
  get address(): { udp: number; tcp: number } {
    return { udp: this.udpPort, tcp: this.tcpPort };
  }

  async start(port: number, host = '127.0.0.1'): Promise<{ udp: number; tcp: number }> {
    await Promise.all([this.startUdp(port, host), this.startTcp(port, host)]);
    return { udp: this.udpPort, tcp: this.tcpPort };
  }

  private startUdp(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createSocket({ type: 'udp4', reuseAddr: true });
      this.udp = sock;
      sock.on('error', reject);
      sock.on('message', (msg, rinfo) => {
        const clientIp = rinfo.address;
        const resp = this.handleQuery(msg, clientIp);
        if (resp.length > (this.opts.udpSize ?? 1232)) {
          // Truncate to fit under TC.
          sock.send(this.truncated(msg), rinfo.port, clientIp);
        } else {
          sock.send(resp, rinfo.port, clientIp);
        }
      });
      sock.bind(port, host, () => {
        const a = sock.address();
        if (typeof a === 'object') this.udpPort = a.port;
        resolve();
      });
    });
  }

  private startTcp(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((socket) => this.handleTcpClient(socket));
      this.tcp = srv;
      srv.on('error', reject);
      srv.listen(port, host, () => {
        const a = srv.address();
        if (typeof a === 'object' && a) this.tcpPort = a.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    if (this.udp) jobs.push(new Promise<void>((r) => this.udp!.close(() => r())));
    if (this.tcp) jobs.push(new Promise<void>((r) => this.tcp!.close(() => r())));
    await Promise.all(jobs);
    this.udpPort = 0;
    this.tcpPort = 0;
  }

  private handleTcpClient(socket: TcpSocket): void {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // DNS-over-TCP: 2-byte length prefix per message.
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const msg = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        const q = decodeMessageSafe(msg);
        if (q.questions[0]?.type === RTYPE_AXFR) {
          for (const out of this.handleAxfr(msg)) socket.write(frame(out));
        } else {
          socket.write(frame(this.handleQuery(msg, socket.remoteAddress)));
        }
      }
    });
    socket.on('error', () => { /* connection reset; ignore */ });
  }

  // ---- pure query handling (testable) -------------------------------------

  /**
   * Build a response buffer for a DNS query. This is the core resolution path;
   * it never throws on malformed input (it returns a FORMERR response instead).
   */
  handleQuery(requestBuf: Buffer, clientIp?: string): Buffer {
    const q = decodeMessageSafe(requestBuf);
    if (q.header.opcode !== DnsOpcode.QUERY) {
      return this.respond(q, Rcode.NOTIMP, [], [], []);
    }
    if (q.questions.length !== 1) {
      return this.respond(q, Rcode.FORMERR, [], [], []);
    }
    const question = q.questions[0]!;
    this.recordAnalytics(question, Rcode.NOERROR, clientIp, undefined);
    // EDNS DO bit.
    const opt = q.additionals.find((r) => r.type === Rtype.OPT);
    let doBit = false;
    let ednsUdp = 0;
    if (opt && opt.data.type === 'OPT') {
      doBit = (opt.data.flags & 0x8000) !== 0;
      ednsUdp = opt.data.udpSize;
      if (opt.data.version !== 0) {
        return this.respond(q, Rcode.BADVERS & 0xf, [], [], [], opt);
      }
    }
    const zone = this.store.findZone(question.name);
    if (!zone) {
      return this.respond(q, Rcode.REFUSED, [], [], [], opt);
    }
    const result = this.store.resolve(zone, question.name, question.type, { dnssec: true, do: doBit });
    let answers = result.answers;
    let aa = result.aa && !result.referral;
    // GeoDNS / load-balancing override for A/AAAA.
    if (this.opts.geo && (question.type === Rtype.A || question.type === Rtype.AAAA || question.type === Rtype.ANY)) {
      const geo = this.opts.geo.resolve(zone.origin, question.name, question.type, clientIp);
      if (geo && geo.length > 0) {
        const shaped: DnsRecord[] = geo
          .filter((d) => question.type === Rtype.ANY || (d.type === 'A' && question.type === Rtype.A) || (d.type === 'AAAA' && question.type === Rtype.AAAA))
          .map((d) => ({ name: question.name, type: d.type === 'A' ? Rtype.A : Rtype.AAAA, class: CLASS_IN, ttl: 60, data: d }));
        if (shaped.length > 0) {
          answers = shaped;
          aa = true;
        }
      }
    }
    this.opts.onQuery?.({ question, rcode: result.rcode, clientIp, zone: zone.origin });
    this.bumpAnalytics(question, result.rcode, zone.origin);
    const resp = this.respond(q, result.rcode, answers, result.authority, result.additional, opt, aa);
    void doBit; void ednsUdp;
    return resp;
  }

  private respond(
    q: DnsMessage,
    rcode: number,
    answers: DnsRecord[],
    authority: DnsRecord[],
    additional: DnsRecord[],
    opt?: DnsRecord,
    aa = true,
  ): Buffer {
    const additionals = opt ? [this.responseOpt(opt), ...additional] : additional;
    const msg: DnsMessage = {
      header: {
        id: q.header.id,
        flags: 0,
        opcode: q.header.opcode,
        rcode,
        qr: true,
        aa,
        tc: false,
        rd: q.header.rd,
        ra: false,
        z: 0,
        qdcount: 1,
        ancount: answers.length,
        nscount: authority.length,
        arcount: additionals.length,
      },
      questions: q.questions,
      answers,
      authorities: authority,
      additionals,
    };
    return encodeMessage(msg);
  }

  private responseOpt(reqOpt: DnsRecord): DnsRecord {
    const data = reqOpt.data.type === 'OPT' ? reqOpt.data : { type: 'OPT' as const, udpSize: 0, extRcode: 0, version: 0, flags: 0, options: [] };
    return {
      name: '.',
      type: Rtype.OPT,
      class: this.opts.udpSize ?? 1232,
      ttl: 0,
      data: { type: 'OPT', udpSize: this.opts.udpSize ?? 1232, extRcode: 0, version: 0, flags: data.flags & 0x8000 /* echo DO */, options: [] },
    };
  }

  /** Build a truncated (TC=1) response: header + question, no records. */
  private truncated(requestBuf: Buffer): Buffer {
    const q = decodeMessageSafe(requestBuf);
    const msg: DnsMessage = {
      header: {
        id: q.header.id,
        flags: 0,
        opcode: q.header.opcode,
        rcode: Rcode.NOERROR,
        qr: true,
        aa: true,
        tc: true,
        rd: q.header.rd,
        ra: false,
        z: 0,
        qdcount: q.questions.length,
        ancount: 0,
        nscount: 0,
        arcount: 0,
      },
      questions: q.questions,
      answers: [],
      authorities: [],
      additionals: [],
    };
    return encodeMessage(msg);
  }

  // ---- AXFR (zone transfer) -----------------------------------------------

  handleAxfr(requestBuf: Buffer): Buffer[] {
    const q = decodeMessageSafe(requestBuf);
    if (!this.opts.allowAxfr) return [this.respond(q, Rcode.REFUSED, [], [], [])];
    const question = q.questions[0];
    if (!question) return [this.respond(q, Rcode.FORMERR, [], [], [])];
    const zone = this.store.findZone(question.name);
    if (!zone || zone.origin !== question.name) return [this.respond(q, Rcode.REFUSED, [], [], [])];
    const soa = this.store.recordsAt(zone, zone.origin).filter((r) => r.type === Rtype.SOA).map(toDnsRecord);
    const body = zone.records
      .filter((r) => r.type !== Rtype.SOA && r.type !== Rtype.RRSIG)
      .map(toDnsRecord);
    const out: Buffer[] = [];
    // First message: SOA + as many records as fit, then SOA to close.
    out.push(this.axfrMessage(q, [...soa, ...body.slice(0, 100)]));
    for (let i = 100; i < body.length; i += 200) {
      out.push(this.axfrMessage(q, body.slice(i, i + 200)));
    }
    out.push(this.axfrMessage(q, soa)); // closing SOA
    return out;
  }

  private axfrMessage(q: DnsMessage, answers: DnsRecord[]): Buffer {
    const msg: DnsMessage = {
      header: { ...q.header, qr: true, aa: true, opcode: q.header.opcode, flags: 0, rcode: Rcode.NOERROR, qdcount: 1, ancount: answers.length, nscount: 0, arcount: 0 },
      questions: q.questions,
      answers,
      authorities: [],
      additionals: [],
    };
    return encodeMessage(msg);
  }

  // ---- analytics ----------------------------------------------------------

  private recordAnalytics(q: DnsQuestion, rcode: number, _clientIp: string | undefined, _zone?: string): void {
    this.analyticsCount++;
    this.qnameCounts.set(q.name, (this.qnameCounts.get(q.name) ?? 0) + 1);
  }
  private bumpAnalytics(q: DnsQuestion, rcode: number, zone: string): void {
    const key = `${zone}|${q.type}|${rcode}`;
    this.analyticsByKey.set(key, (this.analyticsByKey.get(key) ?? 0) + 1);
  }

  analytics(): ServerAnalytics {
    const byKey: Record<string, number> = {};
    for (const [k, v] of this.analyticsByKey) byKey[k] = v;
    const topQnames = [...this.qnameCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    return { totalQueries: this.analyticsCount, byKey, topQnames };
  }
}

function decodeMessageSafe(buf: Buffer): DnsMessage {
  try {
    return decodeMessage(buf);
  } catch {
    return {
      header: { id: buf.length >= 2 ? buf.readUInt16BE(0) : 0, flags: 0, opcode: 0, rcode: Rcode.FORMERR, qr: false, aa: false, tc: false, rd: false, ra: false, z: 0, qdcount: 0, ancount: 0, nscount: 0, arcount: 0 },
      questions: [],
      answers: [],
      authorities: [],
      additionals: [],
    };
  }
}

function toDnsRecord(r: { name: string; type: number; class: number; ttl: number; data: DnsRecord['data'] }): DnsRecord {
  return { name: r.name, type: r.type, class: r.class, ttl: r.ttl, data: r.data };
}

function frame(msg: Buffer): Buffer {
  const out = Buffer.allocUnsafe(2 + msg.length);
  out.writeUInt16BE(msg.length, 0);
  out.set(msg, 2);
  return out;
}

export { WireFormatError };
