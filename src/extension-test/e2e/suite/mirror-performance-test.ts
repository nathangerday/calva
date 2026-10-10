import * as assert from 'assert';
import * as vscode from 'vscode';
import * as docMirror from '../../../doc-mirror';

suite('Mirror performance suite', () => {
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
