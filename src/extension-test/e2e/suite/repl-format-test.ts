import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as formatter from '../../../calva-fmt/src/format';
import * as config from '../../../formatter-config';
import * as cljsLib from '../../../../out/cljs-lib/cljs-lib';
import * as replDocument from '../../../repl-input-document';

suite('REPL formatting with the shared formatter', () => {
  let getConfig: sinon.SinonStub;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('betterthantomorrow.calva').activate();
  });

  function options(text: string) {
    getConfig.returns({
      'cljfmt-options-string': text,
      'cljfmt-options': cljsLib.cljfmtOptionsFromString(text),
    });
  }

  setup(() => {
    getConfig = sinon.stub(config, 'getConfigNow');
    options('{}');
  });

  teardown(() => sinon.restore());

  function formatRange(text: string, start: number, end: number, eol: vscode.EndOfLine) {
    const doc = replDocument.stringDocument(text, []);
    doc.model.flushChanges();
    const changes = formatter.documentRangeReformatChanges(doc, eol, {
      startIndex: start,
      startColumn: doc.model.getRowCol(start)[1],
      originalText: text.slice(start, end),
      fullDocument: start === 0 && end === text.length,
    });
    replDocument.applyChanges(doc, changes);
    return replDocument.documentState(doc).text;
  }

  for (const [eol, ending] of [
    ['\n', vscode.EndOfLine.LF],
    ['\r\n', vscode.EndOfLine.CRLF],
  ] as const) {
    test(`preserves namespace sorting and regex indentation with ${JSON.stringify(eol)}`, () => {
      options('{:sort-ns-references? true :indents {#"^quux$" [[:inner 0]]}}');
      const text = `(ns sample (:require [z] [a]))${eol}(quux [x]${eol}(+ x 1))`;
      const formatted = formatRange(text, 0, text.length, ending);
      assert.ok(formatted.indexOf('[a]') < formatted.indexOf('[z]'));
      assert.ok(formatted.endsWith(`(quux [x]${eol}  (+ x 1))`), formatted);
      assert.strictEqual(formatter.formatCode(text, ending), formatted);
    });

    test(`heals incomplete selections and preserves their indentation with ${JSON.stringify(
      eol
    )}`, () => {
      const text = `(do${eol}    (def a${eol}42))`;
      const start = text.indexOf('(def');
      // Leave the definition's closing bracket outside the selection.
      const formatted = formatRange(text, start, text.length - 2, ending);
      assert.strictEqual(formatted, `(do${eol}    (def a${eol}      42))`);
    });
  }

  test('skips selections starting inside strings and comments', () => {
    for (const text of ['"not  code"', '; not  code']) {
      assert.strictEqual(formatRange(text, 2, text.length - 1, vscode.EndOfLine.LF), text);
    }
  });

  test('formats the whole document even when it starts with a comment', () => {
    const text = '; header\n(def a\n1)';
    assert.strictEqual(
      formatRange(text, 0, text.length, vscode.EndOfLine.LF),
      '; header\n(def a\n  1)'
    );
  });

  test('formats overlapping cursor scopes once and applies edits in reverse order', () => {
    const text = '(let [x  1] x)\n(let [y  2] y)';
    const positions = [text.indexOf('x  '), text.indexOf('x  ') + 1, text.indexOf('y  ')];
    const doc = replDocument.stringDocument(
      text,
      positions.map((p) => [p, p])
    );
    const changes = formatter.formatAtCursorsChanges(doc, text, {
      'remove-multiple-non-indenting-spaces?': true,
    });
    assert.ok(changes.length > 0);
    changes.forEach((change, i) => {
      assert.ok(i === 0 || change.end <= changes[i - 1].start);
    });
    replDocument.applyChanges(doc, changes);
    assert.strictEqual(replDocument.documentState(doc).text, '(let [x 1] x)\n(let [y 2] y)');
  });

  test('normalizes file endings only when formatting a whole document', () => {
    options('{:normalize-newlines-at-file-end? true}');
    assert.strictEqual(formatter.formatCode('(a)', vscode.EndOfLine.LF, false), '(a)');
    assert.strictEqual(formatter.formatCode('(a)', vscode.EndOfLine.LF, true), '(a)\n');
  });

  test('preserves invalid REPL input after a formatter error', () => {
    const text = '[)';
    assert.strictEqual(formatter.formatCode(text, vscode.EndOfLine.LF), text);
    assert.strictEqual(formatRange(text, 0, text.length, vscode.EndOfLine.LF), text);
  });
});
