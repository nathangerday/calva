import * as assert from 'assert';
import * as vscode from 'vscode';
import * as highlight from '../../../highlight/src/extension';
import * as testUtil from './util';
import * as formatter from '../../../calva-fmt/src/format';
import * as sinon from 'sinon';

async function measureCommandAndDecorations(
  editor: vscode.TextEditor,
  command: string
): Promise<number> {
  let resolveSelectionChange: () => void;
  const selectionChanged = new Promise<void>((resolve) => {
    resolveSelectionChange = resolve;
  });
  const listener = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor === editor) {
      listener.dispose();
      resolveSelectionChange();
    }
  });
  const startedAt = performance.now();

  try {
    await vscode.commands.executeCommand(command);
    await selectionChanged;
    // The highlighter schedules active-indent decorations after 16 ms. Waiting
    // past that debounce includes the decoration pass in the measurement.
    await testUtil.sleep(32);
    return performance.now() - startedAt;
  } finally {
    listener.dispose();
  }
}

suite('Paredit performance suite', () => {
  test('slurping in a large map formats each enclosing range once', async function () {
    await vscode.extensions.getExtension('betterthantomorrow.calva')?.activate();
    const items = Array.from(
      { length: 2000 },
      (_, i) => ` "key${i}" {:code "${i}",\n :label "Entry ${i}",\n :children ["a" "b"]}`
    );
    const content = `{\n${items.join('\n')}\n}`;
    const document = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    const editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const formatSpy = sinon.spy(formatter, 'formatDocIndexesInfo');
    try {
      await testUtil.waitForCondition(() => highlight.activeEditor?.document === document);
      const position = document.positionAt(content.indexOf(':children [') + ':children ['.length);
      editor.selection = new vscode.Selection(position, position);
      await testUtil.sleep(250);
      const startedAt = performance.now();
      await vscode.commands.executeCommand('paredit.slurpSexpForward');
      await testUtil.sleep(32);
      const elapsedMs = performance.now() - startedAt;
      assert.notStrictEqual(document.getText(), content);
      assert.strictEqual(formatSpy.callCount, 1, 'the same enclosing map was formatted repeatedly');
      assert.ok(elapsedMs < 5000, `slurp and decorations took ${elapsedMs.toFixed(0)}ms`);
      testUtil.log('Paredit performance', `large map slurp took ${elapsedMs.toFixed(0)}ms`);
    } finally {
      formatSpy.restore();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('many cursors remain responsive', async function () {
    await vscode.extensions.getExtension('betterthantomorrow.calva')?.activate();

    const itemCount = 250;
    const items = Array.from({ length: itemCount }, (_, i) => `  ${String(i).padStart(5, '0')}`);
    const document = await vscode.workspace.openTextDocument({
      language: 'clojure',
      content: `[\n${items.join('\n')}\n]`,
    });
    const editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');

    try {
      await testUtil.waitForCondition(() => highlight.activeEditor?.document === document);

      const start = document.positionAt(2);
      const end = document.positionAt(document.getText().lastIndexOf('\n'));
      editor.selection = new vscode.Selection(start, end);

      await vscode.commands.executeCommand('editor.action.insertCursorAtEndOfEachLineSelected');
      assert.strictEqual(editor.selections.length, itemCount);

      // Allow the selection-change/highlight debounce to run before measuring
      // a command that must compete with the active-indent decorations.
      await testUtil.sleep(250);
      const elapsedMs = await measureCommandAndDecorations(editor, 'cursorRight');
      testUtil.log(
        'Paredit performance',
        `cursor movement and decoration took ${elapsedMs.toFixed(0)}ms with ${itemCount} cursors`
      );

      assert.ok(
        elapsedMs < 1000,
        `cursor movement and decoration took ${elapsedMs.toFixed(0)}ms with ${itemCount} cursors`
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });
});
