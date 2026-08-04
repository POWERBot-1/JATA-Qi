// EPP codec — encode/decode RFC 5730 (protocol) + RFC 5731 (domain mapping)
// messages. Translates between EPP XML and structured operations the registry
// can execute. Result codes per RFC 5730 §3.

import { child, children, el, EPP_NS, parseXml, serializeXml, type XmlNode } from './xml.js';

export const EPP_DOMAIN_NS = 'urn:ietf:params:xml:ns:domain-1.0';
export const EPP_CONTACT_NS = 'urn:ietf:params:xml:ns:contact-1.0';
export const EPP_HOST_NS = 'urn:ietf:params:xml:ns:host-1.0';
export const EPP_RGP_NS = 'urn:ietf:params:xml:ns:rgp-1.0';

/** EPP result codes (RFC 5730 §3). */
export const ResultCode = {
  SuccessCompleted: 1000,
  SuccessActionPending: 1001,
  SuccessAckToDequeue: 1301,
  SuccessNoMessages: 1300,
  EndingSession: 1500,
  UnknownCommand: 2000,
  SyntaxError: 2001,
  UseError: 2002,
  BillingProblem: 2100,
  AuthenticationError: 2200,
  AuthorizationError: 2202,
  Pending: 2300,
  ObjectExists: 2302,
  ObjectDoesNotExist: 2303,
  StatusProhibitsOperation: 2304,
  ParameterPolicyError: 2306,
  PolicyError: 2308,
  CommandFailed: 2400,
  InternalError: 2500,
} as const;

export interface GreetingOptions {
  svID: string;
  versions?: string[];
  langs?: string[];
  objURIs?: string[];
}

export function encodeGreeting(opts: GreetingOptions): Buffer {
  const epp = el('epp', EPP_NS, '');
  const greeting = el('greeting', EPP_NS, '');
  greeting.children.push(el('svID', EPP_NS, opts.svID));
  greeting.children.push(el('svDate', EPP_NS, new Date().toISOString()));
  const svcMenu = el('svcMenu', EPP_NS, '');
  for (const v of opts.versions ?? ['1.0']) svcMenu.children.push(el('version', EPP_NS, v));
  for (const l of opts.langs ?? ['en']) svcMenu.children.push(el('lang', EPP_NS, l));
  for (const u of opts.objURIs ?? [EPP_DOMAIN_NS, EPP_CONTACT_NS, EPP_HOST_NS]) svcMenu.children.push(el('objURI', EPP_NS, u));
  greeting.children.push(svcMenu);
  const dcp = el('dcp', EPP_NS, '');
  dcp.children.push(el('access', EPP_NS, 'all'));
  greeting.children.push(dcp);
  epp.children = [greeting];
  return Buffer.from(serializeXml(epp), 'utf8');
}

export interface EppResponse {
  code: number;
  msg: string;
  clTRID?: string;
  svTRID: string;
  resData?: XmlNode[];
  ext?: XmlNode[];
}

export function encodeResponse(r: EppResponse): Buffer {
  const epp = el('epp', EPP_NS, '');
  const resp = el('response', EPP_NS, '');
  const result = el('result', EPP_NS, r.msg, { code: String(r.code) });
  resp.children.push(result);
  if (r.resData && r.resData.length > 0) {
    const resData = el('resData', EPP_NS, '');
    resData.children.push(...r.resData);
    resp.children.push(resData);
  }
  if (r.ext && r.ext.length > 0) {
    const ext = el('extension', EPP_NS, '');
    ext.children.push(...r.ext);
    resp.children.push(ext);
  }
  const trid = el('trID', EPP_NS, '');
  if (r.clTRID) trid.children.push(el('clTRID', EPP_NS, r.clTRID));
  trid.children.push(el('svTRID', EPP_NS, r.svTRID));
  resp.children.push(trid);
  epp.children = [resp];
  return Buffer.from(serializeXml(epp), 'utf8');
}

