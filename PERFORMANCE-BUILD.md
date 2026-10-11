# Calva performance builds

This branch packages the patched Clojure LSP from
[nathangerday/clojure-lsp](https://github.com/nathangerday/clojure-lsp/tree/perf/large-project-editing)
inside the VSIX. Install the VSIX and ensure Java is available where the extension
runs. For a WSL workspace, Java must be available inside WSL.

Remove any previous `calva.clojureLspPath` override to use the included server.
Explicit paths continue to take precedence. `calva.clojureLspVersion` applies to
the upstream downloader only, used by builds without a bundled server. Bundled
servers are updated with Calva; background upstream downloads are skipped.

## Build from a single checkout

```sh
git clone --branch perf/large-document-editing https://github.com/nathangerday/calva.git
cd calva
npm ci
npm run package-vsix
```

Use the Node version declared by `package.json`, Java, and the normal Calva
Clojure build prerequisites. `vscode:prepublish` downloads the exact public release
artifact pinned in [lsp-bundle.json](lsp-bundle.json), verifies its SHA-256, and
packages it. A verified local artifact can be reused offline. A failed download
or checksum fails packaging. The generated JAR is ignored by Git; its source
revision, download URL, checksum, and MIT license are tracked.

There is no need to clone LSP to use or build Calva. Clone its repository when
changing the server itself. LSP still runs in its own Java process.

## Update the server

1. Commit and test the server changes on the LSP performance branch.
2. Build the production JAR, publish a new release at that source commit, and
   upload the JAR and SHA-256 file. Keep existing release assets unchanged.
3. Update `lsp-bundle.json` to that source commit, release, URL, and SHA-256.
4. Run `npm run prepare-lsp-bundle`, build/test/package Calva, and commit the pin
   update alongside any required client changes.
