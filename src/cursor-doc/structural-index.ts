import type { LineInputModel, TextLine } from './model';
import { Token, validPair } from './clojure-lexer';
import { LinePosition, LinePositions } from './line-positions';

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

type IndexedLine = { tokens: Token[]; bindings: TokenPosition[] };

function signature(token: Token): string | undefined {
  if (['ws', 'eol', 'prompt'].includes(token.type)) {
    return;
  }
  return ['open', 'close'].includes(token.type)
    ? `${token.type}:${token.raw}`
    : `${token.type}:${token.raw.startsWith('^')}`;
}

class TokenPosition {
  headFor?: IndexedBracket;
  bracket?: IndexedBracket;

  constructor(
    public anchor: LinePosition<IndexedLine>,
    public column: number,
    public token: number,
    public ordinal: number
  ) {}

  get offset() {
    return this.anchor.offset + this.column;
  }

  get line() {
    return this.anchor.row;
  }
}

class PositionedBracket implements IndexedBracket {
  pair?: IndexedBracket;
  head?: string;

  constructor(
    readonly position: TokenPosition,
    private readonly reader: TokenPosition,
    readonly raw: string,
    readonly open: boolean,
    readonly string: boolean,
    public depth: number,
    public parent?: IndexedBracket
  ) {}

  get offset() {
    return this.position.offset;
  }
  get end() {
    return this.position.offset + this.raw.length;
  }
  get readerStart() {
    return this.reader.offset;
  }
  get line() {
    return this.position.line;
  }
  get token() {
    return this.position.token;
  }
}

/** Token-derived structure shared by navigation, formatting and highlighting.
 * Offsets use the model's UTF-16 and line-ending conventions. Unbalanced input
 * still has useful bracket/depth data, but must use legacy navigation semantics.
 */
export class StructuralIndex {
  readonly brackets: IndexedBracket[] = [];
  readonly openings: IndexedBracket[] = [];
  readonly byOffset = { get: (offset: number) => this.bracketAt(offset) };
  readonly ignores: { offset: number; topLevel: boolean }[] = [];
  readonly commentCandidates: IndexedBracket[] = [];
  balanced = true;
  hasLineComments = false;
  hasMultilineStrings = false;
  private readonly formatHazards: TokenPosition[] = [];
  private simpleTopLevel = true;
  private readonly lines = new LinePositions<IndexedLine>();
  revision = 0;
  cacheKey = {};

  get navigationSafe() {
    return this.balanced && this.simpleTopLevel;
  }

