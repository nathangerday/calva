import type { LineInputModel } from '../../cursor-doc/model';
import { getStructuralIndex } from '../../cursor-doc/structural-index';

type Range = [number, number];

/** Explicit selections, or the closest collection containing an empty cursor.
 * Strings are atoms here. At an opening/closing delimiter, choose that
 * collection; immediately after its closing delimiter, choose its parent.
 */
export function alignRanges(model: LineInputModel, selections: Range[]): Range[] {
  const index = getStructuralIndex(model);
  if (!index) {
    return [];
  }
  const ranges: Range[] = [];
  for (const [anchor, active] of selections) {
    if (anchor !== active) {
      const start = Math.min(anchor, active);
      const end = Math.max(anchor, active);
      // A selection cutting through a string must not reformat its contents
      // as code. Opening quotes and the position after a closing quote are safe.
      if (index?.enclosing(start)?.string || index?.enclosing(end)?.string) {
        continue;
      }
      if (
        [start, end].some((offset) => {
          const cursor = model.getTokenCursor(offset);
          return (
            cursor.getToken().type === 'comment' &&
            offset > cursor.offsetStart &&
            offset < cursor.offsetEnd
          );
        })
      ) {
        continue;
      }
      ranges.push([start, end]);
      continue;
    }
    let collection = index?.openingAt(active) ?? index?.enclosing(active);
    while (collection?.string) {
      collection = collection.parent;
    }
    if (collection?.pair) {
      ranges.push([collection.readerStart, collection.pair.end]);
    }
  }
  // Selections can overlap arbitrarily, unlike structurally nested form ranges.
  // Merge their union, including touching ranges, to avoid overlapping edits.
  const merged: Range[] = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push(range);
    }
  }
  return merged;
}
