import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { LineInputModel, ModelEdit, StringDocument, initScanner } from '../../../cursor-doc/model';
import { getIndent } from '../../../cursor-doc/indent';
import { newlineInsertion, newlineInsertions } from '../../../calva-fmt/src/newline';
import type { FormatterConfig } from '../../../formatter-config';

initScanner(20000);
const config: FormatterConfig = { 'cljfmt-options': {} };

function plan(notation: string, options = config) {
  const offset = notation.indexOf('|');
  const text = notation.replace('|', '');
  const model = new StringDocument(text).model;
  model.flushChanges();
  return { text, offset, insertion: newlineInsertion(model, offset, options) };
}

describe('newline indentation', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const [notation, expected] of [
      ['(foo |bar |baz)', '(foo \n bar \n baz)'],
      ['[a |[b |c]]', '[a \n [b \n  c]]'],
      ['[a |[b\n |c]]', '[a \n [b\n \n  c]]'],
      ['[|] [|]', '[\n \n] [\n   \n]'],
    ]) {
      it(`plans dependent cursors in ${notation} with ${JSON.stringify(eol)}`, () => {
        const text = notation.replace(/\|/g, '').replace(/\n/g, eol);
        const offsets: number[] = [];
        for (const match of notation.matchAll(/\|/g)) {
          offsets.push(
            notation.slice(0, match.index).replace(/\|/g, '').replace(/\n/g, eol).length
          );
        }
        const model = new LineInputModel(eol.length);
        model.editNow([new ModelEdit('insertString', [0, text])], {});
        model.flushChanges();
        const original = model.lines.map((line) => ({ ...line }));
        const plans = newlineInsertions(model, [...offsets].reverse(), config);
        assert.ok(plans);
        let result = text;
        for (const insertion of [...plans].reverse()) {
          result =
            result.slice(0, insertion.start) +
            insertion.text +
            (insertion.closingText ?? '') +
            result.slice(insertion.end);
        }
        assert.strictEqual(result, expected.replace(/\n/g, eol));
        assert.deepStrictEqual(
          model.lines.map((line) => ({ ...line })),
          original
        );
        assert.strictEqual(model.getText(0, text.length), text);
      });
    }
  }

  it('rejects overlapping batch edits and token splits without modifying the mirror', () => {
    const model = new StringDocument('[   ] symbol').model;
    model.flushChanges();
    assert.strictEqual(newlineInsertions(model, [1, 2], config), undefined);
    assert.strictEqual(newlineInsertions(model, [1, 8], config), undefined);
    assert.strictEqual(model.getText(0, 12), '[   ] symbol');
  });

  it('indents after a multiline map value as a sibling of that map', () => {
    const { insertion } = plan(
      '{\n "502.82" {:code "502.82",\n           :children []},|\n "331.128" {}}'
    );
    assert.strictEqual(insertion.text, '\n ');
  });

  it('matches post-newline indentation for lists, vectors, maps and custom rules', () => {
    const cases = [
      '(|',
      '(foo|',
      '(foo a|',
      '(defn foo [x]|',
      '(let [x 1]|',
      '[\n  a|\n b]',
      '#{a|',
      '{:a []|',
      '{\n :a {\n     :b []},|\n :c []}',
      '(foo (bar)|',
      '(foo\n  |',
      '(foo)\n|',
      '(custom a|',
      '|',
    ];
    const custom: FormatterConfig = {
      'cljfmt-options': { 'extra-indents': { custom: [['block', 1]] } },
    };
    for (const notation of cases) {
      for (const options of [config, custom]) {
        const { text, offset, insertion } = plan(notation, options);
        assert.ok(insertion, notation);
        const after = new StringDocument(text.slice(0, offset) + '\n' + text.slice(offset));
        assert.strictEqual(
          insertion.text,
          '\n' + ' '.repeat(getIndent(after.model, offset + 1, options)),
          notation
        );
      }
    }
  });

  it('retains line-ending conventions and replaces trailing whitespace', () => {
    const model = new LineInputModel(2);
    model.insertString(0, '{\r\n :a [],  \t\r\n :b []}');
    model.flushChanges();
    const start = model.getOffsetForLine(1) + ' :a [],'.length;
    const insertion = newlineInsertion(model, start, config);
    assert.strictEqual(insertion.text, '\r\n ');
    assert.strictEqual(insertion.end, model.getOffsetForLine(1) + model.lines[1].text.length);
  });

  it('keeps VS Code handling for string/comment interiors and token splits', () => {
    for (const notation of [
      '"hello| world"',
      '{:a "hello |\nworld"}',
      '; com|ment',
      '(foo ; com|ment',
      '(fo|o)',
      ':ke|y',
      '\\spa|ce',
      '#"reg|ex"',
      'sym|bol',
    ]) {
      assert.strictEqual(plan(notation).insertion, undefined, notation);
    }
    assert.ok(plan('{:a "closed string"|').insertion);
  });

  it('handles code boundaries on comment lines and the boundaries of comments', () => {
    for (const [notation, indent] of [
      ['(foo |bar) ; c', 1],
      ['(foo |; c', 1],
      ['(foo ; c|', 1],
      ['; comment|', 0],
      ['|; comment', 0],
    ] as [string, number][]) {
      assert.strictEqual(plan(notation).insertion.text, '\n' + ' '.repeat(indent), notation);
    }
  });

  it('does not let the next form determine indentation at a planned split', () => {
    for (const suffix of [' (defn b [] 2)', '          (defn b [] 2)', ' ; comment']) {
      const notation = '(defn a []\n  1)|' + suffix;
      const { text, offset, insertion } = plan(notation);
      assert.strictEqual(insertion.text, '\n', notation);
      if (suffix === ' (defn b [] 2)') {
        // Preserve existing callers; only pre-edit newline planning opts in.
        assert.strictEqual(getIndent(new StringDocument(text).model, offset, config), 5);
      }
    }
  });

  it('preserves sibling indentation after forms longer than the look-back limit', () => {
    const body = Array.from({ length: 25 }, (_, i) => `        (step ${i})`).join('\n');
    const children = Array.from({ length: 25 }, (_, i) => `                       "${i}"`).join(
      '\n'
    );
    for (const [notation, indent] of [
      [`(defn foo []\n  (let [a 1]\n    (doseq [x xs]\n${body})|\n    (println "done")))`, 4],
      [
        `{"1" {:code "1"}\n "2" {:code "2",\n      :children [\n${children}]}|\n "3" {:code "3"}}`,
        1,
      ],
    ] as [string, number][]) {
      const { text, offset, insertion } = plan(notation);
      assert.strictEqual(insertion.text, '\n' + ' '.repeat(indent), notation);
      assert.strictEqual(
        insertion.text,
        '\n' + ' '.repeat(getIndent(new StringDocument(text).model, offset, config)),
        notation
      );
    }
  });

  it('preserves existing line indentation when splitting before a long form sibling', () => {
    const body = Array.from({ length: 25 }, (_, i) => `        (step ${i})`).join('\n');
    const children = Array.from({ length: 25 }, (_, i) => `                       "${i}"`).join(
      '\n'
    );
    for (const [prefix, sibling, indent] of [
      [`(defn foo []\n  (let [a 1]\n    (doseq [x xs]\n${body})\n`, '(println "done")))', 4],
      [`{"1" {:code "1"}\n "2" {:children [\n${children}]},\n`, '"3" {:code "3"}}', 1],
    ] as [string, string, number][]) {
      for (const column of [0, Math.floor(indent / 2), indent]) {
        const notation = prefix + ' '.repeat(column) + '|' + ' '.repeat(indent - column) + sibling;
        const { text, offset, insertion } = plan(notation);
        assert.strictEqual(insertion.text, '\n' + ' '.repeat(indent), notation);
        assert.strictEqual(getIndent(new StringDocument(text).model, offset, config), indent);
      }
    }
  });

  it('ignores the operator moved below a newline immediately after an opener', () => {
    for (const options of [
      config,
      { 'cljfmt-options': { indents: { '#"^\\\\w"': [['inner', 0]] } } } as FormatterConfig,
    ]) {
      for (const notation of ['(|cond a b)', '(defn foo []\n  (|cond a b))', '#(|cond a b)']) {
        const { text, offset, insertion } = plan(notation, options);
        const native = new StringDocument(text.slice(0, offset) + '\n' + text.slice(offset));
        assert.strictEqual(
          insertion.text,
          '\n' + ' '.repeat(getIndent(native.model, offset + 1, options)),
          notation
        );
      }
    }
  });

  it('keeps block-rule expression counts when splitting after a multiline form', () => {
    for (const [notation, indent] of [
      ['(do (foo\n b)| c)', 4],
      ['(when x (foo\n b)| (bar))', 6],
      ['(let [x 1] (foo\n  b)| c)', 5],
    ] as [string, number][]) {
      const { text, offset, insertion } = plan(notation);
      assert.strictEqual(insertion.text, '\n' + ' '.repeat(indent), notation);
      const after = new StringDocument(text.slice(0, offset) + '\n' + text.slice(insertion.end));
      assert.strictEqual(
        insertion.text,
        '\n' + ' '.repeat(getIndent(after.model, offset + 1, config)),
        notation
      );
    }
  });

  it('leaves Vim and Neovim Enter handling active outside insert mode', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8')
    );
    const binding = manifest.contributes.keybindings.find(
      (binding) => binding.command === 'calva-fmt.newline' && binding.key === 'enter'
    );
    assert.ok(binding);
    assert.ok(binding.when.includes("(!vim.active || vim.mode == 'Insert')"));
    assert.ok(binding.when.includes("(!neovim.init || neovim.mode == 'insert')"));
  });

  it('matches post-newline indentation across midline code and custom rules', () => {
    const cases = [
      '(foo bar| baz)',
      '(foo bar |  baz)',
      '(defn f [] x|)',
      '(let [x 1]| (inc x))',
      '(unknown| arg)',
      '(unknown a| b)',
      '(custom a| b)',
      '[|1 2]',
      '{:a 1|, :b 2}',
      '(foo |bar) ; c',
      '(foo |; c',
      '(foo ; c|',
      '{\n "502.82" {:code "502.82",\n           :children ["502.8" |"502.9"]},\n "331.128" {}}',
    ];
    const custom: FormatterConfig = {
      'cljfmt-options': { 'extra-indents': { custom: [['block', 1]] } },
    };
    for (const notation of cases) {
      for (const options of [config, custom]) {
        const { text, offset, insertion } = plan(notation, options);
        assert.ok(insertion, notation);
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        const leading = text.slice(lineStart, offset).match(/^[ \t]*/)[0];
        const nativeText = text.slice(0, offset) + '\n' + leading + text.slice(insertion.end);
        const nativeModel = new StringDocument(nativeText).model;
        assert.strictEqual(
          insertion.text,
          '\n' + ' '.repeat(getIndent(nativeModel, offset + 1 + leading.length, options)),
          notation
        );
      }
    }
  });

  it('splits empty collections with the caret insertion before the closing newline', () => {
    for (const notation of ['[|]', '{|}', '(|)', '#{|}', '#(|)', '(defn f []\n  (|))']) {
      const { text, offset, insertion } = plan(notation);
      assert.ok(insertion?.closingText, notation);
      assert.strictEqual(insertion.end, offset + 1, notation);
      const model = new StringDocument(text).model;
      const [row] = model.getRowCol(offset);
      assert.strictEqual(
        insertion.text,
        '\n' + ' '.repeat(getIndent(model, offset, config)),
        notation
      );
      assert.strictEqual(
        insertion.closingText,
        '\n' + model.lines[row].text.match(/^[ \t]*/)[0] + text[offset],
        notation
      );
    }
  });

  it('retains whitespace on either side of the caret when expanding empty pairs', () => {
    const { insertion } = plan('{\n :children [ \t|  ]}');
    assert.strictEqual(insertion.text, '\n' + ' '.repeat(12));
    assert.strictEqual(insertion.closingText, '\n   ]');
  });

  it('matches structural indentation at ordinary code boundaries and trims right-hand spaces', () => {
    for (const notation of [
      '(foo |bar baz)',
      '(|foo a)',
      '[a |b]',
      '{:a| 1}',
      '{|:a 1}',
      '{:children ["191c" |"191o"]}',
      '{:children [1|]}',
      '(foo|   bar)',
      '[|)',
      '[\n|]',
      '[,|]',
    ]) {
      const { text, offset, insertion } = plan(notation);
      assert.ok(insertion, notation);
      assert.strictEqual(insertion.closingText, undefined, notation);
      const after = new StringDocument(text.slice(0, offset) + '\n' + text.slice(insertion.end));
      assert.strictEqual(
        insertion.text,
        '\n' + ' '.repeat(getIndent(after.model, offset + 1, config)),
        notation
      );
      assert.strictEqual(text.slice(offset, insertion.end).trim(), '', notation);
    }
  });

  it('can keep empty-pair expansion disabled for native autoIndent settings', () => {
    const model = new StringDocument('[  ]').model;
    model.flushChanges();
    const insertion = newlineInsertion(model, 1, config, false);
    assert.deepStrictEqual(insertion, { end: 3, text: '\n ' });
  });

  it('computes the sibling indent deep in a large EDN map', () => {
    const entries = Array.from(
      { length: 6000 },
      (_, i) => ` "${i}" {:code "${i}",\n          :children []},`
    );
    const text = '{\n' + entries.join('\n') + '\n}';
    const model = new StringDocument(text).model;
    model.flushChanges();
    for (const i of [0, 3000, 5999]) {
      const offset = text.indexOf(entries[i]) + entries[i].length;
      assert.strictEqual(newlineInsertion(model, offset, config).text, '\n ');
    }
  });
});
