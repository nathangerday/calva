import * as assert from 'assert';
import * as model from '../../../cursor-doc/model';
import * as paredit from '../../../cursor-doc/paredit';
import * as formatIndex from '../../../calva-fmt/src/format-index';
import { formatLocalFragment } from '../../../calva-fmt/src/format-fragment';
import {
  localFormatRanges,
  mergeFormatRanges,
  postEditChangedRanges,
} from '../../../calva-fmt/src/local-ranges';
import * as respacer from '../../../calva-fmt/src/respacer';
import * as cljsLib from '../../../../out/cljs-lib/cljs-lib';

model.initScanner(20000);
const options =
  '{:remove-surrounding-whitespace? true :remove-trailing-whitespace? true :remove-consecutive-blank-lines? false :insert-missing-whitespace? true :align-associative? false}';
const config = {
  'cljfmt-options-string': options,
  'cljfmt-options': cljsLib.cljfmtOptionsFromString(options),
  'comment-form?': false,
};

function assertLocalOutput(text: string, changed: [number, number][], eol = '\n') {
  const doc = new model.StringDocument(text);
  doc.model.flushChanges();
  const range: [number, number] = [0, text.length];
  const indexes = changed.map(([, end]) => end);
  const windows = localFormatRanges(doc.model, [range], changed, config);
  const whole = formatIndex.formatIndexes(text, range, indexes, eol, true, config)['range-text'];
  let result = text;
  const changes = windows
    .flatMap(([start, end]) => {
      const fragment = text.slice(start, end);
      const formatted =
        start === 0 && end === text.length
          ? whole
          : formatLocalFragment(
              fragment,
              doc.model.getRowCol(start)[1],
              indexes.filter((p) => p >= start && p < end).map((p) => p - start),
              eol,
              true,
              config
            );
      return respacer.whitespaceEdits(eol, start, fragment, formatted);
    })
    .sort((a, b) => b.start - a.start);
  for (const change of changes) {
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  assert.strictEqual(result, whole);
  return windows;
}

function largeMapWithMiddle(middle: string) {
  const filler = (prefix: string) =>
    Array.from({ length: 400 }, (_, i) => ` :${prefix}${i} {:name "entry ${i}" :value ${i}}`).join(
      '\n'
    );
  return `{${filler('a').slice(1)}\n${middle}\n${filler('z')}}`;
}

describe('Local post-edit formatting', () => {
  it('translates changed ranges across a multi-cursor batch', () => {
    const edits = [
      new model.ModelEdit('insertString', [10, 'xyz']),
      new model.ModelEdit('deleteRange', [2, 3]),
    ];
    assert.deepStrictEqual(postEditChangedRanges(edits), [
      [2, 2],
      [7, 10],
    ]);
  });

  for (const middle of [
    ' :prev "x"\n\n :target [1 2 3 9]\n\n :next 4',
    ' :prev "x"\n , , \n :target [1 2 3 9]\n :next 4',
    '   :prev "x"\n :target [1 2 3 9]\n :next 4',
  ]) {
    it(`retains parent context for blank lines and misindented siblings: ${JSON.stringify(
      middle
    )}`, () => {
      const text = largeMapWithMiddle(middle);
      const end = text.indexOf('3 9]') + 3;
      assert.deepStrictEqual(assertLocalOutput(text, [[end - 2, end]]), [[0, text.length]]);
    });
  }

  it('includes multiline siblings sharing the first or last window line', () => {
    const text = largeMapWithMiddle(
      ' :a {:x 1\n     :y 2} :b [10\n               20]\n :target [1 2 3 9]\n :next {:x 1\n        :y 2} :last [10\n                       20]\n :after 4'
    );
    const end = text.indexOf('3 9]') + 3;
    const windows = assertLocalOutput(text, [[end - 2, end]]);
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0][0], text.indexOf(':a {:x'));
    assert.strictEqual(windows[0][1], text.indexOf('20]\n :after') + 3);
    assert.ok(windows[0][1] - windows[0][0] < text.length / 10);
  });

  it('normalizes mixed insertion and replacement line endings before mapping changed ranges', () => {
    const edits = [
      new model.ModelEdit('changeRange', [20, 22, 'x\ry\nz\r\nw']),
      new model.ModelEdit('insertString', [10, 'a\nb']),
    ];
    assert.deepStrictEqual(postEditChangedRanges(edits, '\r\n'), [
      [10, 14],
      [24, 34],
    ]);
    assert.deepStrictEqual(postEditChangedRanges(edits, '\n'), [
      [10, 13],
      [23, 30],
    ]);
  });

  it('formats every multiline insertion in a CRLF multi-cursor batch', () => {
    const eol = '\r\n';
    const before = `{${Array.from({ length: 2200 }, (_, i) => `:k${i} ${i}`).join(`${eol} `)}}`;
    const sites = Array.from({ length: 20 }, (_, i) => before.indexOf(`:k${100 + i * 90} `)).sort(
      (a, b) => b - a
    );
    const inserted = ':new [1\n2\n3]\n ';
    const normalized = inserted.replace(/\n/g, eol);
    const edits = sites.map((p) => new model.ModelEdit('insertString', [p, inserted]));
    let text = before;
    for (const site of sites) {
      text = text.slice(0, site) + normalized + text.slice(site);
    }
    const expected = [...sites]
      .reverse()
      .map((p, i): [number, number] => [
        p + i * normalized.length,
        p + (i + 1) * normalized.length,
      ]);
    const changed = postEditChangedRanges(edits, eol);
    assert.deepStrictEqual(changed, expected);
    const windows = assertLocalOutput(text, changed, eol);
    assert.ok(windows.reduce((size, [a, b]) => size + b - a, 0) < text.length / 10);
  });

  it('merges nested and intersecting plans without merging independent adjacent forms', () => {
    assert.deepStrictEqual(
      mergeFormatRanges([
        [8, 12],
        [1, 9],
        [2, 5],
        [12, 18],
      ]),
      [
        [1, 12],
        [12, 18],
      ]
    );
  });

  it('retains full context for multiline strings, readers, metadata and disabled indentation', () => {
    for (const child of ['"first\nsecond"', '#tag [1 2]', '^:m [1 2]', '#_ [1 2]']) {
      const text = `[${child} ${' [1 2]'.repeat(4000)}]`;
      const doc = new model.StringDocument(text);
      doc.model.flushChanges();
      const range: [number, number] = [0, text.length];
      assert.deepStrictEqual(localFormatRanges(doc.model, [range], [[2, 2]], config), [range]);
    }
    const text = `[${' [1 2]'.repeat(4000)}]`;
    const doc = new model.StringDocument(text);
    doc.model.flushChanges();
    const range: [number, number] = [0, text.length];
    assert.deepStrictEqual(
      localFormatRanges(doc.model, [range], [[2, 2]], {
        ...config,
        'cljfmt-options': { 'indentation?': false },
      }),
      [range]
    );
  });

  for (const scenario of ['single', 'multi', 'comments']) {
    for (const command of [
      paredit.forwardSlurpSexp,
      paredit.backwardSlurpSexp,
      paredit.forwardBarfSexp,
      paredit.backwardBarfSexp,
    ]) {
      for (const kind of ['map', 'vector', 'set']) {
        for (const eol of ['\n', '\r\n']) {
          it(`preserves whole-collection output after ${
            command.name
          } in a ${kind} with ${JSON.stringify(eol)} and ${scenario}`, async () => {
            const entries = Array.from(
              { length: 500 },
              (_, i) =>
                `${
                  kind === 'map' ? `"key${i}" ` : ''
                }{:id ${i},${eol} :children [1 2],${eol} :following [3 4]}${
                  scenario === 'comments' ? `${eol}; entry comment${eol}` : ''
                }`
            );
            const [open, close] =
              kind === 'map' ? ['{', '}'] : kind === 'vector' ? ['[', ']'] : ['#{', '}'];
            const raw = `${open}${eol}${entries.join(eol)}${eol}${close}`;
            const canonical = formatIndex.formatIndexes(
              raw,
              [0, raw.length],
              [],
              eol,
              true,
              config
            )['range-text'];
            const doc = new model.StringDocument(canonical);
            const position = canonical.indexOf(':children [') + ':children ['.length;
            doc.selections = [new model.ModelEditSelection(position)];
            if (scenario !== 'single') {
              const other =
                canonical.indexOf(':children [', Math.floor(canonical.length / 2)) +
                ':children ['.length;
              doc.selections.push(new model.ModelEditSelection(other));
            }
            let edits: model.ModelEdit<model.ModelEditFunction>[];
            const originalEdit = doc.model.edit.bind(doc.model);
            doc.model.edit = (batch, options) => {
              edits = batch;
              return originalEdit(batch, options);
            };
            await command(doc);
            doc.model.flushChanges();
            const text = doc.model.lines.map((line) => line.text).join(eol);
            const range: [number, number] = [0, text.length];
            const windows = localFormatRanges(
              doc.model,
              [range],
              postEditChangedRanges(edits),
              config
            );
            if (scenario === 'comments') {
              assert.deepStrictEqual(windows, [range]);
            } else {
              assert.ok(windows.reduce((size, [a, b]) => size + b - a, 0) < text.length / 10);
            }
            const indexes = doc.selections.map((s) => s.active);
            const whole = formatIndex.formatIndexes(text, range, indexes, eol, true, config)[
              'range-text'
            ];
            let result = text;
            const changes = windows
              .flatMap(([start, end]) => {
                const fragment = text.slice(start, end);
                const formatted = formatLocalFragment(
                  fragment,
                  doc.model.getRowCol(start)[1],
                  indexes.filter((p) => p >= start && p < end).map((p) => p - start),
                  eol,
                  true,
                  config
                );
                return respacer.whitespaceEdits(eol, start, fragment, formatted);
              })
              .sort((a, b) => b.start - a.start);
            for (const change of changes) {
              result = result.slice(0, change.start) + change.text + result.slice(change.end);
            }
            assert.strictEqual(result, whole);
            assert.deepStrictEqual(localFormatRanges(doc.model, [range], [[0, 1]], config), [
              range,
            ]);
            assert.deepStrictEqual(
              localFormatRanges(doc.model, [range], [[position, position]], {
                ...config,
                'align-associative?': true,
              }),
              [range]
            );
          });
        }
      }
    }
  }
});
