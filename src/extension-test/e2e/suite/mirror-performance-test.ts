import * as assert from 'assert';
import * as vscode from 'vscode';
import * as docMirror from '../../../doc-mirror';

suite('Mirror performance suite', () => {
  test('supports structural navigation, editing and resync beyond the JS argument limit', async () => {
    await vscode.extensions.getExtension('betterthantomorrow.calva')?.activate();
    const content = '[\n' + Array(180000).fill(' [0 1]').join('\n') + '\n]';
    const document = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    const editor = await vscode.window.showTextDocument(document);
    try {
      const model = docMirror.getDocument(document).model;
      assert.strictEqual(model.lineInputModel.lines.length, document.lineCount);
      for (const row of [1, 90000, 180000]) {
        editor.selection = new vscode.Selection(row, 2, row, 2);
        await vscode.commands.executeCommand('paredit.forwardSexp');
        assert.deepStrictEqual(
          [editor.selection.active.line, editor.selection.active.character],
          [row, 3]
        );
        await vscode.commands.executeCommand('paredit.backwardSexp');
        assert.deepStrictEqual(
          [editor.selection.active.line, editor.selection.active.character],
          [row, 2]
        );
      }
      await vscode.commands.executeCommand('calva-fmt.newline');
      assert.strictEqual(document.lineCount, 180003);
      await vscode.commands.executeCommand('paredit.deleteBackward');
      assert.strictEqual(document.getText(), content);
      model.resync(document);
      assert.strictEqual(model.lineInputModel.getText(0, content.length), content);
      assert.strictEqual(model.documentVersion, document.version);
      editor.selection = new vscode.Selection(90000, 1, 90000, 1);
      await vscode.commands.executeCommand('paredit.forwardSexp');
      assert.deepStrictEqual(
        [editor.selection.active.line, editor.selection.active.character],
        [90000, 6]
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('clears unused repaint bookkeeping after open, batched edits and resync', async () => {
    await vscode.extensions.getExtension('betterthantomorrow.calva')?.activate();
    const document = await vscode.workspace.openTextDocument({
      language: 'clojure',
      content: Array.from({ length: 1000 }, (_, i) => `[:entry ${i}]`).join('\n'),
    });
    const editor = await vscode.window.showTextDocument(document);
    try {
      const model = docMirror.getDocument(document).model;
      const check = () => {
        assert.strictEqual(model.lineInputModel.changedLines.size, 0);
        assert.strictEqual(model.lineInputModel.dirtyLines.length, 0);
        assert.strictEqual(model.lineInputModel.insertedLines.size, 0);
        assert.strictEqual(model.lineInputModel.deletedLines.size, 0);
        assert.strictEqual(model.documentVersion, document.version);
      };
      check();
      assert.ok(
        await editor.edit((edits) => {
          for (let row = 0; row < 250; row++) {
            edits.insert(new vscode.Position(row, 1), '\n');
          }
        })
      );
      check();
      assert.strictEqual(document.lineCount, 1250);
      model.resync(document);
      check();
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
