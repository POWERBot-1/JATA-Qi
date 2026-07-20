// Text chunking. Produces chunks with accurate character offsets, respects
// paragraph/sentence boundaries when possible, and supports overlap carry-over.

import type { Chunk } from './types.js';

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  strategy?: 'paragraph' | 'sentence' | 'fixed';
}

const DEFAULT_CHUNK_SIZE = 800;

export function chunkText(text: string, documentId: string, opts: ChunkOptions = {}): Omit<Chunk, 'id'>[] {
  const size = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  let overlap = opts.chunkOverlap ?? Math.floor(size * 0.1);
  const strategy = opts.strategy ?? 'paragraph';
  if (size <= 0) throw new Error('chunker: chunkSize must be positive');
  overlap = Math.max(0, Math.min(overlap, size - 1));
  if (!text) return [];

  // Build a list of preferred break end-offsets into `text`, sorted ascending.
  // Always include 0 and text.length as sentinels.
  const breaks = computeBreakpoints(text, strategy, size);
  const chunks: Omit<Chunk, 'id' | 'documentId'>[] = [];
  let chunkIdx = 0;

  // Current window starts at `start`. We greedily extend to the largest break
  // endpoint <= start + size. Overlap is implemented by moving the next start
  // back by `overlap` chars and then aligning forward to the next break (or
  // word boundary) so we don't split in the middle of a word.
  let start = 0;
  while (start < text.length) {
    // Skip leading whitespace.
    while (start < text.length && /\s/.test(text[start]!)) start++;
    if (start >= text.length) break;

    const maxEnd = Math.min(text.length, start + size);
    // Find the rightmost break <= maxEnd. We require end > start; otherwise force cut.
    let end = findLE(breaks, maxEnd);
    if (end <= start) end = maxEnd;
    // If end lands mid-word (no whitespace just before it), back up to last word boundary.
    if (end < text.length && end > start && !/\s/.test(text[end - 1]!)) {
      const wb = findWordBoundary(text, start, end);
      if (wb > start) end = wb;
    }
    // Trim trailing whitespace from chunk window.
    let e = end;
    while (e > start && /\s/.test(text[e - 1]!)) e--;
    const piece = text.slice(start, e).trim();
    if (piece) {
      const sOff = start + text.slice(start, e).indexOf(piece);
      chunks.push({
        index: chunkIdx++,
        text: piece,
        startChar: sOff,
        endChar: e,
        tokenEstimate: Math.max(1, Math.round(piece.length / 4)),
      });
    }

    if (end >= text.length) break;

    // Advance: back up by `overlap` chars from `end`, then align to next break/word boundary.
    let nextStart = Math.max(start + 1, end - overlap);
    nextStart = alignForward(text, breaks, nextStart, text.length);
    if (nextStart <= start) nextStart = Math.max(start + 1, end); // force progress
    start = nextStart;
  }

  return chunks.map((c) => ({ ...c, documentId }));
}

/** Returns largest breakpoint <= target; 0 if none. */
function findLE(breaks: number[], target: number): number {
  // Binary search.
  let lo = 0, hi = breaks.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid]! <= target) { best = breaks[mid]!; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/** Returns a start position ≥ start that is either a breakpoint or a word boundary.
 *  When no forward breakpoint is nearby (e.g. in no-whitespace text), returns start. */
function alignForward(text: string, breaks: number[], start: number, _maxPos: number): number {
  for (const b of breaks) {
    if (b >= start) return b;
  }
  // Advance to next whitespace, else stay.
  let i = start;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function computeBreakpoints(text: string, strategy: 'paragraph' | 'sentence' | 'fixed', size: number): number[] {
  const set = new Set<number>();
  set.add(0);
  set.add(text.length);
  if (strategy === 'paragraph') {
    const re = /\n\s*\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) set.add(m.index + m[0].length);
  } else if (strategy === 'sentence') {
    const re = /[^.!?\n]+[.!?]+(?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) set.add(m.index + m[0].length);
  }
  let hasWordBreak = false;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) { set.add(i + 1); hasWordBreak = true; }
  }
  // For fixed strategy or whitespace-sparse text, add hard size breakpoints.
  if (strategy === 'fixed' || !hasWordBreak) {
    for (let p = size; p < text.length; p += size) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

function findWordBoundary(text: string, start: number, desired: number): number {
  if (desired >= text.length) return text.length;
  let sp = desired;
  while (sp > start && !/\s/.test(text[sp - 1]!)) sp--;
  return sp > start ? sp : desired;
}
