import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient/node';
import { createClient } from '../../../lsp/client/client';

suite('Semantic token middleware', () => {
  const clients: lsp.LanguageClient[] = [];

  setup(() => {
    sinon.stub(lsp.LanguageClient.prototype, 'start').resolves();
  });

  teardown(async () => {
    for (const client of clients.splice(0)) {
      const watcher = client.clientOptions.synchronize.fileEvents as vscode.FileSystemWatcher;
      watcher.dispose();
      await client.dispose();
    }
    sinon.restore();
  });

  const clientWithLegend = (tokenTypes: string[]) => {
    const client = createClient({
      id: 'semantic-token-test',
      uri: vscode.Uri.file(__dirname),
      lsp_server_path: process.execPath,
    }).client;
    clients.push(client);
    sinon.stub(client, 'initializeResult').get(() => ({
      capabilities: { semanticTokensProvider: { legend: { tokenTypes, tokenModifiers: [] } } },
    }));
    return client;
  };

  const full = async (client: lsp.LanguageClient, tokens: vscode.SemanticTokens | null) =>
    client.middleware.provideDocumentSemanticTokens(
      undefined,
      new vscode.CancellationTokenSource().token,
      () => tokens
    );

  const range = async (client: lsp.LanguageClient, tokens: vscode.SemanticTokens | null) =>
    client.middleware.provideDocumentRangeSemanticTokens(
      undefined,
      new vscode.Range(0, 0, 0, 20),
      new vscode.CancellationTokenSource().token,
      () => tokens
    );

  test('full and range providers retain columns with comment at legend index zero', async () => {
    const client = clientWithLegend(['comment', 'keyword']);
    const tokens = new vscode.SemanticTokens(
      new Uint32Array([0, 1, 6, 0, 0, 0, 8, 4, 1, 0]),
      'base'
    );
    for (const provide of [full, range]) {
      const result = await provide(client, tokens);
      assert.deepStrictEqual(Array.from(result.data), [0, 9, 4, 1, 0]);
      assert.strictEqual(result.resultId, undefined);
    }
  });

  test('clients use their own advertised legends', async () => {
    const first = clientWithLegend(['comment', 'keyword']);
    const second = clientWithLegend(['keyword', 'comment']);
    const data = new Uint32Array([0, 1, 3, 0, 0, 0, 5, 3, 1, 0]);
    assert.deepStrictEqual(
      Array.from((await full(first, new vscode.SemanticTokens(data))).data),
      [0, 6, 3, 1, 0]
    );
    assert.deepStrictEqual(
      Array.from((await full(second, new vscode.SemanticTokens(data))).data),
      [0, 1, 3, 0, 0]
    );
  });

  test('a missing comment type leaves tokens and resultId untouched', async () => {
    const client = clientWithLegend(['keyword']);
    const tokens = new vscode.SemanticTokens(new Uint32Array([0, 1, 3, 0, 0]), 'base');
    assert.strictEqual(await full(client, tokens), tokens);
    assert.strictEqual(await range(client, tokens), tokens);
  });

  test('null results stay null for both providers', async () => {
    const client = clientWithLegend(['comment']);
    assert.strictEqual(await full(client, null), null);
    assert.strictEqual(await range(client, null), null);
  });
});
