import * as assert from 'assert';
import { StringDocument, initScanner } from '../../../cursor-doc/model';
import { getStructuralIndex } from '../../../cursor-doc/structural-index';
import { visibleHighlights } from '../../../highlight/src/visible';

initScanner(20000);

function indexed(text: string) {
  const model = new StringDocument(text).model;
  model.flushChanges();
  return getStructuralIndex(model);
}

describe('Cached structural index', () => {
  it('indexes nesting, strings, reader prefixes and UTF-16 offsets', () => {
    const text = '#tag [😀 {"key" "[not a bracket]"}]';
    const index = indexed(text);
    const opening = index.openingAt(0);
    assert.strictEqual(opening.readerStart, 0);
    assert.strictEqual(opening.pair.offset, text.length - 1);
    const map = index.byOffset.get(text.indexOf('{'));
    assert.strictEqual(map.parent, opening);
    assert.strictEqual(map.depth, 1);
    const string = index.byOffset.get(text.indexOf('"[not'));
    assert.ok(string.string);
    assert.strictEqual(string.parent, map);
    assert.strictEqual(index.enclosing(text.indexOf('not')), string);
  });

  it('keeps malformed bracket colors and rejects indexed navigation', () => {
    const index = indexed('([)]');
    assert.strictEqual(index.navigationSafe, false);
    const data = visibleHighlights(index, [[0, 4]], () => false);
    assert.deepStrictEqual(data.misplaced, [[2, 3]]);
    assert.deepStrictEqual(
      data.brackets.map((b) => b.depth),
      [0, 1, 1]
    );
  });

  it('reuses the index until an edit, and waits for lexical propagation', () => {
    const index = indexed('[1 "text"]');
    assert.strictEqual(getStructuralIndex(index.model), index);
    index.model.insertString(1, '(');
    assert.strictEqual(getStructuralIndex(index.model), undefined);
    index.model.flushChanges();
    const next = getStructuralIndex(index.model);
    assert.notStrictEqual(next, index);
    assert.strictEqual(next.balanced, false);
  });

  it('jumps backward across a large collection without walking its tokens', () => {
    const text = `[\n${Array.from({ length: 5000 }, (_, i) => `[${i}]`).join('\n')}\n]`;
    const index = indexed(text);
    const cursor = index.model.getTokenCursor(text.length);
    let reads = 0;
    const getPrevToken = cursor.getPrevToken.bind(cursor);
    cursor.getPrevToken = () => {
      reads++;
      return getPrevToken();
    };
    assert.strictEqual(cursor.backwardSexp(), true);
    assert.strictEqual(cursor.offsetStart, 0);
    assert.ok(reads < 10);
  });

  it('answers enclosing lists and top-level ranges at opening and closing boundaries', () => {
    const text = '(a [b] "text")';
    const index = indexed(text);
    const cursor = (offset: number) => index.model.getTokenCursor(offset);
    assert.deepStrictEqual(cursor(text.indexOf('b')).rangeForList(1), [3, 6]);
    assert.deepStrictEqual(cursor(text.indexOf('[')).rangeForList(1), [0, text.length]);
    assert.deepStrictEqual(cursor(text.indexOf(']')).rangeForList(2), [0, text.length]);
    assert.deepStrictEqual(cursor(text.indexOf('text')).rangeForList(1), [7, 13]);
    assert.deepStrictEqual(cursor(4).rangeForDefun(4, false), [0, text.length]);
    assert.strictEqual(cursor(0).atTopLevel(), true);
    assert.strictEqual(cursor(4).atTopLevel(), false);
  });
});

describe('Visible structural highlighting', () => {
  it('bounds bracket painting to the viewport and retains off-screen partners and guides', () => {
    const text = `{\n${Array.from({ length: 2000 }, (_, i) => ` :key${i} [1 2]`).join('\n')}\n}`;
    const index = indexed(text);
    const start = index.model.getOffsetForLine(1000);
    const end = index.model.getOffsetForLine(1020);
    const data = visibleHighlights(index, [[start, end]], () => false);
    assert.strictEqual(data.brackets.length, 40);
    assert.ok(data.brackets.every((b) => b.depth === 1));
    assert.ok(data.guidePairs.has(index.byOffset.get(0)));
    assert.strictEqual(index.openingAt(0).pair.offset, text.length - 1);
  });

  it('clips comments and discarded forms while retaining nesting and custom comment heads', () => {
    const text = '#_ (discard [1])\n(comment (x))\n[(custom y) #_ [2] "{text}"]';
    const index = indexed(text);
    const data = visibleHighlights(index, [[0, text.length]], (head) =>
      ['comment', 'custom'].includes(head)
    );
    assert.deepStrictEqual(data.topLevelIgnored, [[0, text.indexOf('\n')]]);
    assert.strictEqual(data.ignored.length, 1);
    assert.strictEqual(data.comments.length, 2);
    const start = text.indexOf('custom');
    const clipped = visibleHighlights(index, [[start, start + 3]], (head) => head === 'custom');
    assert.deepStrictEqual(clipped.comments, [[start, start + 3]]);
    assert.strictEqual(clipped.brackets.length, 0);
  });
});
