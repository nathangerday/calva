import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import { prepareLspBundle } from '../../../../scripts/prepare-lsp-bundle';

describe('Pinned LSP bundle packaging', () => {
  let root: string;
  let target: string;
  const content = 'pinned-test-artifact';
  const digest = crypto.createHash('sha256').update(content).digest('hex');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'calva-bundle-build-'));
    target = path.join(root, 'bundled', 'clojure-lsp', 'clojure-lsp.jar');
    fs.writeFileSync(
      path.join(root, 'lsp-bundle.json'),
      JSON.stringify({
        revision: 'a'.repeat(40),
        sha256: digest,
        artifactUrl: 'https://example.invalid/clojure-lsp.jar',
      })
    );
  });

  afterEach(() => {
    sinon.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reuses a verified artifact offline', async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const download = sinon.stub(globalThis, 'fetch').rejects(new Error('offline'));
    assert.strictEqual(await prepareLspBundle(root), target);
    assert.strictEqual(download.called, false);
  });

  it('downloads and verifies a missing artifact', async () => {
    const download = sinon.stub(globalThis, 'fetch').resolves(new Response(content));
    assert.strictEqual(await prepareLspBundle(root), target);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), content);
    assert.strictEqual(download.callCount, 1);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['clojure-lsp.jar']);
  });

  it('rejects a mismatched download without replacing an existing artifact', async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'previous-artifact');
    sinon.stub(globalThis, 'fetch').resolves(new Response('incorrect-download'));
    await assert.rejects(prepareLspBundle(root), /checksum mismatch/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'previous-artifact');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['clojure-lsp.jar']);
  });

  it('fails packaging on a missing public release asset', async () => {
    sinon.stub(globalThis, 'fetch').resolves(new Response('Not found', { status: 404 }));
    await assert.rejects(prepareLspBundle(root), /HTTP 404/);
    assert.strictEqual(fs.existsSync(target), false);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), []);
  });
});
