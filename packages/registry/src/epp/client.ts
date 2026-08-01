// EPP client — connects to an EPP server (RFC 5734 framing), performs RFC 5730
// login, and issues RFC 5731 domain commands. Used by the registrar platform to
// provision through the registry. Pure Node (node:net / node:tls).

import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { el, EPP_NS, serializeXml, parseXml, child, type XmlNode } from './xml.js';
import { EPP_DOMAIN_NS } from './codec.js';

export interface EppResponse {
  code: number;
  msg: string;
  clTRID?: string;
  svTRID?: string;
  /** Parsed resData root (if any). */
  resData?: XmlNode;
  raw: string;
}

export class EppClient {
  private socket?: Socket;
  private buf = Buffer.alloc(0);
  private greeting?: XmlNode;
  private queue: Buffer[] = [];
  private waiter?: (msg: Buffer) => void;
  private closed = false;

  async connect(host: string, port: number, useTls = false): Promise<XmlNode> {
    this.socket = useTls ? tlsConnect({ host, port, rejectUnauthorized: false }) as unknown as Socket : tcpConnect(port, host);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', resolve);
      this.socket!.once('error', reject);
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', () => { this.closed = true; this.waiter = undefined; });
    this.socket.on('close', () => { this.closed = true; });
    // First framed message is the greeting.
    const greetingBuf = await this.nextMessage();
    this.greeting = parseXml(greetingBuf.toString('utf8'));
    return this.greeting;
  }

  async login(clID: string, pw: string, clTRID?: string): Promise<EppResponse> {
    const login = el('login', EPP_NS, '');
    login.children.push(el('clID', EPP_NS, clID), el('pw', EPP_NS, pw));
    const options = el('options', EPP_NS, '');
    options.children.push(el('version', EPP_NS, '1.0'), el('lang', EPP_NS, 'en'));
    login.children.push(options);
    const svcs = el('svcs', EPP_NS, '');
    svcs.children.push(el('objURI', EPP_NS, EPP_DOMAIN_NS));
    login.children.push(svcs);
    return this.command(wrapCommand(login, clTRID));
  }

  async check(names: string[], clTRID?: string): Promise<EppResponse> {
    const create = domainEl('check');
    for (const n of names) create.children.push(el('name', EPP_DOMAIN_NS, n));
    return this.command(wrapVerb('check', create, clTRID));
  }

  async create(name: string, opts: { periodYears?: number; ns?: string[]; registrant?: string; authInfo?: string }, clTRID?: string): Promise<EppResponse> {
    const create = domainEl('create');
    create.children.push(el('name', EPP_DOMAIN_NS, name));
    if (opts.periodYears) create.children.push(el('period', EPP_DOMAIN_NS, opts.periodYears, { unit: 'y' }));
    if (opts.ns && opts.ns.length) {
      const ns = el('ns', EPP_DOMAIN_NS, '');
      for (const h of opts.ns) ns.children.push(el('hostObj', EPP_DOMAIN_NS, h));
      create.children.push(ns);
    }
    if (opts.registrant) create.children.push(el('registrant', EPP_DOMAIN_NS, opts.registrant));
    if (opts.authInfo) create.children.push(authInfoEl(opts.authInfo));
    return this.command(wrapVerb('create', create, clTRID));
  }

  async info(name: string, authInfo?: string, clTRID?: string): Promise<EppResponse> {
    const info = domainEl('info');
    info.children.push(el('name', EPP_DOMAIN_NS, name));
    if (authInfo) info.children.push(authInfoEl(authInfo));
    return this.command(wrapVerb('info', info, clTRID));
  }

  async renew(name: string, curExpDate: string, periodYears = 1, clTRID?: string): Promise<EppResponse> {
    const renew = domainEl('renew');
    renew.children.push(el('name', EPP_DOMAIN_NS, name), el('curExpDate', EPP_DOMAIN_NS, curExpDate), el('period', EPP_DOMAIN_NS, periodYears, { unit: 'y' }));
    return this.command(wrapVerb('renew', renew, clTRID));
  }