  constructor(readonly model: LineInputModel) {
    const stack: IndexedBracket[] = [];
    const headSeen = new Set<IndexedBracket>();
    let readerStart: TokenPosition | undefined;
    let depth = 0;
    const anchors = model.lines.map((line) => this.lineNode(line));
    this.lines.splice(0, 0, anchors);
    for (let line = 0; line < model.lines.length; line++) {
      const anchor = anchors[line];
      let ordinal = 0;
      for (let token = 0; token < model.lines[line].tokens.length; token++) {
        const tk = model.lines[line].tokens[token];
        if (['ws', 'eol', 'prompt'].includes(tk.type)) {
          continue;
        }
        const event = ordinal++;
        if (tk.type === 'comment') {
          this.hasLineComments = true;
          this.formatHazards.push(this.position(anchor, event, token, tk.offset));
          continue;
        }
        const parent = stack[stack.length - 1];
        if (parent?.raw === '(' && !headSeen.has(parent)) {
          headSeen.add(parent);
          if (tk.type === 'id') {
            parent.head = tk.raw;
            this.position(anchor, event, token, tk.offset).headFor = parent;
            this.commentCandidates.push(parent);
          }
        }
        if (tk.type === 'reader') {
          readerStart ??= this.position(anchor, event, token, tk.offset);
          this.simpleTopLevel = false;
          this.formatHazards.push(this.position(anchor, event, token, tk.offset));
          continue;
        }
        if (tk.type === 'ignore') {
          const pos = this.position(anchor, event, token, tk.offset);
          this.ignores.push({
            get offset() {
              return pos.offset;
            },
            topLevel: stack.length === 0,
          });
          this.simpleTopLevel = false;
          this.formatHazards.push(pos);
        }
        if (tk.raw.startsWith('^')) {
          this.simpleTopLevel = false;
          this.formatHazards.push(this.position(anchor, event, token, tk.offset));
        }
        if (tk.type === 'too-long-line' || tk.type === 'junk') {
          this.balanced = false;
        }
        if (tk.type === 'open' || tk.type === 'close') {
          const isString = tk.raw.endsWith('"');
          const pos = this.position(anchor, event, token, tk.offset);
          const reader = readerStart ?? pos;
          const bracket = new PositionedBracket(
            pos,
            reader,
            tk.raw,
            tk.type === 'open',
            isString,
            depth,
            parent
          );
          pos.bracket = bracket;
          this.brackets.push(bracket);
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
            if (isString && (parent as PositionedBracket).position.anchor !== anchor) {
              this.hasMultilineStrings = true;
              this.formatHazards.push((parent as PositionedBracket).position);
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
    this.formatHazards.sort((a, b) => a.offset - b.offset);
  }

  private lineNode(line: TextLine): LinePosition<IndexedLine> {
    return this.lines.node(line.text.length + this.model.lineEndingLength, {
      tokens: line.tokens,
      bindings: [],
    });
  }

  private position(
    anchor: LinePosition<IndexedLine>,
    ordinal: number,
    token: number,
    column: number
  ): TokenPosition {
    const bindings = anchor.value.bindings;
    const last = bindings[bindings.length - 1];
    if (last?.ordinal === ordinal) {
      return last;
    }
    const position = new TokenPosition(anchor, column, token, ordinal);
    bindings.push(position);
    return position;
  }

  /** Whitespace and same-kind atom edits retain pairing/depth. Splice only
   * changed token lines and resolve suffix positions through retained anchors.
   * Token-shape changes or lexical-state changes use a complete rebuild.
   */
  updateLines(start: number, deleted: number, inserted: TextLine[]): boolean {
    const old = this.lines.range(start, deleted);
    const nodes = inserted.map((line) => this.lineNode(line));
    const signatures = (line: LinePosition<IndexedLine>) =>
      line.value.tokens.map(signature).filter((value) => value !== undefined);
    const before = old.flatMap(signatures);
    const after = nodes.flatMap(signatures);
    if (before.length !== after.length || before.some((value, i) => value !== after[i])) {
      return false;
    }
    const bindings = new Map<number, TokenPosition>();
    let base = 0;
    for (const node of old) {
      for (const pos of node.value.bindings) {
        bindings.set(base + pos.ordinal, pos);
      }
      base += signatures(node).length;
    }
    const strings = new Map<IndexedBracket, boolean>();
    for (const pos of bindings.values()) {
      const bracket = pos.bracket;
      const opening = bracket?.string ? (bracket.open ? bracket : bracket.pair) : undefined;
      if (opening?.pair) {
        strings.set(opening, opening.line !== opening.pair.line);
      }
    }
    this.lines.splice(start, deleted, nodes);
    let ordinal = 0;
    for (let line = 0; line < inserted.length; line++) {
      let local = 0;
      inserted[line].tokens.forEach((token, tokenIndex) => {
        if (signature(token) !== undefined) {
          const pos = bindings.get(ordinal++);
          if (pos) {
            pos.anchor = nodes[line];
            pos.column = token.offset;
            pos.token = tokenIndex;
            pos.ordinal = local;
            nodes[line].value.bindings.push(pos);
            if (pos.headFor) {
              pos.headFor.head = token.raw;
            }
          }
          local++;
        }
      });
    }
    if (
      [...strings].some(
        ([opening, multiline]) => multiline !== (opening.line !== opening.pair.line)
      )
    ) {
      return false;
    }
    this.revision++;
    this.cacheKey = {};
    return true;
  }

  private bracketAt(offset: number): IndexedBracket | undefined {
    let low = 0;
    let high = this.brackets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.brackets[mid].offset < offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const bracket = this.brackets[low];
    return bracket?.offset === offset ? bracket : undefined;
  }

  /** Keep full context inside a root containing readers, comments or multiline
   * strings. Independent roots elsewhere in the file do not affect this one.
   */
  formattingSafe(opening: IndexedBracket): boolean {
    let root = opening;
    while (root.parent) {
      root = root.parent;
    }
    if (!this.balanced || !root.pair || root.readerStart !== root.offset) {
      return false;
    }
    let low = 0;
    let high = this.formatHazards.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.formatHazards[mid].offset < root.offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (low < this.formatHazards.length && this.formatHazards[low].offset < root.pair.end) {
      return false;
    }
    // Reader/metadata tokens immediately preceding the root belong to its
    // formatting context. A metadata map can precede the target as well.
    const cursor = this.model.getTokenCursor(root.offset);
    cursor.backwardWhitespace();
    cursor.previous();
    if (cursor.getToken().type === 'close') {
      const previous = this.byOffset.get(cursor.offsetStart)?.pair;
      if (previous?.raw.startsWith('^')) {
        return false;
      }
      if (previous?.raw === '{') {
        const before = this.model.getTokenCursor(previous.offset);
        before.backwardWhitespace();
        before.previous();
        if (before.getToken().raw.startsWith('^')) {
          return false;
        }
      }
    }
    const token = cursor.getToken();
    return !['reader', 'ignore'].includes(token.type) && !token.raw.startsWith('^');
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
    // Legacy form selection favors the preceding form at an abutting boundary.
    // Keep its exact semantics for atoms, strings and collection delimiters.
    if (bracket?.open && offset > 0 && !/[\s,]/.test(this.model.getText(offset - 1, offset))) {
      return;
    }
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

export function updateStructuralIndex(
  model: LineInputModel,
  start: number,
  deleted: number,
  inserted: TextLine[]
) {
  const index = indexes.get(model);
  if (index && !index.updateLines(start, deleted, inserted)) {
    indexes.delete(model);
  }
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
