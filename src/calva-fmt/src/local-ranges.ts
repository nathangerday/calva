import type { LineInputModel, ModelEdit, ModelEditFunction } from '../../cursor-doc/model';
import {
  getStructuralIndex,
  IndexedBracket,
  StructuralIndex,
} from '../../cursor-doc/structural-index';

export type FormatRange = [number, number];
export const LARGE_FORMAT_RANGE = 20000;

/** Ranges touched by a batch, in coordinates after all replacements. */
export function postEditChangedRanges(
  edits: ModelEdit<ModelEditFunction>[],
  eol?: string
): FormatRange[] {
  const length = (text: string) => (eol ? text.replace(/\r\n|\r|\n/g, eol) : text).length;
  let delta = 0;
  return edits
    .map((edit) => {
      const [a, b, text] = edit.args as [number, number | string, string];
      return edit.editFn === 'insertString'
        ? { start: a, end: a, length: length(b as string) }
        : edit.editFn === 'deleteRange'
        ? { start: a, end: a + (b as number), length: 0 }
        : { start: Math.min(a, b as number), end: Math.max(a, b as number), length: length(text) };
    })
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, length }): FormatRange => {
      const result: FormatRange = [start + delta, start + delta + length];
      delta += length - (end - start);
      return result;
    });
}

/** Merge overlapping plans before formatting, preserving independent adjacent forms. */
export function mergeFormatRanges(ranges: FormatRange[]): FormatRange[] {
  const result: FormatRange[] = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    const previous = result[result.length - 1];
    if (previous && range[0] < previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      result.push([...range]);
    }
  }
  return result;
}

type Child = { range: FormatRange; firstLine: number; lastLine: number };
const childIndexes = new WeakMap<StructuralIndex, Map<IndexedBracket, Child[]>>();

function children(index: StructuralIndex, opening: IndexedBracket): Child[] {
  let cache = childIndexes.get(index);
  if (!cache) {
    cache = new Map();
    childIndexes.set(index, cache);
  }
  let result = cache.get(opening);
  if (!result) {
    result = [];
    let cursor = index.model.getTokenCursor(opening.offset);
    cursor.next();
    while (!cursor.atEnd()) {
      cursor.forwardWhitespace();
      if (cursor.offsetStart >= opening.pair.offset) {
        break;
      }
      const start = cursor.offsetStart;
      const firstLine = cursor.line;
      const pair = index.byOffset.get(start)?.pair;
      if (pair) {
        // This root has already passed scoped safety checks. Reader syntax in
        // an independent root need not force a token walk through this child.
        cursor = index.model.getTokenCursor(pair.end);
      } else if (!cursor.forwardSexp()) {
        break;
      }
      result.push({ range: [start, cursor.offsetStart], firstLine, lastLine: cursor.line });
    }
    cache.set(opening, result);
  }
  return result;
}

/** Local on-type windows in large data collections. Whole-list context and
 * alignment remain full-format jobs. Windows include whole children, the rest
 * of their starting line, and a following sibling to retain indentation effects.
 */
export function localFormatRanges(
  model: LineInputModel,
  ranges: FormatRange[],
  changed: FormatRange[],
  config: Record<string, any>
): FormatRange[] {
  const index = getStructuralIndex(model);
  const options = config['cljfmt-options'] ?? {};
  if (
    !index?.balanced ||
    options['indentation?'] === false ||
    [
      'align-associative?',
      'align-map-columns?',
      'align-form-columns?',
      'split-keypairs-over-multiple-lines?',
    ].some((key) => config[key] || options[key])
  ) {
    return ranges;
  }
  return mergeFormatRanges(
    ranges.flatMap((range) => {
      const opening = index.byOffset.get(range[0]);
      if (
        range[1] - range[0] < LARGE_FORMAT_RANGE ||
        !opening?.pair ||
        !index.formattingSafe(opening) ||
        opening.pair.end !== range[1] ||
        !['{', '[', '#{'].includes(opening.raw)
      ) {
        return [range];
      }
      const affected = changed.filter(([start, end]) => start <= range[1] && end >= range[0]);
      // Changes to collection delimiters or their position affect all children.
      if (
        !affected.length ||
        affected.some(([start, end]) => start < opening.end || end > opening.pair.offset)
      ) {
        return [range];
      }
      const items = children(index, opening);
      if (!items.length) {
        return [range];
      }
      const windows = affected.map(([start, end]): FormatRange => {
        const firstLine = model.getRowCol(start)[0];
        const lastLine = model.getRowCol(end)[0];
        let first = items.findIndex((item) => item.lastLine >= firstLine);
        if (first < 0) {
          first = items.length - 1;
        }
        // Retain a preceding sibling and its line's context (e.g. a map key).
        first = Math.max(0, first - 1);
        while (first > 0 && items[first - 1].lastLine >= items[first].firstLine) {
          first--;
        }
        let last = first;
        while (last + 1 < items.length && items[last + 1].firstLine <= lastLine) {
          last++;
        }
        last = Math.min(items.length - 1, last + 1);
        while (last + 1 < items.length && items[last + 1].firstLine <= items[last].lastLine) {
          last++;
        }
        return [items[first].range[0], items[last].range[1]];
      });
      const merged = mergeFormatRanges(windows);
      return merged.every(([a, b]) => {
        const text = model.getText(a, b);
        // Blank-line cursor indentation requires the complete parent context.
        return (
          model.getRowCol(a)[1] === model.getRowCol(opening.offset)[1] + opening.raw.length &&
          text.trim() === text &&
          !text.split(/\r?\n/).some((line) => /^[\s,]*$/.test(line))
        );
      }) && merged.reduce((size, [a, b]) => size + b - a, 0) < (range[1] - range[0]) * 0.75
        ? merged
        : [range];
    })
  );
}