  async delete(name: string, clTRID?: string): Promise<EppResponse> {
    const del = domainEl('delete');
    del.children.push(el('name', EPP_DOMAIN_NS, name));
    return this.command(wrapVerb('delete', del, clTRID));
  }

  async transfer(name: string, op: string, authInfo?: string, clTRID?: string): Promise<EppResponse> {
    const tr = el('transfer', EPP_DOMAIN_NS, '', { op });
    tr.children.push(el('name', EPP_DOMAIN_NS, name));
    if (authInfo) tr.children.push(authInfoEl(authInfo));
    return this.command(wrapVerb('transfer', tr, clTRID));
  }

  async logout(clTRID?: string): Promise<EppResponse> {
    const lo = el('logout', EPP_NS, '');
    const r = await this.command(wrapCommand(lo, clTRID));
    this.socket?.end();
    return r;
  }

  close(): void { this.socket?.destroy(); }

  private async command(xml: string): Promise<EppResponse> {
    if (!this.socket) throw new Error('EppClient not connected');
    const buf = Buffer.from(xml, 'utf8');
    const total = 4 + buf.length;
    const out = Buffer.allocUnsafe(total);
    out.writeUInt32BE(total, 0);
    out.set(buf, 4);
    this.socket.write(out);
    const msg = await this.nextMessage();
    return this.parseResponse(msg);
  }

  /** Wait for the next complete framed message (single consumer). */
  private nextMessage(): Promise<Buffer> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise<Buffer>((resolve) => { this.waiter = resolve; });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) break;
      const total = this.buf.readUInt32BE(0);
      if (total < 4 || this.buf.length < total) break;
      const msg = this.buf.subarray(4, total);
      this.buf = this.buf.subarray(total);
      if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(msg); }
      else this.queue.push(msg);
    }
  }

  private parseResponse(msg: Buffer): EppResponse {
    const text = msg.toString('utf8');
    let code = 0, m = '', clTRID: string | undefined, svTRID: string | undefined, resData: XmlNode | undefined;
    try {
      const root = parseXml(text);
      const resp = child(root, 'response');
      if (resp) {
        const result = child(resp, 'result');
        code = result ? Number(result.attrs.code ?? '0') : 0;
        m = result?.text ?? '';
        const resDataNode = child(resp, 'resData');
        resData = resDataNode?.children[0];
        const trid = child(resp, 'trID');
        clTRID = trid ? child(trid, 'clTRID')?.text : undefined;
        svTRID = trid ? child(trid, 'svTRID')?.text : undefined;
      }
    } catch { /* malformed */ }
    return { code, msg: m, clTRID, svTRID, ...(resData ? { resData } : {}), raw: text };
  }
}

function wrapCommand(inner: XmlNode, clTRID?: string): string {
  const epp = el('epp', EPP_NS, '');
  const command = el('command', EPP_NS, '');
  command.children.push(inner);
  if (clTRID) command.children.push(el('clTRID', EPP_NS, clTRID));
  epp.children = [command];
  return serializeXml(epp);
}

function wrapVerb(verb: string, mapping: XmlNode, clTRID?: string): string {
  const epp = el('epp', EPP_NS, '');
  const command = el('command', EPP_NS, '');
  const wrapper = el(verb, EPP_NS, '');
  wrapper.children.push(mapping);
  command.children.push(wrapper);
  if (clTRID) command.children.push(el('clTRID', EPP_NS, clTRID));
  epp.children = [command];
  return serializeXml(epp);
}

function domainEl(verb: string): XmlNode {
  return el(verb, EPP_DOMAIN_NS, '', {}, 'domain');
}

function authInfoEl(pw: string): XmlNode {
  const a = el('authInfo', EPP_DOMAIN_NS, '');
  a.children.push(el('pw', EPP_DOMAIN_NS, pw));
  return a;
}
