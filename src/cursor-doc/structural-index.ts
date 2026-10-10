import type { LineInputModel } from './model';
import { validPair } from './clojure-lexer';

export interface IndexedBracket {
  offset: number;
  end: number;
  readerStart: number;
  line: number;
  token: number;
  raw: string;
  open: boolean;
  string: boolean;
  depth: number;
  parent?: IndexedBracket;
  pair?: IndexedBracket;
  head?: string;
}

/** Token-derived structure shared by navigation, formatting and highlighting.
 * Offsets use the model's UTF-16 and line-ending conventions. Unbalanced input
 * still has useful bracket/depth data, but must use legacy navigation semantics.
 */
export class StructuralIndex {
  readonly brackets: IndexedBracket[] = [];
  readonly openings: IndexedBracket[] = [];
  readonly byOffset = new Map<number, IndexedBracket>();
  readonly ignores: { offset: number; topLevel: boolean }[] = [];
  readonly commentCandidates: IndexedBracket[] = [];
  balanced = true;
  hasLineComments = false;
  hasMultilineStrings = false;
  private simpleTopLevel = true;

  get navigationSafe() {
    return this.balanced && this.simpleTopLevel;
  }

  constructor(readonly model: LineInputModel) {
    const stack: IndexedBracket[] = [];
    const headSeen = new Set<IndexedBracket>();
    let readerStart: number | undefined;
    let depth = 0;
    for (let line = 0; line < model.lines.length; line++) {
      const base = model.getOffsetForLine(line);
      for (let token = 0; token < model.lines[line].tokens.length; token++) {
        const tk = model.lines[line].tokens[token];
        if (tk.type === 'comment') {
          this.hasLineComments = true;
        }
        if (['ws', 'eol', 'comment', 'prompt'].includes(tk.type)) {
          continue;
        }
        const offset = base + tk.offset;
        const parent = stack[stack.length - 1];
        if (parent && !headSeen.has(parent)) {
          headSeen.add(parent);
          if (parent.raw === '(' && tk.type === 'id') {
            parent.head = tk.raw;
            this.commentCandidates.push(parent);
          }
        }
        if (tk.type === 'reader') {
          readerStart ??= offset;
          this.simpleTopLevel = false;
          continue;
        }
        if (tk.type === 'ignore') {
          this.ignores.push({ offset, topLevel: stack.length === 0 });
          this.simpleTopLevel = false;
        }
        if (tk.raw.startsWith('^')) {
          this.simpleTopLevel = false;
        }
        if (tk.type === 'too-long-line' || tk.type === 'junk') {
          this.balanced = false;
        }
        if (tk.type === 'open' || tk.type === 'close') {
          const isString = tk.raw.endsWith('"');
          const bracket: IndexedBracket = {
            offset,
            end: offset + tk.raw.length,
            readerStart: readerStart ?? offset,
            line,
            token,
            raw: tk.raw,
            open: tk.type === 'open',
            string: isString,
            depth,
            parent,
          };
          this.brackets.push(bracket);
          this.byOffset.set(offset, bracket);
          if (bracket.open) {
            this.openings.push(bracket);
            stack.push(bracket);
            if (!isString) {
              depth++;
            }
          } else if (parent && validPair(parent.raw, tk.raw)) {
            stack.pop();
            bracket.pair = parent;
            parent.pair = bracket;
            if (isString && parent.line !== line) {
              this.hasMultilineStrings = true;
            }
            if (!isString) {
              depth--;
            }
            bracket.depth = depth;
            bracket.parent = parent.parent;
          } else {
            this.balanced = false;
          }
        }
        readerStart = undefined;
      }
    }
    if (stack.length) {
      this.balanced = false;
    }
  }

  /** The list containing a token; an opening token belongs to its parent. */
  enclosing(offset: number): IndexedBracket | undefined {
    let low = 0;
    let high = this.openings.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.openings[mid].offset < offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    let bracket = this.openings[low - 1];
    while (bracket && bracket.pair && bracket.pair.offset < offset) {
      bracket = bracket.parent;
    }
    return bracket;
  }

  topLevelRange(offset: number): [number, number] | undefined {
    if (!this.navigationSafe) {
      return;
    }
    let bracket = this.byOffset.get(offset);
    if (!bracket?.open) {
      bracket = this.enclosing(offset);
    }
    while (bracket?.parent) {
      bracket = bracket.parent;
    }
    if (bracket?.pair && offset >= bracket.offset && offset < bracket.pair.end) {
      return [bracket.offset, bracket.pair.end];
    }
  }

  /** Brackets intersecting a visible interval; no enclosing-form walk. */
  visibleBrackets(start: number, end: number): IndexedBracket[] {
    let low = 0;
    let high = this.brackets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.brackets[mid].end <= start) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const result: IndexedBracket[] = [];
    for (let i = low; i < this.brackets.length && this.brackets[i].readerStart <= end; i++) {
      result.push(this.brackets[i]);
    }
    return result;
  }

  openingAt(offset: number): IndexedBracket | undefined {
    let low = 0;
    let high = this.openings.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.openings[mid].readerStart <= offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const opening = this.openings[low - 1];
    return opening && offset < opening.end ? opening : undefined;
  }
}

const indexes = new WeakMap<LineInputModel, StructuralIndex>();

export function invalidateStructuralIndex(model: LineInputModel) {
  indexes.delete(model);
}

export function getStructuralIndex(model: LineInputModel): StructuralIndex | undefined {
  // A batched edit may still have lexical-state propagation pending.
  if (model.dirtyLines.length) {
    return;
  }
  let index = indexes.get(model);
  if (!index) {
    index = new StructuralIndex(model);
    indexes.set(model, index);
  }
  return index;
}
