import * as assert from 'assert';
import * as vscode from 'vscode';
import { formatIndexes } from '../../../calva-fmt/src/format-index';
import * as config from '../../../formatter-config';
import { sleep, waitForCondition } from './util';

suite('Recursive alignment command suite', () => {
  async function open(text: string, selections: [number, number][]) {
    const doc = await vscode.workspace.openTextDocument({ language: 'clojure', content: text });
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    editor.selections = selections.map(
      ([anchor, active]) => new vscode.Selection(doc.positionAt(anchor), doc.positionAt(active))
    );
    await sleep(100);
    return editor;
  }

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  function expected(text: string, ranges: [number, number][], doc: vscode.TextDocument) {
    let result = text;
    for (const range of [...ranges].sort((a, b) => b[0] - a[0])) {
      const formatted = formatIndexes(text, range, [], doc.eol === 2 ? '\r\n' : '\n', true, {
        ...config.getConfigNow(doc),
        'align-associative?': true,
        'comment-form?': false,
      })['range-text'];
      result = result.slice(0, range[0]) + formatted + result.slice(range[1]);
    }
    return result;
  }

  for (const eol of ['\n', '\r\n']) {
    for (const collection of [
      '{:a 1 :longer {:b 2 :cccc 3}}',
      `[${eol} {:a 1 :longer 2} {:b 3 :cccc 4}]`,
      `(do${eol} {:a 1 :longer 2} {:b 3 :cccc 4})`,
    ]) {
      test(`formats the nearest ${collection[0]} recursively with ${JSON.stringify(
        eol
      )}`, async () => {
        const text = `{:outside   0 :target ${collection} :tail   9}`;
        const start = text.indexOf(collection);
        const end = start + collection.length;
        const p = start + (collection[0] === '[' ? 1 : 2);
        const editor = await open(text, [[p, p]]);
        assert.strictEqual(
          await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'),
          true
        );
        assert.strictEqual(
          editor.document.getText(),
          expected(text, [[start, end]], editor.document)
        );
        assert.notStrictEqual(editor.document.getText(), text);
      });
    }
  }

  test('uses the collection containing a string and preserves multiline string contents', async () => {
    const collection = '{:a "multi\n    literal" :longer 2}';
    const text = `{:outside   0 :target ${collection} :tail   9}`;
    const start = text.indexOf(collection);
    const p = text.indexOf('literal') + 2;
    const editor = await open(text, [[p, p]]);
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'), true);
    assert.strictEqual(
      editor.document.getText(),
      expected(text, [[start, start + collection.length]], editor.document)
    );
    assert.ok(editor.document.getText().includes('"multi\n    literal"'));
  });

  for (const reversed of [false, true]) {
    test(`formats only an explicit ${reversed ? 'reversed ' : ''}selection`, async () => {
      const collection = '{:a "multi\n    literal" :longer {:b 2 :cccc 3}}';
      const text = `{:outside   0 :target ${collection} :tail   9}`;
      const start = text.indexOf(collection);
      const end = start + collection.length;
      const editor = await open(text, [reversed ? [end, start] : [start, end]]);
      assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'), true);
      assert.strictEqual(
        editor.document.getText(),
        expected(text, [[start, end]], editor.document)
      );
      assert.strictEqual(editor.selection.isReversed, reversed);
      assert.ok(editor.document.getText().includes('"multi\n    literal"'));
    });
  }

  test('formats separate selections and cursors in one undo step', async () => {
    const first = '{:a 1 :longer 2}',
      second = '{:b 3 :cccc 4}';
    const text = `{:first ${first} :middle   0 :second ${second} :tail   9}`;
    const a = text.indexOf(first),
      b = text.indexOf(second);
    const editor = await open(text, [
      [a, a + first.length],
      [b + 2, b + 2],
    ]);
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'), true);
    const formatted = expected(
      text,
      [
        [a, a + first.length],
        [b, b + second.length],
      ],
      editor.document
    );
    assert.strictEqual(editor.document.getText(), formatted);
    await vscode.commands.executeCommand('default:undo');
    await waitForCondition(() => editor.document.getText() === text);
    await vscode.commands.executeCommand('default:redo');
    await waitForCondition(() => editor.document.getText() === formatted);
  });

  test('formats an incomplete selection without touching unselected brackets', async () => {
    const collection = '{:a 1 :longer 2}';
    const text = `{:outside   0 :target ${collection} :tail   9}`;
    const start = text.indexOf(collection),
      end = start + collection.length - 1;
    const editor = await open(text, [[start, end]]);
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'), true);
    const result = editor.document.getText();
    assert.ok(result.startsWith(text.slice(0, start)));
    assert.ok(result.endsWith(text.slice(end)));
    assert.notStrictEqual(result, text);
    assert.strictEqual(result.replace(/\s/g, ''), text.replace(/\s/g, ''));
  });

  test('leaves a selection inside a string and a cursor outside collections unchanged', async () => {
    const text = '"literal  text"\n{:a 1 :longer 2}\n';
    const editor = await open(text, [[2, 8]]);
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'), false);
    assert.strictEqual(editor.document.getText(), text);
    const p = editor.document.positionAt(text.length);
    editor.selection = new vscode.Selection(p, p);
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.alignCurrentForm'), false);
    assert.strictEqual(editor.document.getText(), text);
  });
});
