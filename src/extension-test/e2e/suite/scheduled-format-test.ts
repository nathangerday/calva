import * as assert from 'assert';
import * as vscode from 'vscode';
import * as formatter from '../../../calva-fmt/src/format';
import { FormatJob, FormatResult } from '../../../calva-fmt/src/format-job';
import { formatterWorker } from '../../../calva-fmt/src/worker-client';
import { sleep, waitForCondition } from './util';

suite('Scheduled formatting ownership', () => {
  const content = `(do\n${' (println 1)\n'.repeat(1800)})`;
  let requests: { key: string; job: FormatJob; finish: () => void }[];
  let originalRequest: typeof formatterWorker.request;
  let documents: vscode.TextDocument[];

  suiteSetup(async () => {
    await vscode.extensions.getExtension('betterthantomorrow.calva').activate();
  });

  setup(() => {
    requests = [];
    documents = [];
    originalRequest = formatterWorker.request;
    formatterWorker.request = (key, job) => {
      let resolve: (result: FormatResult | undefined) => void;
      const promise = new Promise<FormatResult | undefined>((done) => (resolve = done));
      requests.push({
        key,
        job,
        finish: () =>
          resolve({
            formattedText: job.text,
            previousText: job.text,
            range: job.range,
            changes: [],
          }),
      });
      return { promise, cancel: () => resolve(undefined) };
    };
  });

  teardown(async () => {
    requests.forEach((request) => request.finish());
    await sleep(20);
    formatterWorker.request = originalRequest;
    for (const document of documents) {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  async function open() {
    const doc = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    documents.push(doc);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(0, 2, 0, 2);
    return editor;
  }

  async function edit(editor: vscode.TextEditor) {
    formatter.scheduleFormatAsType(editor);
    assert.ok(await editor.edit((builder) => builder.insert(new vscode.Position(1, 0), ' ')));
  }

  test('an edit canceling a worker keeps its newer scheduled format', async () => {
    const editor = await open();
    await edit(editor);
    await waitForCondition(() => requests.length === 1);
    await edit(editor);
    await waitForCondition(() => requests.length === 2);
    assert.strictEqual(requests[1].key, editor.document.uri.toString());
    requests[1].finish();
  });

  test('equal document versions in different editors do not share a schedule', async () => {
    const first = await open();
    formatter.scheduleFormatAsType(first);
    const second = await open();
    assert.strictEqual(first.document.version, second.document.version);
    await edit(second);
    await waitForCondition(() => requests.length === 1);
    assert.strictEqual(requests[0].key, second.document.uri.toString());
    requests[0].finish();
  });
});
