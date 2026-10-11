import type { IndexedBracket, StructuralIndex } from '../../cursor-doc/structural-index';

type Range = [number, number];
const ignoredRanges = new WeakMap<object, { range: Range; topLevel: boolean }[]>();
const indentGuides = new WeakMap<object, Map<IndexedBracket, boolean>>();

/** Whether a form has a guide anywhere, even when its lines are off-screen. */
export function hasIndentGuide(index: StructuralIndex, opening: IndexedBracket): boolean {
  let cache = indentGuides.get(index.cacheKey);
  if (!cache) {
    cache = new Map();
    indentGuides.set(index.cacheKey, cache);
  }
  if (!cache.has(opening)) {
    const column = index.model.getRowCol(opening.end - 1)[1];
    let found = false;
    for (let line = opening.line + 1; opening.pair && line <= opening.pair.line; line++) {
      if (index.model.lines[line].text.match(/^ */)[0].length >= column) {
        found = true;
        break;
      }
    }
    cache.set(opening, found);
  }
  return cache.get(opening);
}

function ignores(index: StructuralIndex) {
  let result = ignoredRanges.get(index.cacheKey);
  if (!result) {
    result = index.ignores.map(({ offset, topLevel }) => {
      const cursor = index.model.getTokenCursor(offset);
      let count = 0;
      while (cursor.getToken().type === 'ignore') {
        count++;
        cursor.next();
        cursor.forwardWhitespace();
      }
      for (let i = 0; i < count; i++) {
        cursor.forwardSexp(true, true, true);
      }
      return { range: [offset, cursor.offsetStart] as Range, topLevel };
    });
    ignoredRanges.set(index.cacheKey, result);
  }
  return result;
}

/** Prepare only visible decorations, retaining off-screen parents and partners. */
export function visibleHighlights(
  index: StructuralIndex,
  ranges: Range[],
  isCommentHead: (head: string) => boolean
) {
  const brackets: { range: Range; depth: number }[] = [];
  const misplaced: Range[] = [];
  const comments: Range[] = [];
  const ignored: Range[] = [];
  const topLevelIgnored: Range[] = [];
  const guidePairs = new Set<IndexedBracket>();
  const seen = new Set<number>();
  const clip = (range: Range, target: Range[]) => {
    for (const visible of ranges) {
      const start = Math.max(range[0], visible[0]);
      const end = Math.min(range[1], visible[1]);
      if (start < end) {
        target.push([start, end]);
      }
    }
  };
  for (const visible of ranges) {
    let ancestor = index.enclosing(visible[0]);
    while (ancestor) {
      if (ancestor.pair && !ancestor.string) {
        guidePairs.add(ancestor);
      }
      ancestor = ancestor.parent;
    }
    for (const bracket of index.visibleBrackets(...visible)) {
      if (bracket.string || seen.has(bracket.offset)) {
        continue;
      }
      seen.add(bracket.offset);
      if (bracket.open) {
        brackets.push({ range: [bracket.readerStart, bracket.end], depth: bracket.depth });
        if (bracket.pair) {
          guidePairs.add(bracket);
        }
      } else if (bracket.pair) {
        brackets.push({ range: [bracket.offset, bracket.end], depth: bracket.depth });
        guidePairs.add(bracket.pair);
      } else {
        misplaced.push([bracket.offset, bracket.end]);
      }
    }
  }
  let commentEnd = -1;
  for (const candidate of index.commentCandidates) {
    if (candidate.readerStart >= commentEnd && candidate.pair && isCommentHead(candidate.head)) {
      clip([candidate.readerStart, candidate.pair.end], comments);
      commentEnd = candidate.pair.end;
    }
  }
  for (const item of ignores(index)) {
    clip(item.range, item.topLevel ? topLevelIgnored : ignored);
  }
  return { brackets, misplaced, comments, ignored, topLevelIgnored, guidePairs };
}
