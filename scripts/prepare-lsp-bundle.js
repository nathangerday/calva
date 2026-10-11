const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function prepareLspBundle(root = path.resolve(__dirname, '..')) {
  const pin = JSON.parse(await fs.promises.readFile(path.join(root, 'lsp-bundle.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(pin.revision) || !/^[a-f0-9]{64}$/.test(pin.sha256)) {
    throw new Error('lsp-bundle.json must pin a full source revision and SHA-256.');
  }
  const directory = path.join(root, 'bundled', 'clojure-lsp');
  const target = path.join(directory, 'clojure-lsp.jar');
  try {
    if ((await sha256(target)) === pin.sha256) {
      console.log(`Bundled Clojure LSP already verified (${pin.revision}).`);
      return target;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.promises.mkdir(directory, { recursive: true });
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(directory, '.download-'));
  try {
    console.log(`Downloading pinned Clojure LSP from ${pin.artifactUrl}`);
    const response = await fetch(pin.artifactUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`Clojure LSP download failed: HTTP ${response.status}.`);
    }
    const temporaryFile = path.join(temporaryDirectory, 'clojure-lsp.jar');
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporaryFile, { flags: 'wx' })
    );
    const actual = await sha256(temporaryFile);
    if (actual !== pin.sha256) {
      throw new Error(`Clojure LSP checksum mismatch: expected ${pin.sha256}, received ${actual}.`);
    }
    await fs.promises.rename(temporaryFile, target);
    console.log(`Bundled Clojure LSP verified (${pin.revision}).`);
    return target;
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = { prepareLspBundle };

if (require.main === module) {
  prepareLspBundle().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
