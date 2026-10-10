import * as assert from 'assert';
import * as model from '../../../cursor-doc/model';

model.initScanner(20000);

describe('LineInputModel line offsets', () => {
  for (const eol of ['\n', '\r\n']) {
    it(`keeps offsets correct after edits with ${JSON.stringify(eol)} line endings`, () => {
      const doc = new model.StringDocument(['abc', '', '😀last'].join(eol));
      const input = doc.model;
      const checkLines = (lines: string[]) => {
        const text = lines.join(eol);
        let offset = 0;
        lines.forEach((line, row) => {
          assert.strictEqual(input.getOffsetForLine(row), offset);
          for (let column = 0; column <= line.length; column++) {
            assert.deepStrictEqual(input.getRowCol(offset + column), [row, column]);
          }
          offset += line.length + eol.length;
        });
        assert.strictEqual(input.maxOffset, offset - 1);
        assert.strictEqual(input.getText(0, text.length), text);
        assert.deepStrictEqual(input.getRowCol(offset + 10), [
          lines.length - 1,
          lines[lines.length - 1].length,
        ]);
      };

      checkLines(['abc', '', '😀last']);
      input.insertString(1, 'LONG');
      checkLines(['aLONGbc', '', '😀last']);
      input.insertString(0, 'first' + eol);
      checkLines(['first', 'aLONGbc', '', '😀last']);
      input.deleteRange(0, 'first'.length + eol.length);
      checkLines(['aLONGbc', '', '😀last']);
      input.deleteRange(2, 'ONGbc'.length + eol.length);
      checkLines(['aL', '😀last']);
      input.insertString(input.getOffsetForLine(1) + 2, eol + 'tail');
      checkLines(['aL', '😀', 'taillast']);
    });
  }

  it('keeps queries and edits near the start independent of the document tail', () => {
    const input = new model.StringDocument(Array(1000).fill('abc').join('\n')).model;
    for (const line of input.lines.slice(500)) {
      Object.defineProperty(line, 'text', {
        get() {
          throw new Error('A query near the start scanned the document tail');
        },
      });
    }
    assert.deepStrictEqual(input.getRowCol(1), [0, 1]);
    input.insertString(0, 'x');
    assert.deepStrictEqual(input.getRowCol(2), [0, 2]);
    assert.strictEqual(input.getOffsetForLine(1), 5);
    assert.deepStrictEqual(input.getRowCol(6), [1, 1]);
  });

  it('preserves the CRLF boundary and out-of-range conventions', () => {
    const input = new model.StringDocument('a\r\nb').model;
    assert.deepStrictEqual(input.getRowCol(-1), [0, -1]);
    assert.deepStrictEqual(input.getRowCol(1), [0, 1]);
    assert.deepStrictEqual(input.getRowCol(2), [1, -1]);
    assert.deepStrictEqual(input.getRowCol(3), [1, 0]);
    assert.deepStrictEqual(input.getRowCol(4), [1, 1]);
    assert.deepStrictEqual(input.getRowCol(5), [1, 1]);
  });
});
