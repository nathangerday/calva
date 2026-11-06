import * as assert from 'assert';
import { StringDocument, initScanner } from '../../../cursor-doc/model';
import { alignRanges } from '../../../calva-fmt/src/align-ranges';

initScanner(20000);

function ranges(text: string, selections: [number, number][]) {
  const model = new StringDocument(text).model;
  model.flushChanges();
  return alignRanges(model, selections);
}

describe('Recursive alignment scope', () => {
  for (const eol of ['\n', '\r\n']) {
    it(`chooses the nearest map, vector and list with ${JSON.stringify(eol)}`, () => {
      const text = `{:outer [${eol} {:inner (f :value)}]}`;
      const listStart = text.indexOf('(f');
      const listEnd = text.indexOf(')') + 1;
      assert.deepStrictEqual(ranges(text, [[listStart + 3, listStart + 3]]), [
        [listStart, listEnd],
      ]);
      const mapStart = text.indexOf('{:inner');
      const mapEnd = text.indexOf('}') + 1;
      assert.deepStrictEqual(ranges(text, [[mapStart + 3, mapStart + 3]]), [[mapStart, mapEnd]]);
      const vectorStart = text.indexOf('[');
      const vectorEnd = text.indexOf(']') + 1;
      assert.deepStrictEqual(ranges(text, [[vectorStart + 1, vectorStart + 1]]), [
        [vectorStart, vectorEnd],
      ]);
    });
  }

  it('skips strings and regular expressions when finding a collection', () => {
    const text = '[{:a "literal [brackets]" :b #"regex"}]';
    for (const marker of ['literal', 'brackets', 'regex']) {
      const p = text.indexOf(marker) + 1;
      assert.deepStrictEqual(ranges(text, [[p, p]]), [[1, text.length - 1]]);
    }
  });

  it('uses the collection at delimiters and its parent after the closing delimiter', () => {
    const text = '[{:a 1} ]';
    assert.deepStrictEqual(ranges(text, [[1, 1]]), [[1, 7]]);
    assert.deepStrictEqual(ranges(text, [[6, 6]]), [[1, 7]]);
    assert.deepStrictEqual(ranges(text, [[7, 7]]), [[0, text.length]]);
    assert.deepStrictEqual(ranges(text, [[text.length, text.length]]), []);
  });

  it('includes reader prefixes belonging to the nearest collection', () => {
    const text = '[#tag {:a 1} #{:b :c} #:ns{:d 2}]';
    for (const [marker, expected] of [
      [':a', '#tag {:a 1}'],
      [':b', '#{:b :c}'],
      [':d', '#:ns{:d 2}'],
    ]) {
      const p = text.indexOf(marker) + 1;
      assert.deepStrictEqual(ranges(text, [[p, p]]), [
        [text.indexOf(expected), text.indexOf(expected) + expected.length],
      ]);
    }
  });

  it('preserves explicit and reversed selections, without expanding their scope', () => {
    const text = '{:a [1 2] :b {:c 3}}';
    assert.deepStrictEqual(ranges(text, [[5, 7]]), [[5, 7]]);
    assert.deepStrictEqual(ranges(text, [[7, 5]]), [[5, 7]]);
  });

  it('does not format a selection cutting through a string literal as code', () => {
    const text = '["literal  text"]';
    assert.deepStrictEqual(ranges(text, [[2, 8]]), []);
    assert.deepStrictEqual(ranges(text, [[0, 8]]), []);
    assert.deepStrictEqual(ranges(text, [[2, 16]]), []);
    assert.deepStrictEqual(ranges(text, [[1, 16]]), [[1, 16]]);
  });

  it('does not format text selected inside a comment as code', () => {
    const text = '[1 ; comment  text\n 2]';
    assert.deepStrictEqual(ranges(text, [[7, 17]]), []);
  });

  it('merges overlapping, contained and touching scopes while retaining separate ones', () => {
    const text = '[{:a 1} {:b 2} {:c 3}]';
    assert.deepStrictEqual(
      ranges(text, [
        [1, 10],
        [5, 12],
        [12, 14],
        [18, 18],
      ]),
      [
        [1, 14],
        [15, 21],
      ]
    );
    assert.deepStrictEqual(
      ranges(text, [
        [3, 3],
        [4, 4],
        [2, 6],
      ]),
      [[1, 7]]
    );
  });

  it('leaves atoms outside collections and unmatched collections alone', () => {
    assert.deepStrictEqual(
      ranges('foo "bar"', [
        [1, 1],
        [6, 6],
      ]),
      []
    );
    assert.deepStrictEqual(ranges('[{:a 1', [[4, 4]]), []);
  });
});
