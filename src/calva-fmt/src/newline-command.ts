import * as vscode from 'vscode';
import * as docMirror from '../../doc-mirror';
import * as config from '../../formatter-config';
import * as outputWindow from '../../repl-window/repl-window-doc';
import { newlineInsertion } from './newline';

let pendingNewline: Promise<unknown> = Promise.resolve();

export function newlineEnabled(document?: vscode.TextDocument): boolean {
  return (
    document?.languageId === 'clojure' &&
    !outputWindow.isReplWindowDoc(document) &&
    !!vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnType') &&
    !!vscode.workspace.getConfiguration('calva.fmt', document).get<boolean>('newIndentEngine')
  );
}

/** Insert the newline and its final indentation in one edit. Returning edits
 * from an on-type provider necessarily corrects an already-inserted newline.
 */
export function newlineCommand(): Thenable<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return vscode.commands.executeCommand('type', { text: '\n' });
  }
  // Keybindings do not await previous invocations. Plan each Enter only after
  // the preceding one settles so rapid repeats do not share a document version.
  const result = pendingNewline.then(() => insertNewline(editor, true));
  pendingNewline = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function insertNewline(editor: vscode.TextEditor, retry: boolean): Promise<unknown> {
  if (vscode.window.activeTextEditor !== editor || editor.document.isClosed) {
    return false;
  }
  const nativeNewline = () => vscode.commands.executeCommand('type', { text: '\n' });
  if (
    !newlineEnabled(editor.document) ||
    editor.selections.some((selection) => !selection.isEmpty)
  ) {
    return nativeNewline();
  }
  const document = editor.document;
  const mirror = docMirror.tryToGetDocument(document);
  if (!mirror || mirror.model.documentVersion !== document.version) {
    return nativeNewline();
  }
  const formatterConfig = config.getConfigNow(document);
  const autoIndent = vscode.workspace.getConfiguration('editor', document).get('autoIndent');
  const expandEmptyPairs = ['brackets', 'advanced', 'full'].includes(autoIndent as string);
  const insertions = editor.selections.map((selection) => {
    const start = document.offsetAt(selection.active);
    const insertion = newlineInsertion(
      mirror.model.lineInputModel,
      start,
      formatterConfig,
      expandEmptyPairs
    );
    return insertion ? { start, ...insertion } : undefined;
  });
  if (insertions.some((insertion) => !insertion)) {
    return nativeNewline();
  }
  const ordered = [...insertions].sort((a, b) => a.start - b.start);
  // VS Code merges batches of 1000+ operations into one replacement, losing
  // the separate marker movement that places each caret on the inner line.
  const operationCount = insertions.reduce(
    (count, insertion) => count + 1 + Number(insertion.end > insertion.start),
    0
  );
  if (
    operationCount >= 1000 ||
    ordered.some((insertion, i) => i > 0 && ordered[i - 1].end >= insertion.start)
  ) {
    return nativeNewline();
  }
  const applied = await editor.edit((edit) => {
    for (const insertion of insertions) {
      const position = document.positionAt(insertion.start);
      if (insertion.closingText !== undefined) {
        // A nonempty replacement keeps the cursor marker at the start. Insert
        // the inner newline separately so it advances only to the inner line,
        // before the closing newline, in the same transaction (also on undo).
        edit.replace(
          new vscode.Range(position, document.positionAt(insertion.end)),
          insertion.closingText
        );
      } else if (insertion.end > insertion.start) {
        edit.delete(new vscode.Range(position, document.positionAt(insertion.end)));
      }
      // Insert moves the cursor after the text; replacing a nonempty trailing
      // whitespace range can keep it at the start of the replaced range.
      edit.insert(position, insertion.text);
    }
  });
  if (vscode.window.activeTextEditor !== editor || document.isClosed) {
    return applied;
  }
  if (applied) {
    // Extension edits move cursor markers but do not scroll like native typing.
    // Reveal the current selection without restoring a stale cursor position.
    editor.revealRange(editor.selection);
  } else if (retry) {
    // A concurrent edit can invalidate the document version. Replan once using
    // the same active editor's current document and selections.
    return insertNewline(editor, false);
  } else {
    // Native typing can race both attempts. Preserve the Enter rather than
    // silently dropping it; the active-editor guard above still applies.
    return nativeNewline();
  }
  return applied;
}
