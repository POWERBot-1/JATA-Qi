// QiL lexer — turns source text into a token stream.
//
// QiL is line-oriented and brace-delimited. Newlines are *mostly* insignificant
// (statements are keyword-led and unambiguous), but they are emitted as tokens so
// diagnostics can reference line numbers.

import type { Token, TokenType } from './types.js';

export class LexError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, line: number, col: number) {
    super(`QiL lex error at ${line}:${col} — ${message}`);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

const PUNCT: Record<string, TokenType> = {
  '{': 'LBRACE',
  '}': 'RBRACE',
  ':': 'COLON',
  '=': 'EQUALS',
  ',': 'COMMA',
};

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  const push = (type: TokenType, value: string, l: number, c: number): void => {
    tokens.push({ type, value, line: l, col: c });
  };

  const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_-]/.test(ch);
  const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

  while (i < n) {
    const ch = src[i]!;

    // Newline.
    if (ch === '\n') {
      push('NEWLINE', ch, line, col);
      i++;
      line++;
      col = 1;
      continue;
    }
    // Carriage return (normalize CRLF): skip.
    if (ch === '\r') {
      i++;
      continue;
    }
    // Whitespace.
    if (ch === ' ' || ch === '\t') {
      i++;
      col++;
      continue;
    }
    // Comments: # or // to end of line.
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // Arrow "->".
    if (ch === '-' && src[i + 1] === '>') {
      push('ARROW', '->', line, col);
      i += 2;
      col += 2;
      continue;
    }

    // Single-char punctuation.
    const punct = PUNCT[ch];
    if (punct) {
      push(punct, ch, line, col);
      i++;
      col++;
      continue;
    }

    // String literal.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      let value = '';
      while (i < n && src[i] !== quote) {
        const c = src[i]!;
        if (c === '\\' && i + 1 < n) {
          const next = src[i + 1]!;
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            '"': '"',
            "'": "'",
          };
          value += map[next] ?? next;
          i += 2;
          col += 2;
          continue;
        }
        if (c === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }
        value += c;
        i++;
      }
      if (i >= n) throw new LexError('unterminated string literal', startLine, startCol);
      i++; // closing quote
      col++;
      push('STRING', value, startLine, startCol);
      continue;
    }

    // Number literal.
    if (isDigit(ch)) {
      const startCol = col;
      let num = '';
      while (i < n && isDigit(src[i]!)) {
        num += src[i];
        i++;
        col++;
      }
      if (src[i] === '.' && isDigit(src[i + 1]!)) {
        num += '.';
        i++;
        col++;
        while (i < n && isDigit(src[i]!)) {
          num += src[i];
          i++;
          col++;
        }
      }
      push('NUMBER', num, line, startCol);
      continue;
    }

    // Identifier / keyword / boolean.
    if (isIdentStart(ch)) {
      const startCol = col;
      let ident = '';
      while (i < n && isIdentPart(src[i]!)) {
        // Stop the identifier if we hit a "arrow" so "A -> B" tokenizes as A, ->, B.
        if (src[i] === '-' && src[i + 1] === '>') break;
        ident += src[i];
        i++;
        col++;
      }
      if (ident === 'true' || ident === 'false') {
        push('BOOLEAN', ident, line, startCol);
      } else if (/^[A-Z][A-Z0-9_]*$/.test(ident)) {
        push('KEYWORD', ident, line, startCol);
      } else {
        push('IDENT', ident, line, startCol);
      }
      continue;
    }

    throw new LexError(`unexpected character "${ch}"`, line, col);
  }

  push('EOF', '', line, col);
  return tokens;
}
