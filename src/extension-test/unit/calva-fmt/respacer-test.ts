import * as expectLib from 'expect';
import * as respacer from '../../../calva-fmt/src/respacer';
import * as model from '../../../cursor-doc/model';
import * as textNotation from '../common/text-notation';
import * as assert from 'assert';
import { performance } from 'perf_hooks';

model.initScanner(20000);

describe('respacer', () => {
  it('aligns a large EDN map without blocking for seconds', () => {
    const previousText = `{\n${Array.from(
      { length: 12000 },
      (_, i) => ` :key${i} {:code ${i} :children [1 2 3]}`
    ).join('\n')}\n}`;
    const formattedText = previousText.replace(/^ /gm, '  ');
    const startedAt = performance.now();
    const edits = respacer.whitespaceEdits('\n', 0, previousText, formattedText);
    const elapsedMs = performance.now() - startedAt;
    // Reconstruct in one pass so the assertion does not add quadratic work.
    const parts: string[] = [];
    let offset = 0;
    for (const edit of [...edits].reverse()) {
      assert.ok(edit.start >= offset);
      parts.push(previousText.slice(offset, edit.start), edit.text);
      offset = edit.end;
    }
    parts.push(previousText.slice(offset));
    assert.strictEqual(parts.join(''), formattedText);
    assert.ok(elapsedMs < 1000, `whitespace alignment took ${elapsedMs.toFixed(0)}ms`);
  });

  it('Inserts formatting space at the beginning', () => {
    const actual = textNotation.docFromTextNotation('(def| foo 42)');
    const expected = textNotation.docFromTextNotation('  (def| foo 42)');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Inserts formatting space at the middle', () => {
    const actual = textNotation.docFromTextNotation('(def foo|[42])');
    const expected = textNotation.docFromTextNotation('  (def foo |[42])');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Inserts formatting space at the end', () => {
    const actual = textNotation.docFromTextNotation('(def foo| [42])');
    const expected = textNotation.docFromTextNotation('(def foo| [42])  ');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Removes formatting space from the beginning', () => {
    const actual = textNotation.docFromTextNotation('  (def foo| 42)');
    const expected = textNotation.docFromTextNotation('(def foo| 42)');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Removes formatting space from the middle', () => {
    const actual = textNotation.docFromTextNotation('(def foo|  42)');
    const expected = textNotation.docFromTextNotation('(def foo| 42)');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Resizes formatting space in the middle', () => {
    const actual = textNotation.docFromTextNotation('(def•foo| 42)');
    const expected = textNotation.docFromTextNotation('(def•  foo| 42)');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Inserts, deletes, and resizes formatting space throughout', () => {
    const actual = textNotation.docFromTextNotation('  (def•foo|  42)');
    const expected = textNotation.docFromTextNotation('(def•  foo| 42)  ');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Preserves multiple cursors amidst formatting-space alterations', () => {
    const actual = textNotation.docFromTextNotation('  |(def•f|2oo|3  42)');
    const expected = textNotation.docFromTextNotation('|(def•  f|2oo|3 42  )');
    const spaceEdits = respacer.whitespaceEdits(
      '\n',
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Keeps the cursor on the same line when adjusting whitespace', () => {
    const actual = textNotation.docFromTextNotation('(foo•|•:a)');
    const expected = textNotation.docFromTextNotation('(foo•  |•:a)');
    const eol = actual.model.lineEnding;
    const spaceEdits = respacer.whitespaceEdits(
      eol,
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
  it('Reformats but may lose cursors if document text changes', () => {
    const actual = textNotation.docFromTextNotation(';;a•(foo••:a)');
    const expected = textNotation.docFromTextNotation(';;bbb•(foo•  •:a)');
    const eol = actual.model.lineEnding;
    const spaceEdits = respacer.whitespaceEdits(
      eol,
      0,
      textNotation.getText(actual),
      textNotation.getText(expected)
    );
    actual.model.editNow(
      spaceEdits.map((se) => new model.ModelEdit('changeRange', [se.start, se.end, se.text])),
      { skipFormat: true }
    );
    expectLib
      .expect(textNotation.textNotationFromDoc(actual))
      .toEqual(textNotation.textNotationFromDoc(expected));
  });
});
