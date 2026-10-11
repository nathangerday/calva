import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as docMirror from '../../../doc-mirror';
import { newlineCommand, newlineEnabled } from '../../../calva-fmt/src/newline-command';
import * as testUtil from './util';

const content = '{\n "502.82" {:code "502.82",\n           :children []},\n "331.128" {}}';

suite('Newline indentation suite', () => {
  let editor: vscode.TextEditor;
  let previousEngine: boolean;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('betterthantomorrow.calva')?.activate();
    const fmt = vscode.workspace.getConfiguration('calva.fmt');
    previousEngine = fmt.get('newIndentEngine');
    await fmt.update('newIndentEngine', true, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration('calva.fmt')
      .update('newIndentEngine', previousEngine, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    if (editor) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      editor = undefined;
    }
  });

  async function open(text: string) {
    const document = await vscode.workspace.openTextDocument({
      language: 'clojure',
      content: text,
    });
    editor = await vscode.window.showTextDocument(document);
    return document;
  }

  function interceptEdits() {
    // VS Code freezes the public editor, so intercept through an adapter while
    // retaining its real document, cursor tracking and active-editor changes.
    const realEditor = editor;
    const edit = sinon.stub();
    const adapter: vscode.TextEditor = Object.create(realEditor, { edit: { value: edit } });
    const getActive = Object.getOwnPropertyDescriptor(vscode.window, 'activeTextEditor').get;
    const active = sinon.stub(vscode.window, 'activeTextEditor').get(() => {
      const current = getActive.call(vscode.window);
      return current === realEditor ? adapter : current;
    });
    return { edit, restore: () => active.restore() };
  }

  test('inserts correct indentation in the first and only document edit', async () => {
    const document = await open(content);
    const offset = content.indexOf('},') + 2;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    const changes: string[] = [];
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && event.contentChanges.length) {
        changes.push(document.getText());
      }
    });
    try {
      assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.newline'), true);
      const expected = content.slice(0, offset) + '\n ' + content.slice(offset);
      assert.deepStrictEqual(changes, [expected]);
      assert.strictEqual(editor.selection.active.line, position.line + 1);
      assert.strictEqual(editor.selection.active.character, 1);
      assert.strictEqual(docMirror.getDocument(document).model.documentVersion, document.version);
      // No deferred formatter may undo a character typed immediately afterward.
      const cursor = editor.selection.active;
      assert.ok(await editor.edit((edit) => edit.insert(cursor, 'x')));
      await testUtil.sleep(500);
      assert.strictEqual(
        document.getText(),
        expected.slice(0, offset + 2) + 'x' + expected.slice(offset + 2)
      );
      assert.strictEqual(changes.length, 2);
    } finally {
      listener.dispose();
    }
  });

  test('round-trips Enter and Backspace at a let binding without adding a space', async () => {
    const text =
      '(defn foo [ctx]\n  (let [account (extract ctx)\n        body (get ctx :body)\n        bon-commande-a-modifier (merge body {:id id})\n        _ (log/info body)]\n    body))';
    const document = await open(text);
    const offset = text.indexOf('(merge body {:id id})') + '(merge body {:id id})'.length;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    const changes: string[] = [];
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && event.contentChanges.length) {
        changes.push(document.getText());
      }
    });
    try {
      for (let i = 0; i < 3; i++) {
        const before = changes.length;
        assert.strictEqual(await newlineCommand(), true);
        assert.strictEqual(
          document.getText(),
          text.slice(0, offset) + '\n        ' + text.slice(offset)
        );
        assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, 8)));
        await vscode.commands.executeCommand('paredit.deleteBackward');
        assert.strictEqual(document.getText(), text);
        assert.ok(editor.selection.active.isEqual(position));
        await testUtil.sleep(100);
        assert.strictEqual(changes.length, before + 2);
        assert.strictEqual(document.getText(), text);
        assert.ok(editor.selection.active.isEqual(position));
      }
    } finally {
      listener.dispose();
    }
  });

  test('preserves sibling indentation after Home and Enter following a long form', async () => {
    const body = Array.from({ length: 25 }, (_, i) => `        (step ${i})`).join('\n');
    const prefix = `(defn foo []\n  (let [a 1]\n    (doseq [x xs]\n${body})\n`;
    const document = await open(prefix + '    (println "done")))');
    const position = document.positionAt(prefix.length + 4);
    editor.selection = new vscode.Selection(position, position);
    assert.strictEqual(await newlineCommand(), true);
    assert.strictEqual(document.getText(), prefix + '    \n    (println "done")))');
    assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, 4)));
  });

  test('does not apply a moved operator rule immediately after an opening paren', async () => {
    const document = await open('(cond a b)');
    editor.selection = new vscode.Selection(0, 1, 0, 1);
    assert.strictEqual(await newlineCommand(), true);
    assert.strictEqual(document.getText(), '(\n cond a b)');
    assert.ok(editor.selection.active.isEqual(new vscode.Position(1, 1)));
  });

  test('serializes rapid Enter commands without dropping a newline', async () => {
    const document = await open(content);
    const offset = content.indexOf('},') + 2;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    const results = await Promise.all([newlineCommand(), newlineCommand(), newlineCommand()]);
    assert.deepStrictEqual(results, [true, true, true]);
    assert.strictEqual(
      document.getText(),
      content.slice(0, offset) + '\n '.repeat(3) + content.slice(offset)
    );
    assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 3, 1)));
  });

  test('handles multiple cursors with different indentation in one edit', async () => {
    const text = '{\n :a {\n      :children []\n      },\n :b []\n}';
    const document = await open(text);
    const inner = text.indexOf(':children []') + ':children []'.length;
    const outer = text.indexOf('},') + 2;
    editor.selections = [outer, inner].map((offset) => {
      const position = document.positionAt(offset);
      return new vscode.Selection(position, position);
    });
    const version = document.version;
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.newline'), true);
    assert.strictEqual(document.version, version + 1);
    assert.deepStrictEqual(
      editor.selections.map((selection) => selection.active.character),
      [1, 5]
    );
    assert.strictEqual(
      document.getText(),
      text.slice(0, inner) + '\n     ' + text.slice(inner, outer) + '\n ' + text.slice(outer)
    );
  });

  test('keeps the Enter queue usable after an edit fails', async () => {
    const document = await open(content);
    const offset = content.indexOf('},') + 2;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    const originalEdit = editor.edit.bind(editor);
    const { edit, restore } = interceptEdits();
    edit.onFirstCall().rejects(new Error('simulated edit failure'));
    edit.onSecondCall().callsFake(originalEdit);
    try {
      await assert.rejects(async () => await newlineCommand(), /simulated edit failure/);
      assert.strictEqual(await newlineCommand(), true);
      assert.strictEqual(
        document.getText(),
        content.slice(0, offset) + '\n ' + content.slice(offset)
      );
    } finally {
      restore();
    }
  });

  test('does not run a queued Enter in a different active editor', async () => {
    const document = await open(content);
    const position = document.positionAt(content.indexOf('},') + 2);
    editor.selection = new vscode.Selection(position, position);
    const { edit, restore } = interceptEdits();
    const originalEdit = editor.edit.bind(editor);
    const other = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    edit.callsFake(async (builder) => {
      const applied = await originalEdit(builder);
      await gate;
      return applied;
    });
    try {
      const first = newlineCommand();
      const queued = newlineCommand();
      while (!edit.called) {
        await testUtil.sleep(10);
      }
      await vscode.window.showTextDocument(other);
      release();
      assert.deepStrictEqual(await Promise.all([first, queued]), [true, false]);
      assert.strictEqual(edit.callCount, 1);
      assert.strictEqual(other.getText(), content);
    } finally {
      release();
      restore();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.window.showTextDocument(document);
    }
  });

  test('reveals the new cursor after Enter at the bottom of the viewport', async () => {
    const document = await open('{\n' + ' :a [],\n'.repeat(300) + '}');
    const top = new vscode.Position(40, 0);
    editor.selection = new vscode.Selection(top, top);
    editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
    await testUtil.sleep(300);
    const bottom = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;
    const position = document.lineAt(bottom).range.end;
    editor.selection = new vscode.Selection(position, position);
    await testUtil.sleep(100);
    assert.ok(editor.visibleRanges.some((range) => range.contains(position)));
    assert.strictEqual(await newlineCommand(), true);
    await testUtil.sleep(300);
    assert.strictEqual(editor.selection.active.line, bottom + 1);
    assert.ok(
      editor.visibleRanges.some((range) => range.contains(editor.selection.active)),
      `new cursor ${editor.selection.active.line} outside ${JSON.stringify(editor.visibleRanges)}`
    );
  });

  test('replans once when a concurrent edit rejects the first newline', async () => {
    const document = await open(content);
    const offset = content.indexOf('},') + 2;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    const originalEdit = editor.edit.bind(editor);
    const { edit, restore } = interceptEdits();
    edit.onFirstCall().callsFake(async () => {
      assert.ok(await originalEdit((builder) => builder.insert(position, 'x')));
      return false;
    });
    edit.onSecondCall().callsFake(originalEdit);
    try {
      assert.strictEqual(await newlineCommand(), true);
      assert.strictEqual(edit.callCount, 2);
      assert.strictEqual(
        document.getText(),
        content.slice(0, offset) + 'x\n ' + content.slice(offset)
      );
      assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, 1)));
    } finally {
      restore();
    }
  });

  test('uses native Enter after two rejected edits without dropping the newline', async () => {
    const document = await open(content);
    const offset = content.indexOf('},') + 2;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    const originalEdit = editor.edit.bind(editor);
    const { edit, restore } = interceptEdits();
    edit.resolves(false);
    // Keep the editor transaction real while avoiding headless native typing's
    // dependence on renderer focus. This adapter stands in only for routing.
    const commands = sinon.stub(vscode.commands, 'executeCommand').callThrough();
    const nativeType = commands.withArgs('type', { text: '\n' }).callsFake(async (command, arg) => {
      assert.strictEqual(command, 'type');
      assert.deepStrictEqual(arg, { text: '\n' });
      return await originalEdit((builder) => builder.insert(editor.selection.active, arg.text));
    });
    try {
      assert.strictEqual(await newlineCommand(), true);
      assert.strictEqual(edit.callCount, 2);
      assert.strictEqual(nativeType.callCount, 1);
      assert.strictEqual(
        document.getText(),
        content.slice(0, offset) + '\n' + content.slice(offset)
      );
      assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, 0)));
    } finally {
      restore();
      commands.restore();
    }
  });

  test('does not retry into another editor after focus changes', async () => {
    const document = await open(content);
    const position = document.positionAt(content.indexOf('},') + 2);
    editor.selection = new vscode.Selection(position, position);
    const other = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    const { edit, restore } = interceptEdits();
    edit.callsFake(async () => {
      await vscode.window.showTextDocument(other);
      return false;
    });
    const nativeType = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
    try {
      assert.strictEqual(await newlineCommand(), false);
      assert.strictEqual(edit.callCount, 1);
      assert.strictEqual(nativeType.calledWith('type'), false);
      assert.strictEqual(document.getText(), content);
      assert.strictEqual(other.getText(), content);
    } finally {
      restore();
      nativeType.restore();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.window.showTextDocument(document);
    }
  });

  test('moves all cursors after newlines when only some replace trailing whitespace', async () => {
    const text = '{\n :a [] , \t\n :b [1 2]\n}';
    const document = await open(text);
    const offsets = [text.indexOf(',') + 1, text.indexOf('[1 2]') + '[1 2]'.length];
    const positions = offsets.map((offset) => document.positionAt(offset));
    editor.selections = positions
      .slice()
      .reverse()
      .map((position) => new vscode.Selection(position, position));
    const version = document.version;
    assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.newline'), true);
    assert.strictEqual(document.version, version + 1);
    assert.strictEqual(document.getText(), '{\n :a [] ,\n \n :b [1 2]\n \n}');
    assert.deepStrictEqual(
      editor.selections.map((selection) => [selection.active.line, selection.active.character]),
      [
        [4, 1],
        [2, 1],
      ]
    );
  });

  for (const lineEnding of ['\n', '\r\n']) {
    test(`Enter before trailing whitespace keeps the cursor on the new line (${JSON.stringify(
      lineEnding
    )})`, async () => {
      for (const [trailing, beforeCursor] of [
        [' ', ''],
        [' \t', ''],
        ['    ', ' '],
      ]) {
        const offset = content.indexOf('},') + 2;
        const text = (content.slice(0, offset) + trailing + content.slice(offset)).replace(
          /\n/g,
          lineEnding
        );
        const document = await open(text);
        const position = document.positionAt(text.indexOf('},') + 2 + beforeCursor.length);
        editor.selection = new vscode.Selection(position, position);
        assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.newline'), true);
        assert.strictEqual(
          document.getText(),
          (content.slice(0, offset) + beforeCursor + '\n ' + content.slice(offset)).replace(
            /\n/g,
            lineEnding
          )
        );
        assert.ok(editor.selection.isEmpty);
        assert.ok(
          editor.selection.active.isEqual(new vscode.Position(position.line + 1, 1)),
          `cursor after replacing ${JSON.stringify(trailing)}: ${JSON.stringify(
            editor.selection.active
          )}`
        );
        await testUtil.sleep(300);
        assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, 1)));
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        editor = undefined;
      }
    });

    test(`Enter then Backspace preserves the preceding comma (${JSON.stringify(
      lineEnding
    )})`, async () => {
      const text = content.replace(/\n/g, lineEnding);
      const document = await open(text);
      const offset = text.indexOf('},') + 2;
      const position = document.positionAt(offset);
      editor.selection = new vscode.Selection(position, position);
      assert.strictEqual(await vscode.commands.executeCommand('calva-fmt.newline'), true);
      assert.strictEqual(editor.selection.active.line, position.line + 1);
      assert.strictEqual(editor.selection.active.character, 1);
      await vscode.commands.executeCommand('paredit.deleteBackward');
      const expected = text;
      assert.strictEqual(document.getText(), expected);
      assert.ok(editor.selection.isEmpty);
      assert.ok(editor.selection.active.isEqual(position));
      await testUtil.sleep(200);
      assert.strictEqual(document.getText(), expected);
    });

    test(`Backspace preserves existing spacing after a comma (${JSON.stringify(
      lineEnding
    )})`, async () => {
      const offset = content.indexOf('},') + 2;
      const text = (content.slice(0, offset) + ' \t\n ' + content.slice(offset)).replace(
        /\n/g,
        lineEnding
      );
      const document = await open(text);
      const position = document.positionAt(text.indexOf('},') + 4);
      const cursor = new vscode.Position(position.line + 1, 1);
      editor.selection = new vscode.Selection(cursor, cursor);
      await vscode.commands.executeCommand('paredit.deleteBackward');
      assert.strictEqual(
        document.getText(),
        (content.slice(0, offset) + ' \t' + content.slice(offset)).replace(/\n/g, lineEnding)
      );
      assert.ok(editor.selection.active.isEqual(position));
    });
  }

  test('delegates selections, strings, comments and token splitting to native typing', async () => {
    for (const [text, start, end] of [
      ['(foo)', 1, 4],
      ['"hello world"', 6, 6],
      ['; comment', 4, 4],
      ['(foobar)', 3, 3],
    ] as [string, number, number][]) {
      const document = await open(text);
      editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
      const nativeType = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
      try {
        await newlineCommand();
        assert.strictEqual(nativeType.callCount, 1);
        assert.deepStrictEqual(nativeType.firstCall.args, ['type', { text: '\n' }]);
        assert.strictEqual(document.getText(), text);
      } finally {
        nativeType.restore();
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        editor = undefined;
      }
    }
  });

  for (const eol of ['\n', '\r\n']) {
    test(`indents empty collections in one edit with the cursor on the inner line (${JSON.stringify(
      eol
    )})`, async () => {
      for (const [left, right, indent, closingIndent] of [
        ['{\n "612.825" {:code "612.825",\n            :children [', ']},\n "next" {}}', 23, 12],
        ['(defn foo []\n  (', '))', 3, 2],
        ['{\n :children [  ', '  ]}', 12, 3],
        ['(let [a {', '}] a)', 9, 0],
        ['#{', '}', 2, 0],
      ] as [string, string, number, number][]) {
        const text = (left + right + '\n').replace(/\n/g, eol);
        const document = await open(text);
        const position = document.positionAt(left.replace(/\n/g, eol).length);
        editor.selection = new vscode.Selection(position, position);
        const changes: string[] = [];
        const listener = vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document === document && event.contentChanges.length) {
            changes.push(document.getText());
          }
        });
        try {
          assert.strictEqual(await newlineCommand(), true);
          const expected = (
            left +
            '\n' +
            ' '.repeat(indent) +
            '\n' +
            ' '.repeat(closingIndent) +
            right.trimStart() +
            '\n'
          ).replace(/\n/g, eol);
          assert.deepStrictEqual(changes, [expected]);
          assert.ok(
            editor.selection.active.isEqual(new vscode.Position(position.line + 1, indent))
          );
          const cursor = editor.selection.active;
          assert.ok(await editor.edit((edit) => edit.insert(cursor, 'x')));
          await testUtil.sleep(200);
          assert.strictEqual(document.lineAt(cursor.line).text, ' '.repeat(indent) + 'x');
          assert.ok(editor.selection.active.isEqual(new vscode.Position(cursor.line, indent + 1)));
          assert.strictEqual(changes.length, 2);
        } finally {
          listener.dispose();
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
          editor = undefined;
        }
      }
    });
  }

  test('splits ordinary code boundaries with final indentation in one edit', async () => {
    for (const [left, right, indent] of [
      ['{:children ["191c" ', '"191o"]}', 12],
      ['{:children [1', ']}', 12],
      ['(foo', '   bar)', 2],
      ['(foo ', 'bar) ; c', 2],
      ['(foo ', '; c', 2],
      ['(foo ; c', '', 2],
      ['; comment', '', 0],
      ['(defn a []\n  1)', ' (defn b [] 2)', 0],
      ['(do (foo\n b)', ' c)', 4],
      ['(when x (foo\n b)', ' (bar))', 6],
      ['(let [x 1] (foo\n  b)', ' c)', 5],
    ] as [string, string, number][]) {
      const document = await open(left + right);
      const position = document.positionAt(left.length);
      editor.selection = new vscode.Selection(position, position);
      const version = document.version;
      assert.strictEqual(await newlineCommand(), true);
      assert.strictEqual(document.version, version + 1);
      assert.strictEqual(document.getText(), left + '\n' + ' '.repeat(indent) + right.trimStart());
      assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, indent)));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      editor = undefined;
    }
  });

  test('preserves sibling indentation after a long EDN value', async () => {
    const children = Array.from({ length: 25 }, (_, i) => `                       "${i}"`).join(
      '\n'
    );
    const left = `{"1" {:code "1"}\n "2" {:code "2",\n      :children [\n${children}]},`;
    const right = '\n "3" {:code "3"}}';
    const document = await open(left + right);
    const position = document.positionAt(left.length);
    editor.selection = new vscode.Selection(position, position);
    const version = document.version;
    assert.strictEqual(await newlineCommand(), true);
    assert.strictEqual(document.version, version + 1);
    assert.strictEqual(document.getText(), left + '\n ' + right);
    assert.ok(editor.selection.active.isEqual(new vscode.Position(position.line + 1, 1)));
  });

  test('keeps pair cursor placement below the 1000-operation reduction threshold', async () => {
    const document = await open('[]\n'.repeat(499));
    editor.selections = Array.from({ length: 499 }, (_, line) => {
      const position = new vscode.Position(line, 1);
      return new vscode.Selection(position, position);
    });
    const version = document.version;
    assert.strictEqual(await newlineCommand(), true);
    assert.strictEqual(document.version, version + 1);
    assert.strictEqual(document.getText(), '[\n \n]\n'.repeat(499));
    assert.strictEqual(editor.selections.length, 499);
    editor.selections.forEach((selection, i) => {
      assert.ok(selection.active.isEqual(new vscode.Position(i * 3 + 1, 1)));
    });
  });

  test('delegates batches of 1000 operations to native Enter', async () => {
    const text = '[]\n'.repeat(500);
    const document = await open(text);
    editor.selections = Array.from({ length: 500 }, (_, line) => {
      const position = new vscode.Position(line, 1);
      return new vscode.Selection(position, position);
    });
    const { edit, restore } = interceptEdits();
    const nativeType = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
    try {
      await newlineCommand();
      assert.strictEqual(edit.callCount, 0);
      assert.strictEqual(nativeType.callCount, 1);
      assert.deepStrictEqual(nativeType.firstCall.args, ['type', { text: '\n' }]);
      assert.strictEqual(document.getText(), text);
    } finally {
      restore();
      nativeType.restore();
    }
  });

  test('handles empty pairs and ordinary newlines together with multiple cursors', async () => {
    const text = '{\n :a []\n :b 1\n}';
    const document = await open(text);
    const positions = [text.indexOf('[') + 1, text.indexOf('1') + 1].map((offset) =>
      document.positionAt(offset)
    );
    editor.selections = positions
      .slice()
      .reverse()
      .map((position) => new vscode.Selection(position, position));
    const version = document.version;
    assert.strictEqual(await newlineCommand(), true);
    assert.strictEqual(document.version, version + 1);
    assert.strictEqual(document.getText(), '{\n :a [\n     \n ]\n :b 1\n \n}');
    assert.deepStrictEqual(
      editor.selections.map((selection) => [selection.active.line, selection.active.character]),
      [
        [5, 1],
        [2, 5],
      ]
    );
  });

  test('preserves native autoIndent control of empty-pair expansion', async () => {
    const document = await open('[ ]');
    const position = new vscode.Position(0, 1);
    editor.selection = new vscode.Selection(position, position);
    const settings = vscode.workspace.getConfiguration('editor', document);
    const previous = settings.inspect<string>('autoIndent').globalLanguageValue;
    try {
      await settings.update('autoIndent', 'keep', vscode.ConfigurationTarget.Global, true);
      assert.strictEqual(await newlineCommand(), true);
      assert.strictEqual(document.getText(), '[\n ]');
      assert.ok(editor.selection.active.isEqual(new vscode.Position(1, 1)));
    } finally {
      await settings.update('autoIndent', previous, vscode.ConfigurationTarget.Global, true);
    }
  });

  test('honors language-specific disabling of format-on-type', async () => {
    const document = await open(content);
    const scopedEditorConfig = vscode.workspace.getConfiguration('editor', document);
    const previous = scopedEditorConfig.inspect<boolean>('formatOnType').globalLanguageValue;
    try {
      assert.strictEqual(newlineEnabled(document), true);
      await scopedEditorConfig.update(
        'formatOnType',
        false,
        vscode.ConfigurationTarget.Global,
        true
      );
      assert.strictEqual(newlineEnabled(document), false);
      const nativeType = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
      try {
        await newlineCommand();
        assert.deepStrictEqual(nativeType.firstCall.args, ['type', { text: '\n' }]);
        assert.strictEqual(document.getText(), content);
      } finally {
        nativeType.restore();
      }
    } finally {
      await scopedEditorConfig.update(
        'formatOnType',
        previous,
        vscode.ConfigurationTarget.Global,
        true
      );
    }
  });

  test('delegates the entire batch if any cursor needs native handling or the mirror is stale', async () => {
    const document = await open(content);
    const lineEnd = document.positionAt(content.indexOf('},') + 2);
    const string = document.positionAt(content.indexOf('502.82') + 1);
    editor.selections = [lineEnd, string].map(
      (position) => new vscode.Selection(position, position)
    );
    const nativeType = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
    const model = docMirror.getDocument(document).model;
    const version = model.documentVersion;
    try {
      await newlineCommand();
      assert.strictEqual(nativeType.callCount, 1);
      editor.selection = new vscode.Selection(lineEnd, lineEnd);
      model.documentVersion = version - 1;
      await newlineCommand();
      assert.strictEqual(nativeType.callCount, 2);
      assert.strictEqual(document.getText(), content);
    } finally {
      model.documentVersion = version;
      nativeType.restore();
    }
  });
});