export type EppCommand =
  | { type: 'login'; clID: string; pw: string; version: string; lang: string; svcs: string[]; clTRID?: string }
  | { type: 'logout'; clTRID?: string }
  | { type: 'poll'; op: string; clTRID?: string }
  | { type: 'domain:check'; names: string[]; clTRID?: string }
  | { type: 'domain:create'; name: string; periodYears?: number; ns: string[]; registrant?: string; authInfo?: string; clTRID?: string }
  | { type: 'domain:info'; name: string; authInfo?: string; clTRID?: string }
  | { type: 'domain:renew'; name: string; curExpDate: string; periodYears?: number; clTRID?: string }
  | { type: 'domain:transfer'; name: string; op: string; authInfo?: string; periodYears?: number; clTRID?: string }
  | { type: 'domain:delete'; name: string; clTRID?: string }
  | { type: 'domain:update'; name: string; addNs?: string[]; remNs?: string[]; authInfo?: string; clTRID?: string }
  | { type: 'unknown'; clTRID?: string };

/** Parse a complete EPP XML command document into a structured command. */
export function parseCommand(xml: string): EppCommand {
  const root = parseXml(xml);
  if (root.local !== 'epp') throw new XmlProtocolError('root must be <epp>');
  const cmd = child(root, 'command');
  if (!cmd) {
    // Could be a <hello>.
    if (child(root, 'hello')) return { type: 'unknown' };
    throw new XmlProtocolError('expected <command> or <hello>');
  }
  const clTRID = child(cmd, 'clTRID')?.text;
  const login = child(cmd, 'login');
  if (login) {
    return {
      type: 'login',
      clID: child(login, 'clID')?.text ?? '',
      pw: child(login, 'pw')?.text ?? '',
      version: child(login, 'options') ? child(child(login, 'options')!, 'version')?.text ?? '1.0' : '1.0',
      lang: child(login, 'options') ? child(child(login, 'options')!, 'lang')?.text ?? 'en' : 'en',
      svcs: child(login, 'svcs') ? children(child(login, 'svcs')!, 'objURI').map((n) => n.text).filter(Boolean) : [],
      clTRID,
    };
  }
  if (child(cmd, 'logout')) return { type: 'logout', clTRID };
  const poll = child(cmd, 'poll');
  if (poll) return { type: 'poll', op: poll.attrs.op ?? 'req', clTRID };
  // Object commands have an <create>/<info>/... wrapper holding the mapping.
  for (const verb of ['create', 'info', 'check', 'renew', 'transfer', 'delete', 'update']) {
    const wrapper = child(cmd, verb);
    if (wrapper) return parseObjectCommand(verb, wrapper, clTRID);
  }
  return { type: 'unknown', clTRID };
}

function parseObjectCommand(verb: string, wrapper: XmlNode, clTRID?: string): EppCommand {
  // The wrapper's child is the namespaced mapping element, e.g. <domain:create>.
  const mapping = wrapper.children[0];
  if (!mapping) throw new XmlProtocolError(`empty ${verb} wrapper`);
  if (mapping.ns === EPP_DOMAIN_NS) return parseDomainCommand(verb, mapping, clTRID);
  // Unsupported object mapping for this server.
  return { type: 'unknown', clTRID };
}

