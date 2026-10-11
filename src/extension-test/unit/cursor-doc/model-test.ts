import * as assert from 'assert';
import * as model from '../../../cursor-doc/model';

model.initScanner(20000);

describe('LineInputModel large multiline changes', function () {
  this.timeout(20000);

  for (const eol of ['\n', '\r\n']) {
    it(`loads and navigates 200,000 lines with ${JSON.stringify(eol)}`, () => {
      const text = '[' + Array(200000).fill('item').join(eol) + ']';
      const input = new model.StringDocument(text).model;
      input.flushChanges();
      assert.strictEqual(input.lines.length, 200000);
      assert.strictEqual(input.getText(0, text.length), text);
      for (const row of [0, 100000, 199999]) {
        const offset = row === 0 ? 0 : 1 + row * (4 + eol.length);
        assert.strictEqual(input.getOffsetForLine(row), offset);
        assert.deepStrictEqual(input.getRowCol(offset), [row, 0]);
      }
      const cursor = input.getTokenCursor(0);
      assert.ok(cursor.forwardSexp());
      assert.strictEqual(cursor.offsetStart, text.length);
      input.insertString(input.getOffsetForLine(100000), 'x');
      input.flushChanges();
      assert.strictEqual(input.getLineText(100000), 'xitem');
    });

    it(`replaces an interior range with 200,000 lines with ${JSON.stringify(eol)}`, () => {
      const original = ['{:before 1', ' :items [old', ' value]', ' :after 2}'].join(eol);
      const input = new model.StringDocument(original).model;
      input.flushChanges();
      // Build structural state before replacing the range, so stale pairing
      // and positions are also detected after a large paste.
      assert.ok(input.getTokenCursor(0).forwardSexp());
      const start = original.indexOf('old');
      const end = original.indexOf('value') + 'value'.length;
      const inserted = Array(200000).fill('item').join(eol);
      input.editNow([new model.ModelEdit('changeRange', [start, end, inserted])], {});
      input.flushChanges();
      const expected = original.slice(0, start) + inserted + original.slice(end);
      assert.strictEqual(input.lines.length, 200002);
      assert.strictEqual(input.getText(0, expected.length), expected);
      assert.deepStrictEqual(input.getRowCol(start), [1, ' :items ['.length]);
      assert.deepStrictEqual(input.getRowCol(start + inserted.length), [200000, 4]);
      const cursor = input.getTokenCursor(0);
      assert.ok(cursor.forwardSexp());
      assert.strictEqual(cursor.offsetStart, expected.length);
      input.editNow(
        [
          new model.ModelEdit('changeRange', [
            start,
            start + inserted.length,
            original.slice(start, end),
          ]),
        ],
        {}
      );
      input.flushChanges();
      assert.strictEqual(input.getText(0, original.length), original);
      assert.strictEqual(input.lines.length, 4);
    });
  }
});

describe('LineInputModel line offsets', () => {
  it('forks cached tokens without sharing mutable line state or offsets', () => {
    const text = '[a\nb]\n(c)';
    const original = new model.StringDocument(text).model;
    original.flushChanges();
    const lastOffset = original.getOffsetForLine(2);
    const lines = original.lines.map((line) => ({ ...line }));
    const copy = original.fork();
    assert.strictEqual(copy.lines[1].tokens, original.lines[1].tokens);
    copy.insertString(1, '"\n');
    copy.flushChanges();
    assert.strictEqual(original.getText(0, text.length), text);
    assert.strictEqual(original.getOffsetForLine(2), lastOffset);
    assert.deepStrictEqual(
      original.lines.map((line) => ({ ...line })),
      lines
    );
    const fresh = new model.StringDocument(copy.lines.map((line) => line.text).join('\n')).model;
    fresh.flushChanges();
    assert.deepStrictEqual(copy.lines, fresh.lines);
  });

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

describe('LineInputModel incremental tokenization', () => {
  it('does not re-tokenize already constructed lines on the first flush', () => {
    const input = new model.StringDocument(Array(1000).fill('(a "text")').join('\n')).model;
    let relexed = 0;
    for (const line of input.lines) {
      const processLine = line.processLine;
      line.processLine = function (state) {
        relexed++;
        processLine.call(this, state);
      };
    }
    input.flushChanges();
    assert.strictEqual(relexed, 1);
    input.flushChanges();
    assert.strictEqual(relexed, 1);
  });

  for (const eol of ['\n', '\r\n']) {
    it(`retains fresh lexical states after mixed batched edits with ${JSON.stringify(eol)}`, () => {
      const input = new model.StringDocument(
        ['(a "multi', 'line") ; comment', '#"regex" [1]'].join(eol)
      ).model;
      let seed = 71;
      const random = (n: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % n;
      };
      const snapshot = (m: model.LineInputModel) =>
        m.lines.map((line) => ({
          text: line.text,
          startState: line.startState,
          endState: line.endState,
          tokens: line.tokens,
        }));
      for (let step = 0; step < 300; step++) {
        const row = random(input.lines.length);
        const offset = input.getOffsetForLine(row) + random(input.lines[row].text.length + 1);
        const inserted = ['"', ';', eol, `x${eol}"`, '\\"', ')', '😀', ''][random(8)];
        input.insertString(offset, inserted);
        if (step % 3 === 0) {
          input.flushChanges();
          const fresh = new model.StringDocument(input.lines.map((line) => line.text).join(eol))
            .model;
          fresh.flushChanges();
          assert.deepStrictEqual(snapshot(input), snapshot(fresh), `step ${step}`);
        }
      }
    });
  }
});
