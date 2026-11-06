import * as assert from 'assert';
import * as vscode from 'vscode';
import * as formatter from '../../../calva-fmt/src/format';
import { formatIndexes } from '../../../calva-fmt/src/format-index';
import { formatterWorker } from '../../../calva-fmt/src/worker-client';
import { runFormatJob, FormatResult } from '../../../calva-fmt/src/format-job';
import { sleep, waitForCondition } from './util';

suite('Large formatter worker suite', () => {
  const content = `(do\n${Array.from({ length: 1000 }, (_, i) => `(println ${i}\n(+ ${i} 1))`).join(
    '\n'
  )}\n)`;

  async function open() {
    const doc = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const position = doc.positionAt(2);
    editor.selection = new vscode.Selection(position, position);
    await sleep(100);
    return editor;
  }

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('completes formatting with heartbeat and one-step undo/redo', async () => {
    const editor = await open();
    let pulses = 0;
    const timer = setInterval(() => pulses++, 10);
    try {
      assert.ok(await vscode.commands.executeCommand('calva-fmt.formatCurrentForm'));
      assert.ok(pulses > 10, 'the extension host did not run callbacks during formatting');
      const formatted = editor.document.getText();
      assert.notStrictEqual(formatted, content);
      assert.strictEqual(formatted, formatter.formatCode(content, editor.document.eol));
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await sleep(100);
      await vscode.commands.executeCommand('default:undo');
      await waitForCondition(() => editor.document.getText() === content);
      assert.strictEqual(editor.document.getText(), content);
      await vscode.commands.executeCommand('default:redo');
      await waitForCondition(() => editor.document.getText() === formatted);
      assert.strictEqual(editor.document.getText(), formatted);
    } finally {
      clearInterval(timer);
    }
  });

  test('preserves raw regex indentation options, namespace sorting and CRLF', async () => {
    for (const eol of ['\n', '\r\n']) {
      const text = ['(ns sample (:require [z] [a]))', '(custom [x]', '(+ x 1))'].join(eol);
      const config = {
        'cljfmt-options-string': '{:sort-ns-references? true :indents {#"^custom$" [[:inner 0]]}}',
      };
      const expected = formatIndexes(text, [0, text.length], [], eol, false, config)['range-text'];
      const result = await formatterWorker.request('test-config', {
        kind: 'indexes',
        text,
        range: [0, text.length],
        indexes: [],
        eol,
        onType: false,
        startColumn: 0,
        scannerMaxLength: 20000,
        config,
      }).promise;
      assert.strictEqual(result.formattedText, expected);
      let edited = text;
      for (const change of result.changes) {
        edited = edited.slice(0, change.start) + change.text + edited.slice(change.end);
      }
      assert.strictEqual(edited, expected);
      assert.ok(expected.indexOf('[a]') < expected.indexOf('[z]'));
    }
  });

  test('discards formatting if the user edits before it completes', async () => {
    const editor = await open();
    const pending = formatter.formatPosition(editor);
    assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), ';user edit\n')));
    assert.strictEqual(await pending, false);
    await sleep(150);
    assert.strictEqual(editor.document.getText(), ';user edit\n' + content);
  });

  test('keeps progress hidden when a large formatter request completes quickly', async () => {
    const editor = await open();
    const request = formatterWorker.request;
    const withProgress = vscode.window.withProgress;
    let shown = false;
    formatterWorker.request = () => ({
      promise: Promise.resolve({
        formattedText: content,
        previousText: content,
        range: [0, content.length],
        changes: [],
      }),
      cancel: () => undefined,
    });
    vscode.window.withProgress = (options, task) => {
      shown = true;
      return withProgress(options, task);
    };
    try {
      assert.strictEqual(await formatter.formatPosition(editor), true);
      await sleep(850);
      assert.strictEqual(shown, false);
    } finally {
      formatterWorker.request = request;
      vscode.window.withProgress = withProgress;
    }
  });

  test('shows delayed progress and cancels formatting without changing user text', async () => {
    const editor = await open();
    const withProgress = vscode.window.withProgress;
    const source = new vscode.CancellationTokenSource();
    let shown = false;
    let finished = false;
    vscode.window.withProgress = (options, task) => {
      shown = true;
      assert.strictEqual(options.location, vscode.ProgressLocation.Notification);
      assert.strictEqual(options.cancellable, true);
      assert.strictEqual(options.title, `Calva: Formatting ${editor.document.fileName}`);
      return withProgress(options, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => source.cancel());
        try {
          return await task(progress, source.token);
        } finally {
          cancellation.dispose();
          finished = true;
        }
      });
    };
    try {
      const pending = formatter.formatPosition(editor);
      assert.strictEqual(shown, false);
      await sleep(100);
      assert.strictEqual(shown, false);
      await waitForCondition(() => shown);
      source.cancel();
      assert.strictEqual(await pending, false);
      await waitForCondition(() => finished);
      assert.strictEqual(editor.document.getText(), content);
    } finally {
      source.dispose();
      vscode.window.withProgress = withProgress;
    }
  });

  for (const command of ['format', 'paredit']) {
    test(`switching tabs during ${command} keeps user edits without a closed-editor error`, async () => {
      let editor: vscode.TextEditor;
      if (command === 'format') {
        editor = await open();
      } else {
        const raw = `{;force whole-collection formatting\n${Array.from(
          { length: 600 },
          (_, i) => `:key${i} {:children [1 2]\n:next [3 4]}`
        ).join('\n')}\n}`;
        const doc = await vscode.workspace.openTextDocument({ language: 'clojure', content: raw });
        editor = await vscode.window.showTextDocument(doc);
        const position = doc.positionAt(raw.indexOf(':children [') + ':children ['.length);
        editor.selection = new vscode.Selection(position, position);
        await sleep(100);
      }
      const doc = editor.document;
      const original = doc.getText();
      const request = formatterWorker.request;
      let started = false;
      formatterWorker.request = function (...args) {
        started = true;
        return request.apply(this, args);
      };
      try {
        const pending =
          command === 'format'
            ? formatter.formatPosition(editor)
            : vscode.commands.executeCommand('paredit.slurpSexpForward');
        await waitForCondition(() => started);
        const beforeSwitch = doc.getText();
        assert.strictEqual(beforeSwitch === original, command === 'format');
        const other = await vscode.workspace.openTextDocument({ content: 'another tab' });
        await vscode.window.showTextDocument(other, { preview: false });
        await waitForCondition(() => !vscode.window.visibleTextEditors.includes(editor));
        assert.strictEqual(await pending, command === 'paredit');
        assert.strictEqual(doc.getText(), beforeSwitch);
      } finally {
        formatterWorker.request = request;
        await vscode.window.showTextDocument(doc);
      }
    });
  }

  for (const hasChanges of [true, false]) {
    test(`switching tabs during comment formatting discards ${
      hasChanges ? 'edits' : 'an empty undo edit'
    }`, async () => {
      const raw = `(do\n${' (println 1)\n'.repeat(1800)})`;
      const text = hasChanges ? raw : formatter.formatCode(raw, vscode.EndOfLine.LF);
      const doc = await vscode.workspace.openTextDocument({ language: 'clojure', content: text });
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      editor.selections = [1, 4].map((line) => new vscode.Selection(line, 2, line, 2));
      const originalRequest = formatterWorker.request;
      let job: Parameters<typeof formatterWorker.request>[1];
      let finish: (result: FormatResult | undefined) => void;
      formatterWorker.request = (_key, requestedJob) => {
        job = requestedJob;
        return {
          promise: new Promise<FormatResult | undefined>((resolve) => (finish = resolve)),
          cancel: () => finish(undefined),
        };
      };
      const pending = vscode.commands.executeCommand('calva.toggleLineComment');
      // Attach rejection handling before moving the captured editor away.
      const completed = pending.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      );
      try {
        await waitForCondition(() => !!job);
        const edited = doc.getText();
        const result = runFormatJob(job);
        assert.strictEqual(result.changes.length > 0, hasChanges);
        const other = await vscode.workspace.openTextDocument({ content: 'another tab' });
        await vscode.window.showTextDocument(other, { preview: false });
        await waitForCondition(() => !vscode.window.visibleTextEditors.includes(editor));
        assert.strictEqual(doc.isClosed, false);
        finish(result);
        assert.strictEqual((await completed).error, undefined);
        assert.strictEqual(doc.getText(), edited);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      } finally {
        finish?.(undefined);
        await completed;
        formatterWorker.request = originalRequest;
        await vscode.window.showTextDocument(doc);
      }
    });
  }

  test('honors provider cancellation and recovers after termination', async () => {
    const editor = await open();
    const doc = editor.document;
    const source = new vscode.CancellationTokenSource();
    try {
      const pending = formatter.formatRangeEdits(
        doc,
        new vscode.Range(doc.positionAt(0), doc.positionAt(content.length)),
        source.token
      );
      source.cancel();
      assert.strictEqual(await pending, undefined);
      assert.strictEqual(doc.getText(), content);
      assert.ok(await formatter.formatPosition(editor));
      assert.notStrictEqual(doc.getText(), content);
    } finally {
      source.dispose();
    }
  });

  test('rejects a worker crash and formats successfully on the next request', async () => {
    const editor = await open();
    const pending = formatter.formatPosition(editor);
    const checked = assert.rejects(pending, /exited/);
    await (formatterWorker as any).worker.terminate();
    await checked;
    assert.strictEqual(editor.document.getText(), content);
    assert.ok(await formatter.formatPosition(editor));
  });

  test('keeps a locally formatted Paredit edit in one undo step', async () => {
    const raw = `{\n${Array.from(
      { length: 600 },
      (_, i) => `:key${i} {:children [1 2]\n:next [3 4]}`
    ).join('\n')}\n}`;
    const canonical = formatter.formatCode(raw, vscode.EndOfLine.LF);
    const doc = await vscode.workspace.openTextDocument({
      language: 'clojure',
      content: canonical,
    });
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const position = doc.positionAt(canonical.indexOf(':children [') + ':children ['.length);
    editor.selection = new vscode.Selection(position, position);
    await sleep(100);
    await vscode.commands.executeCommand('paredit.slurpSexpForward');
    await sleep(200);
    const changed = doc.getText();
    assert.notStrictEqual(changed, canonical);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await sleep(100);
    await vscode.commands.executeCommand('default:undo');
    await waitForCondition(() => doc.getText() === canonical);
    assert.strictEqual(doc.getText(), canonical);
    await vscode.commands.executeCommand('default:redo');
    await waitForCondition(() => doc.getText() === changed);
    assert.strictEqual(doc.getText(), changed);
  });
});
