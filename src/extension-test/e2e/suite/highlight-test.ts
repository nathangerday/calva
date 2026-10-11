import * as assert from 'assert';
import * as mocha from 'mocha';
import * as path from 'path';
import * as sinon from 'sinon';
import * as testUtil from './util';

import * as vscode from 'vscode';
import * as highlight from '../../../highlight/src/extension';

suite('Highlight suite', () => {
  const suite = 'Highlight';

  mocha.before(() => {
    testUtil.showMessage(suite, `suite starting!`);
  });

  mocha.after(() => {
    testUtil.showMessage(suite, `suite done!`);
  });

  test('activeEditor', async function () {
    testUtil.log(suite, 'activeEditor');

    const testFilePath = path.join(testUtil.testDataDir, 'test.clj');

    await testUtil.openFile(testFilePath);
    testUtil.log(suite, 'test.clj opened');

    await testUtil.waitForCondition(
      () => highlight.activeEditor?.document.uri.fsPath === testFilePath
    );
    assert.strictEqual(highlight.activeEditor?.document.uri.fsPath, testFilePath);

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    testUtil.log(suite, 'test.clj closed');

    await testUtil.waitForCondition(
      () => highlight.activeEditor?.document.uri.fsPath !== testFilePath
    );
  });
});

suite('Highlight split-view events', () => {
  let sandbox: sinon.SinonSandbox;
  let doc: vscode.TextDocument;
  let realEditor: vscode.TextEditor;
  let subscriptions: vscode.Disposable[];
  let events: Record<string, (...args: any[]) => void>;
  let options: Map<vscode.TextEditorDecorationType, vscode.DecorationRenderOptions>;
  let disposed: Set<vscode.TextEditorDecorationType>;
  let views: vscode.TextEditor[];
  let focused: vscode.TextEditor;
  let colors: string[];

  setup(async () => {
    const content = '(do\n' + ' (foo\n  [1])\n'.repeat(60) + ')';
    doc = await vscode.workspace.openTextDocument({ language: 'clojure', content });
    realEditor = await vscode.window.showTextDocument(doc);
    await testUtil.sleep(50);
    sandbox = sinon.createSandbox();
    events = {};
    subscriptions = [];
    options = new Map();
    disposed = new Set();
    colors = ['#123456', '#654321'];
    const configuration = vscode.workspace.getConfiguration;
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section, scope) => {
      const real = configuration(section, scope);
      if (section !== 'calva.highlight') {
        return real;
      }
      return Object.assign({}, real, {
        get: (key: string) => {
          if (key === 'bracketColors') {
            return colors;
          }
          if (
            [
              'cycleBracketColors',
              'enableBracketColors',
              'rainbowIndentGuides',
              'highlightActiveIndent',
            ].includes(key)
          ) {
            return true;
          }
          return real.get(key);
        },
      });
    });
    sandbox.stub(vscode.window, 'createTextEditorDecorationType').callsFake((opts) => {
      const type = {
        key: `split-test-${options.size}`,
        dispose: () => disposed.add(type),
      } as unknown as vscode.TextEditorDecorationType;
      options.set(type, opts);
      return type;
    });
    const hook = (owner: any, name: string, event: string) => {
      sandbox.stub(owner, name).callsFake((listener: (...args: any[]) => void) => {
        events[event] = listener;
        return new vscode.Disposable(() => undefined);
      });
    };
    hook(vscode.window, 'onDidChangeActiveTextEditor', 'active');
    hook(vscode.window, 'onDidChangeTextEditorSelection', 'selection');
    hook(vscode.window, 'onDidChangeTextEditorVisibleRanges', 'viewport');
    hook(vscode.window, 'onDidChangeVisibleTextEditors', 'views');
    hook(vscode.workspace, 'onDidChangeTextDocument', 'document');
    hook(vscode.workspace, 'onDidChangeConfiguration', 'config');
    sandbox.stub(vscode.window, 'activeTextEditor').get(() => focused);
    sandbox.stub(vscode.window, 'visibleTextEditors').get(() => views);
    views = [];
    focused = undefined;
    highlight.activate({ subscriptions } as vscode.ExtensionContext);
    events.config();
  });

  teardown(async () => {
    subscriptions.forEach((subscription) => subscription.dispose());
    sandbox.restore();
    // Restore real decoration types and the real active editor for other suites.
    highlight.highlight(realEditor);
    events.config();
    await testUtil.sleep(50);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  function view(first: number) {
    const decorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    const editor = {
      document: doc,
      visibleRanges: [new vscode.Range(first, 0, first + 8, 0)],
      selections: [new vscode.Selection(first, 1, first, 1)],
      setDecorations: (type: vscode.TextEditorDecorationType, ranges: vscode.DecorationOptions[]) =>
        decorations.set(type, ranges),
    } as unknown as vscode.TextEditor;
    return { editor, decorations };
  }

  function painted(split: ReturnType<typeof view>, first: number, last: number) {
    return [...split.decorations]
      .filter(([type]) => options.get(type)?.color)
      .flatMap(([, values]) => values)
      .filter(({ range }) => range.start.line >= first && range.start.line <= last).length;
  }

  test('scrolling an inactive split paints its viewport without changing focused guides', async () => {
    const a = view(1),
      b = view(40);
    views = [a.editor, b.editor];
    focused = a.editor;
    events.active(focused);
    events.views(views);
    await testUtil.sleep(50);
    assert.ok(painted(b, 40, 48) > 0);
    const interactive = [...a.decorations].filter(([type]) => {
      const opts = options.get(type);
      return opts?.dark?.backgroundColor || String(opts?.borderWidth).includes('1.5px');
    });
    assert.ok(interactive.some(([, ranges]) => ranges.length > 0));
    const activeBefore = interactive.map(([type, ranges]) => [type, [...ranges]]);
    Object.defineProperty(b.editor, 'visibleRanges', { value: [new vscode.Range(80, 0, 88, 0)] });
    events.viewport({ textEditor: b.editor });
    await testUtil.sleep(50);
    assert.ok(painted(b, 80, 88) > 0);
    assert.strictEqual(painted(b, 40, 48), 0);
    assert.deepStrictEqual(
      interactive.map(([type]) => [type, a.decorations.get(type)]),
      activeBefore
    );
    assert.strictEqual(highlight.activeEditor, a.editor);
  });

  test('document changes repaint both visible splits and newly visible views', async () => {
    const a = view(1),
      b = view(40);
    views = [a.editor];
    focused = a.editor;
    events.active(focused);
    await testUtil.sleep(50);
    views.push(b.editor);
    events.views(views);
    await testUtil.sleep(50);
    assert.ok(painted(b, 40, 48) > 0);
    a.decorations.clear();
    b.decorations.clear();
    events.document({ document: doc });
    await testUtil.sleep(50);
    assert.ok(painted(a, 1, 9) > 0);
    assert.ok(painted(b, 40, 48) > 0);
  });

  test('configuration resets dispose old styles and repaint every visible view', async () => {
    const a = view(1),
      b = view(40);
    views = [a.editor, b.editor];
    focused = a.editor;
    events.active(focused);
    events.views(views);
    await testUtil.sleep(50);
    const oldTypes = [...options.keys()];
    colors = ['#abcdef', '#fedcba'];
    events.config();
    await testUtil.sleep(50);
    assert.ok(oldTypes.every((type) => disposed.has(type)));
    assert.ok(
      [...b.decorations].some(
        ([type, ranges]) => options.get(type)?.color === '#abcdef' && ranges.length
      )
    );
    focused = b.editor;
    events.active(focused);
    await testUtil.sleep(50);
    for (const [type, ranges] of a.decorations) {
      const opts = options.get(type);
      if (
        !disposed.has(type) &&
        (opts?.dark?.backgroundColor || String(opts?.borderWidth).includes('1.5px'))
      ) {
        assert.deepStrictEqual(ranges, []);
      }
    }
  });
});
