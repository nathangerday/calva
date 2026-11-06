import * as assert from 'assert';
import { FormatJob, runFormatJob } from '../../../calva-fmt/src/format-job';
import { initScanner } from '../../../cursor-doc/model';

initScanner(20000);

describe('Shared formatter jobs', () => {
  const invalid: FormatJob = {
    kind: 'range',
    text: '[)',
    range: [0, 2],
    indexes: [],
    eol: '\n',
    onType: false,
    startColumn: 0,
    fullDocument: true,
    config: {},
    scannerMaxLength: 20000,
  };

  it('rejects invalid input when no error handler is provided', () => {
    assert.throws(() => runFormatJob(invalid));
  });

  it('reports a handled formatter error and leaves the input without edits', () => {
    const errors: unknown[] = [];
    const result = runFormatJob(invalid, (error) => errors.push(error));
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0]);
    assert.strictEqual(result.formattedText, invalid.text);
    assert.deepStrictEqual(result.changes, []);
  });

  for (const eol of ['\n', '\r\n']) {
    it(`keeps selection indentation and absolute edit offsets with ${JSON.stringify(eol)}`, () => {
      const prefix = `(do${eol}    `;
      const fragment = `(def a${eol}42)`;
      const original = prefix + fragment + ')';
      const result = runFormatJob({
        ...invalid,
        text: fragment,
        range: [prefix.length, prefix.length + fragment.length],
        eol,
        startColumn: 4,
        fullDocument: false,
      });
      let edited = original;
      for (const change of result.changes) {
        edited = edited.slice(0, change.start) + change.text + edited.slice(change.end);
      }
      assert.strictEqual(edited, `${prefix}(def a${eol}      42))`);
    });
  }
});
