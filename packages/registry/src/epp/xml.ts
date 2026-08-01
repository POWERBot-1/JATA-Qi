// Minimal XML codec for EPP payloads. EPP uses a small, well-defined XML subset
// (elements, attributes, text, namespaces, the 5 predefined entities). This
// parser/serializer is sufficient and correct for that subset — it is NOT a
// general-purpose XML implementation and intentionally does not handle DTDs,
// CDATA, or schema validation.

export interface XmlNode {
  /** Local name (e.g. 'create'). */
  local: string;
  /** Namespace URI, resolved from prefix declarations in scope. */
  ns: string;
  /** Original prefix as written (may be ''). */
  prefix: string;
  /** Attribute local-name -> value. Namespaced attrs keep 'prefix:local'. */
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const EPP_NS = 'urn:ietf:params:xml:ns:epp-1.0';
export { EPP_NS };

/** Decode an XML document string into a root XmlNode. Throws on malformed input. */
export function parseXml(input: string): XmlNode {
  const p = new XmlParser(input);
  p.skipProlog();
  const root = p.readElement(new Map());
  if (!root) throw new XmlError('no root element');
  return root;
}

export class XmlError extends Error {
  constructor(message: string) { super(message); this.name = 'XmlError'; }
}

class XmlParser {
  private i = 0;
  constructor(private s: string) {}

  skipProlog(): void {
    this.skipWs();
    if (this.s.startsWith('<?xml', this.i)) {
      const end = this.s.indexOf('?>', this.i);
      if (end < 0) throw new XmlError('unclosed XML declaration');
      this.i = end + 2;
    }
    this.skipMisc();
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWs();
      if (this.s.startsWith('<!--', this.i)) {
        const end = this.s.indexOf('-->', this.i);
        if (end < 0) throw new XmlError('unclosed comment');
        this.i = end + 3;
      } else if (this.s.startsWith('<!', this.i)) {
        const end = this.s.indexOf('>', this.i);
        if (end < 0) throw new XmlError('unclosed declaration');
        this.i = end + 1;
      } else break;
    }
  }

  private skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  readElement(parentNs: Map<string, string>): XmlNode | undefined {
    this.skipMisc();
    if (this.i >= this.s.length || this.s[this.i] !== '<') return undefined;
    if (this.s[this.i + 1] === '/') return undefined;
    this.i++; // consume '<'
    const name = this.readName();
    if (!name) throw new XmlError('expected element name');
    const { prefix, local } = splitName(name);
    const attrs = this.readAttributes();
    // Resolve namespaces from xmlns / xmlns:prefix declarations.
    const ns = new Map(parentNs);
    let defaultNs = ns.get('') ?? '';
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'xmlns') defaultNs = v;
      else if (k.startsWith('xmlns:')) ns.set(k.slice(6), v);
    }
    const myNs = prefix ? (ns.get(prefix) ?? '') : defaultNs;
    ns.set('', defaultNs);
    const node: XmlNode = { local, ns: myNs, prefix, attrs: {}, children: [], text: '' };
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      node.attrs[k] = v;
    }
    // Self-closing?
    this.skipWs();
    if (this.s[this.i] === '/') { this.i += 2; return node; } // '/>'
    if (this.s[this.i] !== '>') throw new XmlError('expected > after attributes');
    this.i++; // consume '>'
    // Children / text.
    let text = '';
    for (;;) {
      this.skipWs();
      if (this.s.startsWith('</', this.i)) {
        this.i += 2;
        const closeName = this.readName();
        this.skipWs();
        if (this.s[this.i] !== '>') throw new XmlError('expected > in close tag');
        this.i++;
        if (closeName !== name) throw new XmlError(`mismatched close: ${closeName} vs ${name}`);
        node.text = decodeEntities(text.trim());
        return node;
      }
      if (this.s.startsWith('<!--', this.i)) {
        const end = this.s.indexOf('-->', this.i);
        if (end < 0) throw new XmlError('unclosed comment');
        this.i = end + 3;
        continue;
      }
      if (this.s[this.i] === '<') {
        const child = this.readElement(ns);
        if (child) node.children.push(child);
        continue;
      }
      // Text run until next '<'.
      const next = this.s.indexOf('<', this.i);
      const end = next < 0 ? this.s.length : next;
      text += this.s.slice(this.i, end);
      this.i = end;
    }
  }

  private readName(): string {
    const start = this.i;
    while (this.i < this.s.length && /[A-Za-z0-9_:.\-]/.test(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i);
  }

  private readAttributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === '>' || c === '/' || c === undefined) break;
      const name = this.readName();
      if (!name) break;
      this.skipWs();
      if (this.s[this.i] !== '=') throw new XmlError(`expected = after attr ${name}`);
      this.i++;
      this.skipWs();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") throw new XmlError('expected quoted attribute value');
      this.i++;
      const end = this.s.indexOf(quote, this.i);
      if (end < 0) throw new XmlError('unclosed attribute value');
      attrs[name] = decodeEntities(this.s.slice(this.i, end));
      this.i = end + 1;
    }
    return attrs;
  }
}

function splitName(qname: string): { prefix: string; local: string } {
  const idx = qname.indexOf(':');
  return idx < 0 ? { prefix: '', local: qname } : { prefix: qname.slice(0, idx), local: qname.slice(idx + 1) };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last to avoid double-decoding
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** Serialize an XmlNode tree back to an XML string. */
export function serializeXml(node: XmlNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serializeNode(node, out, new Map());
  return out.join('');
}

function serializeNode(node: XmlNode, out: string[], ns: Map<string, string>): void {
  // Compute the prefix to emit and any xmlns declarations to add.
  const decls: string[] = [];
  if (node.prefix) {
    if (ns.get(node.prefix) !== node.ns) { decls.push(`xmlns:${node.prefix}="${escapeAttr(node.ns)}"`); ns.set(node.prefix, node.ns); }
  } else {
    if (ns.get('') !== node.ns) { decls.push(`xmlns="${escapeAttr(node.ns)}"`); ns.set('', node.ns); }
  }
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('xmlns:') && ns.get(k.slice(6)) === v) continue;
    if (k === 'xmlns') continue;
    decls.push(`${k}="${escapeAttr(v)}"`);
  }
  const qname = node.prefix ? `${node.prefix}:${node.local}` : node.local;
  const attrStr = decls.length ? ' ' + decls.join(' ') : '';
  if (node.children.length === 0 && node.text === '') {
    out.push(`<${qname}${attrStr}/>`);
    return;
  }
  out.push(`<${qname}${attrStr}>`);
  if (node.text) out.push(escapeText(node.text));
  const childNs = new Map(ns);
  for (const c of node.children) serializeNode(c, out, childNs);
  out.push(`</${qname}>`);
}

/** Find the first child with a given local name (any namespace). */
export function child(node: XmlNode, local: string): XmlNode | undefined {
  return node.children.find((c) => c.local === local);
}

/** Find all children with a given local name. */
export function children(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((c) => c.local === local);
}

/** Build a text-only element. */
export function el(local: string, ns: string, text: string | number, attrs: Record<string, string> = {}, prefix = ''): XmlNode {
  return { local, ns, prefix, attrs, children: [], text: String(text) };
}
