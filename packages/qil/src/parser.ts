// QiL parser — recursive-descent parser that turns a token stream into an AST.
//
// Grammar (informal):
//   program      := statement*
//   statement    := KEYWORD subject? argument? property* block?
//   subject      := IDENT                       (agent/team/object name)
//   argument     := STRING
//   property     := IDENT (':' | '=') value
//   value        := STRING | NUMBER | BOOLEAN | IDENT
//   block        := '{' statement* '}'

import type { Literal, QiLProgram, QiLStatement, Token } from './types.js';
import { tokenize } from './lexer.js';

export class ParseError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, token: Token) {
    super(`QiL parse error at ${token.line}:${token.col} — ${message}`);
    this.name = 'ParseError';
    this.line = token.line;
    this.col = token.col;
  }
}

export function parse(source: string): QiLProgram {
  const tokens = tokenize(source);
  const parser = new Parser(tokens, source);
  return parser.parseProgram();
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  parseProgram(): QiLProgram {
    const statements: QiLStatement[] = [];
    this.skipTrivia();
    while (!this.atEnd()) {
      statements.push(this.parseStatement());
      this.skipTrivia();
    }
    return { statements, source: this.source };
  }

  // --- statement parsing ---------------------------------------------------

  private parseStatement(): QiLStatement {
    const kw = this.peek();
    if (kw.type !== 'KEYWORD') {
      throw new ParseError(`expected a statement keyword but found "${kw.value || kw.type}"`, kw);
    }
    this.advance(); // consume keyword
    const line = kw.line;
    const col = kw.col;
    const keyword = kw.value;

    let subject: string | undefined;
    let argument: string | undefined;

    // Optional subject IDENT (not a property key).
    if (this.peek().type === 'IDENT' && !this.isPropertyStart(0)) {
      subject = this.advance().value;
    }

    // Optional string argument.
    if (this.peek().type === 'STRING') {
      argument = this.advance().value;
    }

    // Optional trailing dependencies: "-> IDENT" (names a target agent/step).
    // e.g.  RETRIEVE "x" -> research
    let arrowTarget: string | undefined;
    while (this.peek().type === 'ARROW') {
      this.advance();
      const tgt = this.peek();
      if (tgt.type !== 'IDENT' && tgt.type !== 'KEYWORD') {
        throw new ParseError('expected an identifier after "->"', tgt);
      }
      arrowTarget = this.advance().value;
    }

    const properties = this.parseProperties();
    const children = this.parseBlock();

    // The arrow target is surfaced as the agent assignment for the step.
    if (arrowTarget !== undefined) properties['agent'] = arrowTarget;

    const stmt: QiLStatement = {
      keyword,
      properties,
      children,
      line,
      col,
      ...(subject !== undefined ? { subject } : {}),
      ...(argument !== undefined ? { argument } : {}),
    };
    return stmt;
  }

  private parseProperties(): Record<string, Literal> {
    const props: Record<string, Literal> = {};
    while (this.peek().type === 'IDENT' && this.isPropertyStart(0)) {
      const key = this.advance().value;
      const sep = this.peek();
      if (sep.type !== 'COLON' && sep.type !== 'EQUALS') {
        throw new ParseError('expected ":" or "=" after property name', sep);
      }
      this.advance();
      const value = this.parsePropertyValue();
      props[key] = value;
    }
    return props;
  }

  private parsePropertyValue(): Literal {
    const tok = this.peek();
    switch (tok.type) {
      case 'STRING':
        this.advance();
        return tok.value;
      case 'NUMBER':
        this.advance();
        return tok.value.includes('.') ? Number.parseFloat(tok.value) : Number.parseInt(tok.value, 10);
      case 'BOOLEAN':
        this.advance();
        return tok.value === 'true';
      case 'IDENT':
      case 'KEYWORD':
        this.advance();
        return tok.value;
      default:
        throw new ParseError(`expected a value but found "${tok.value || tok.type}"`, tok);
    }
  }

  private parseBlock(): QiLStatement[] {
    if (this.peek().type !== 'LBRACE') return [];
    this.advance(); // consume '{'
    const children: QiLStatement[] = [];
    this.skipTrivia();
    while (this.peek().type !== 'RBRACE') {
      if (this.atEnd()) {
        throw new ParseError('unterminated block — missing "}"', this.peek());
      }
      children.push(this.parseStatement());
      this.skipTrivia();
    }
    this.advance(); // consume '}'
    return children;
  }

  // --- token helpers -------------------------------------------------------

  /** True if token at offset `o` starts a `key: value` / `key = value` pair. */
  private isPropertyStart(o: number): boolean {
    const key = this.peek(o);
    const sep = this.peek(o + 1);
    return key.type === 'IDENT' && (sep.type === 'COLON' || sep.type === 'EQUALS');
  }

  private peek(offset = 0): Token {
    const idx = this.pos + offset;
    if (idx >= this.tokens.length) return this.tokens[this.tokens.length - 1]!;
    return this.tokens[idx]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos]!;
    if (!this.atEnd()) this.pos++;
    return tok;
  }

  private atEnd(): boolean {
    return this.peek().type === 'EOF';
  }

  /** Skip NEWLINE tokens (insignificant). */
  private skipTrivia(): void {
    while (this.peek().type === 'NEWLINE') this.advance();
  }
}
