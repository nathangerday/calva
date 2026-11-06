import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as config from '../../../config';
import * as util from '../../../utilities';
import {
  checkForUpgrade,
  ensureLSPServer,
  getClojureLspPath,
} from '../../../lsp/client/downloader';

suite('Bundled LSP selection', () => {
  let root: string;
  let bundledPath: string;
  let storageDir: string;
  let context: vscode.ExtensionContext;
  let currentConfig: ReturnType<typeof config.getConfig>;
  let latestVersion: sinon.SinonStub;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'calva-bundle-selection-'));
    bundledPath = path.join(root, 'bundled', 'clojure-lsp', 'clojure-lsp.jar');
    storageDir = path.join(root, 'storage', 'clojure-lsp');
    context = {
      extensionPath: root,
      globalStorageUri: vscode.Uri.file(path.join(root, 'storage')),
    } as vscode.ExtensionContext;
    currentConfig = { ...config.getConfig(), clojureLspPath: '', clojureLspVersion: 'latest' };
    sinon.stub(config, 'getConfig').callsFake(() => currentConfig);
    latestVersion = sinon.stub(util, 'getLatestGitHubReleaseTag').resolves('');
  });

  teardown(() => {
    sinon.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const createBundle = () => {
    fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
    fs.writeFileSync(bundledPath, 'bundled-server');
  };

  const createDownloadedServer = () => {
    fs.mkdirSync(storageDir, { recursive: true });
    const filename = getClojureLspPath(storageDir);
    fs.writeFileSync(filename, 'downloaded-server');
    return filename;
  };

  test('the bundle takes precedence over a previously downloaded native server', async () => {
    createBundle();
    const downloaded = createDownloadedServer();
    currentConfig.clojureLspVersion = 'nightly';
    assert.strictEqual(await ensureLSPServer(context), bundledPath);
    await checkForUpgrade(context);
    assert.strictEqual(latestVersion.called, false);
    assert.strictEqual(fs.existsSync(path.join(storageDir, '.downloading')), false);
    assert.strictEqual(fs.readFileSync(downloaded, 'utf8'), 'downloaded-server');
  });

  test('an explicit path overrides the bundle and skips upstream upgrades', async () => {
    createBundle();
    currentConfig.clojureLspPath = path.join(root, 'custom.jar');
    assert.strictEqual(await ensureLSPServer(context), currentConfig.clojureLspPath);
    await checkForUpgrade(context);
    assert.strictEqual(latestVersion.called, false);
    assert.strictEqual(fs.existsSync(storageDir), false);
  });

  test('forcing download keeps the bundle and explains how it is updated', async () => {
    createBundle();
    const message = sinon.stub(vscode.window, 'showInformationMessage').resolves();
    assert.strictEqual(await ensureLSPServer(context, true), bundledPath);
    assert.strictEqual(message.callCount, 1);
    assert.strictEqual(latestVersion.called, false);
    assert.strictEqual(fs.existsSync(storageDir), false);
  });

  test('unbundled builds still select and update their downloaded server', async () => {
    const downloaded = createDownloadedServer();
    assert.strictEqual(await ensureLSPServer(context), downloaded);
    await checkForUpgrade(context);
    assert.strictEqual(latestVersion.callCount, 1);
    assert.strictEqual(fs.readFileSync(downloaded, 'utf8'), 'downloaded-server');
  });

  test('a directory named like the JAR is not selected as a server', async () => {
    fs.mkdirSync(bundledPath, { recursive: true });
    const downloaded = createDownloadedServer();
    assert.strictEqual(await ensureLSPServer(context), downloaded);
  });
});