function parseDomainCommand(verb: string, m: XmlNode, clTRID?: string): EppCommand {
  const name = child(m, 'name')?.text ?? '';
  if (verb === 'check') {
    const names = children(m, 'name').map((n) => n.text).filter(Boolean);
    return { type: 'domain:check', names, clTRID };
  }
  if (verb === 'create') {
    const period = child(m, 'period');
    const years = period ? Number(period.text) : 1;
    const ns = children(m, 'ns').flatMap((n) => children(n, 'hostObj').map((h) => h.text).filter(Boolean));
    const registrant = child(m, 'registrant')?.text;
    const auth = child(m, 'authInfo');
    const pw = auth ? child(auth, 'pw')?.text : undefined;
    return { type: 'domain:create', name, periodYears: years, ns, registrant, authInfo: pw, clTRID };
  }
  if (verb === 'info') {
    const auth = child(m, 'authInfo');
    return { type: 'domain:info', name, authInfo: auth ? child(auth, 'pw')?.text : undefined, clTRID };
  }
  if (verb === 'renew') {
    const curExp = child(m, 'curExpDate')?.text ?? '';
    const period = child(m, 'period');
    return { type: 'domain:renew', name, curExpDate: curExp, periodYears: period ? Number(period.text) : 1, clTRID };
  }
  if (verb === 'transfer') {
    const op = m.attrs.op ?? 'request';
    const auth = child(m, 'authInfo');
    const period = child(m, 'period');
    return { type: 'domain:transfer', name, op, authInfo: auth ? child(auth, 'pw')?.text : undefined, periodYears: period ? Number(period.text) : undefined, clTRID };
  }
  if (verb === 'delete') {
    return { type: 'domain:delete', name, clTRID };
  }
  if (verb === 'update') {
    const addNs = child(m, 'add');
    const remNs = child(m, 'rem');
    const auth = child(m, 'chg') ? child(child(m, 'chg')!, 'authInfo') : undefined;
    return {
      type: 'domain:update', name,
      addNs: addNs ? children(addNs, 'ns').flatMap((n) => children(n, 'hostObj').map((h) => h.text).filter(Boolean)) : undefined,
      remNs: remNs ? children(remNs, 'ns').flatMap((n) => children(n, 'hostObj').map((h) => h.text).filter(Boolean)) : undefined,
      authInfo: auth ? child(auth, 'pw')?.text : undefined,
      clTRID,
    };
  }
  return { type: 'unknown', clTRID };
}

export class XmlProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'XmlProtocolError'; }
}

// ---- response resData builders -------------------------------------------

export function domainCheckResData(results: Array<{ name: string; avail: boolean; reason?: string }>): XmlNode {
  const chk = el('chkData', EPP_DOMAIN_NS, '');
  chk.prefix = 'domain';
  for (const r of results) {
    const cd = el('cd', EPP_DOMAIN_NS, '');
    cd.children.push(el('name', EPP_DOMAIN_NS, r.name, { avail: r.avail ? '1' : '0' }));
    if (!r.avail && r.reason) cd.children.push(el('reason', EPP_DOMAIN_NS, r.reason));
    chk.children.push(cd);
  }
  return chk;
}

export function domainInfoResData(d: { name: string; registrarId: string; statuses: Iterable<string>; registrant?: string; ns: string[]; createdAt: number; expiresAt: number; updatedAt: number }): XmlNode {
  const inf = el('infData', EPP_DOMAIN_NS, '');
  inf.children.push(el('name', EPP_DOMAIN_NS, d.name));
  for (const s of d.statuses) inf.children.push(el('status', EPP_DOMAIN_NS, s, { s }));
  if (d.registrant) inf.children.push(el('registrant', EPP_DOMAIN_NS, d.registrant));
  for (const n of d.ns) inf.children.push(el('ns', EPP_DOMAIN_NS, ''));
  inf.children.push(el('clID', EPP_DOMAIN_NS, d.registrarId));
  inf.children.push(el('crID', EPP_DOMAIN_NS, d.registrarId));
  inf.children.push(el('crDate', EPP_DOMAIN_NS, new Date(d.createdAt).toISOString()));
  inf.children.push(el('exDate', EPP_DOMAIN_NS, new Date(d.expiresAt).toISOString()));
  inf.children.push(el('upDate', EPP_DOMAIN_NS, new Date(d.updatedAt).toISOString()));
  return inf;
}

export function domainCreateResData(name: string, createdAt: number, expiresAt: number): XmlNode {
  const cre = el('creData', EPP_DOMAIN_NS, '');
  cre.children.push(el('name', EPP_DOMAIN_NS, name));
  cre.children.push(el('crDate', EPP_DOMAIN_NS, new Date(createdAt).toISOString()));
  cre.children.push(el('exDate', EPP_DOMAIN_NS, new Date(expiresAt).toISOString()));
  return cre;
}

export { EPP_NS, serializeXml, parseXml };
export type { XmlNode };
