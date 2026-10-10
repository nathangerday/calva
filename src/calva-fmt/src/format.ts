import * as vscode from 'vscode';
import * as config from '../../formatter-config';
import * as outputWindow from '../../repl-window/repl-window-doc';
import * as docMirror from '../../doc-mirror/index';
import * as cljsLib from '../../../out/cljs-lib/cljs-lib';
import * as util from '../../utilities';
import * as respacer from './respacer';
import * as cursorDocUtils from '../../cursor-doc/utilities';
import _ = require('lodash');
import type * as tokenCursor from '../../cursor-doc/token-cursor';
import { FormatJob, runFormatJob } from './format-job';
import { formatterWorker } from './worker-client';
import { getScannerMaxLength } from '../../cursor-doc/model';
import { LARGE_FORMAT_RANGE } from './local-ranges';
import * as state from '../../state';
import * as healer from './healer';

/**
 * Calculates the indent edit needed for a position without performing it.
 * Returns a TextEdit array suitable for returning from a formatting provider.
 * Allows VS Code to handle cursor positioning.
 */
export function calculateIndentEdit(
  position: vscode.Position,
  document: vscode.TextDocument
): vscode.TextEdit[] {
  const indent = docMirror.getIndent(
    docMirror.getDocument(document).model.lineInputModel,
    docMirror.getDocumentOffset(document, position),
    config.getConfigNow(document)
  );
  const currentIndent = document.lineAt(position.line).firstNonWhitespaceCharacterIndex;
  const delta = currentIndent - indent;
  const pos = new vscode.Position(position.line, 0);

  if (delta > 0) {
    // Need to remove whitespace
    return [vscode.TextEdit.delete(new vscode.Range(pos, new vscode.Position(pos.line, delta)))];
  } else if (delta < 0) {
    // Need to add whitespace
    const str = ' '.repeat(-delta);
    return [vscode.TextEdit.insert(pos, str)];
  }

  // No change needed
  return [];
}

/**
 * @deprecated This function performs edits directly and causes cursor jumping (issue #2071).
 * Use calculateIndentEdit() instead for new code.
 */
export async function indentPosition(position: vscode.Position, document: vscode.TextDocument) {
  const editor = util.getActiveTextEditor();
  const pos = new vscode.Position(position.line, 0);
  const indent = docMirror.getIndent(
    docMirror.getDocument(document).model.lineInputModel,
    docMirror.getDocumentOffset(document, position),
    await config.getConfig(document)
  );
  const newPosition = new vscode.Position(position.line, indent);
  const delta = document.lineAt(position.line).firstNonWhitespaceCharacterIndex - indent;
  if (delta > 0) {
    return editor
      .edit((edits) => edits.delete(new vscode.Range(pos, new vscode.Position(pos.line, delta))), {
        undoStopAfter: false,
        undoStopBefore: false,
      })
      .then((onFulfilled) => {
        editor.selections = [new vscode.Selection(newPosition, newPosition)];
        return onFulfilled;
      });
  } else if (delta < 0) {
    const str = ' '.repeat(-delta);
    return editor
      .edit((edits) => edits.insert(pos, str), {
        undoStopAfter: false,
        undoStopBefore: false,
      })
      .then((onFulfilled) => {
        editor.selections = [new vscode.Selection(newPosition, newPosition)];
        return onFulfilled;
      });
  }
}

/** Execute large jobs off the extension host and discard results when the
 * originating document changes, closes, or its provider request is canceled.
 */
async function documentFormatJob(
  doc: vscode.TextDocument,
  job: FormatJob,
  token?: vscode.CancellationToken
) {
  const version = doc.version;
  const valid = () => !doc.isClosed && doc.version === version && !token?.isCancellationRequested;
  if (!valid()) {
    return undefined;
  }
  const size = job.kind === 'indexes' ? job.range[1] - job.range[0] : job.text.length;
  if (size < LARGE_FORMAT_RANGE) {
    return runFormatJob(job);
  }
  const request = formatterWorker.request(doc.uri.toString(), job);
  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === doc && doc.version !== version) {
        request.cancel();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((closed) => {
      if (closed === doc) {
        request.cancel();
      }
    }),
  ];
  if (token) {
    subscriptions.push(token.onCancellationRequested(() => request.cancel()));
  }
  // Avoid flicker during quick edits while making long or queued jobs visible.
  const progressTimer = setTimeout(() => {
    void vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Calva: Formatting ${doc.fileName.split(/[\\/]/).pop()}`,
          cancellable: true,
        },
        (_progress, cancellationToken) => {
          const cancellation = cancellationToken.onCancellationRequested(request.cancel);
          // The original await below owns formatter failures. Progress simply closes.
          return request.promise
            .then(
              () => undefined,
              () => undefined
            )
            .finally(() => cancellation.dispose());
        }
      )
      .then(undefined, (error) => console.error('Formatting progress failed', error));
  }, 750);
  try {
    const result = await request.promise;
    return valid() ? result : undefined;
  } finally {
    clearTimeout(progressTimer);
    subscriptions.forEach((subscription) => subscription.dispose());
  }
}

/** undefined means canceled; ranges inside a string/comment have no edits. */
async function rangeReformatChanges(
  document: vscode.TextDocument,
  originalRange: vscode.Range,
  onType: boolean,
  token?: vscode.CancellationToken
): Promise<respacer.WhitespaceChange[] | undefined> {
  const mirrorDoc = docMirror.getDocument(document);
  const startIndex = document.offsetAt(originalRange.start);
  const cursor = mirrorDoc.getTokenCursor(startIndex);
  if (startIndex !== 0 && (cursor.withinString() || cursor.withinComment())) {
    return [];
  }
  const endIndex = document.offsetAt(originalRange.end);
  const result = await documentFormatJob(
    document,
    {
      kind: 'range',
      text: document.getText(originalRange),
      range: [startIndex, endIndex],
      indexes: [],
      eol: _convertEolNumToStringNotation(document.eol),
      onType,
      startColumn: originalRange.start.character,
      fullDocument: startIndex === 0 && endIndex === document.getText().length,
      config: config.getConfigNow(document),
      scannerMaxLength: getScannerMaxLength(),
    },
    token
  );
  return result?.changes;
}

export async function formatRangeEdits(
  document: vscode.TextDocument,
  originalRange: vscode.Range,
  token?: vscode.CancellationToken
): Promise<vscode.TextEdit[] | undefined> {
  if (outputWindow.isReplWindowDoc(document)) {
    return [];
  }
  const version = document.version;
  const changes = await rangeReformatChanges(document, originalRange, false, token);
  if (document.isClosed || document.version !== version || token?.isCancellationRequested) {
    return undefined;
  }
  return changes?.map((chg) =>
    vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(chg.start), document.positionAt(chg.end)),
      chg.text
    )
  );
}

export async function formatRange(document: vscode.TextDocument, range: vscode.Range) {
  const version = document.version;
  const edits = await formatRangeEdits(document, range);
  if (!edits || document.isClosed || document.version !== version) {
    return false;
  }
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.set(document.uri, edits);
  return vscode.workspace.applyEdit(wsEdit);
}

/** [start,end] of range to reformat with attention to offset 'index', or [-1,-1] to reformat the whole document */
export function formatDocIndexRange(
  doc: vscode.TextDocument,
  index: number,
  extraConfig: CljFmtConfig
): [number, number] {
  const mDoc = docMirror.getDocument(doc);
  if (mDoc.model.documentVersion != doc.version) {
    console.warn('Model is stale; skipping reformatting');
    return;
  }
  const cursor = mDoc.getTokenCursor(index);

  // If a top-level form "needs" formatting and is indented, reformat the whole document:
  const formatRangeSmall = _calculateFormatRange(extraConfig, cursor, index);
  return formatRangeSmall ? formatRangeSmall : [-1, -1];
}

export async function formatDocIndexesInfo(
  doc: vscode.TextDocument,
  onType: boolean,
  indexOfRange: number,
  cursorIndexes: number[],
  extraConfig: CljFmtConfig = {},
  knownFormatRange?: [number, number],
  localRange = false
) {
  const mDoc = docMirror.getDocument(doc);
  const formatRange = knownFormatRange ?? formatDocIndexRange(doc, indexOfRange, extraConfig);
  if (!formatRange || formatRange[0] < 0) {
    return undefined;
  }
  const cursor = mDoc.getTokenCursor(1 + formatRange[0]);
  const range = new vscode.Range(doc.positionAt(formatRange[0]), doc.positionAt(formatRange[1]));
  const result = await documentFormatJob(doc, {
    kind: localRange ? 'local' : 'indexes',
    text: localRange ? doc.getText(range) : doc.getText(),
    range: formatRange,
    indexes: localRange
      ? cursorIndexes
          .filter((p) => p >= formatRange[0] && p < formatRange[1])
          .map((p) => p - formatRange[0])
      : cursorIndexes,
    eol: _convertEolNumToStringNotation(doc.eol),
    onType,
    startColumn: range.start.character,
    config: {
      ...config.getConfigNow(doc),
      ...extraConfig,
      'comment-form?': !localRange && util.isCommentFormHead(cursor.getFunctionName()),
    },
    scannerMaxLength: getScannerMaxLength(),
  });
  return result
    ? {
        ...result,
        range: new vscode.Range(doc.positionAt(result.range[0]), doc.positionAt(result.range[1])),
      }
    : undefined;
}

interface CljFmtConfig {
  'format-depth'?: number;
  'align-associative?'?: boolean;
  'remove-multiple-non-indenting-spaces?'?: boolean;
}

/** [Start,end] of the range to reformat around the cursor, with special cases:
 * - Undefined if not within a top-level form.
 * - Undefined if the form to reformat would be a top-level form that is indented.
 */
function _calculateFormatRange(
  config: CljFmtConfig,
  cursor: tokenCursor.LispTokenCursor,
  index: number
): [number, number] {
  const rangeForTopLevelForm = cursor.rangeForDefun(index, false);
  if (!rangeForTopLevelForm) {
    return;
  }
  const topLevelStartCursor = cursor.doc.getTokenCursor(rangeForTopLevelForm[0]);
  const rangeForList = cursor.rangeForList(1);
  if (rangeForList) {
    if (rangeForList[0] === rangeForTopLevelForm[0]) {
      if (topLevelStartCursor.rowCol[1] !== 0) {
        const STOP_INFORMING = 'calvaFormat:stopInformingAboutTopLevelAlignment';
        if (!state.extensionContext.globalState.get(STOP_INFORMING)) {
          void vscode.window
            .showInformationMessage(
              'You are formatting a top level form that is not aligned with the left margin. Calva will not align it for you, because it promises to only format the content of the form. Please align the opening bracket of the form with the left margin and format again. You can also format the whole document by placing the cursor outside of the form and format.',
              'OK',
              "Don't show again"
            )
            .then((selection) => {
              if (selection === "Don't show again") {
                void state.extensionContext.globalState.update(STOP_INFORMING, true);
              }
            });
        }
      }
    }
    return rangeForList;
  }

  const rangeForCurrentForm = cursor.rangeForCurrentForm(index);
  if (!_.isUndefined(rangeForCurrentForm)) {
    if (rangeForCurrentForm[0] === rangeForTopLevelForm[0]) {
      if (topLevelStartCursor.rowCol[1] !== 0) {
        const formStart = rangeForCurrentForm[0];
        // Allow formatting when the form is directly preceded by a #_ discard
        // macro. Inserting '#_' shifts the form to column 2 but the enclosing
        // top-level construct (the #_ reader macro) starts at column 0, so it
        // is safe and desirable to reformat the form contents.
        const precededByIgnore =
          formStart >= 2 && cursor.doc.getText(formStart - 2, formStart) === '#_';
        if (!precededByIgnore) {
          return;
        }
      }
    }
    if (rangeForCurrentForm.includes(index)) {
      return rangeForCurrentForm;
    }
  }
}

export async function formatPosition(
  editor: vscode.TextEditor,
  onType: boolean = false,
  extraConfig: CljFmtConfig = {}
): Promise<boolean> {
  const doc: vscode.TextDocument = editor.document;
  const version = doc.version;
  const ranges = editor.selections
    .map((sel) => doc.offsetAt(sel.active))
    .map((index) => formatDocIndexRange(doc, index, extraConfig))
    .filter((rng) => rng != undefined);
  const isWholeDoc = ranges.filter((r) => r[0] == -1 && r[1] == -1).length > 0;
  let orderedChanges = undefined;
  if (isWholeDoc) {
    // Output/REPL window holds prompts etc. The formatter cannot format it. Do not try.
    if (outputWindow.isReplWindowDoc(editor.document)) {
      return Promise.resolve(false);
    }
    orderedChanges = await rangeReformatChanges(
      doc,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      onType
    );
  } else {
    const dedupedRanges = docMirror.nonOverlappingRanges(ranges);
    const cursorOffsets = editor.selections.map((sel) => doc.offsetAt(sel.active));
    orderedChanges = [];
    for (const range of dedupedRanges) {
      const info = await formatDocIndexesInfo(doc, onType, range[0], cursorOffsets, extraConfig);
      if (!info || doc.isClosed || doc.version !== version) {
        return false;
      }
      orderedChanges.push(...info.changes);
    }
    orderedChanges.sort((a, b) => b.start - a.start);
  }
  if (
    !orderedChanges ||
    doc.isClosed ||
    doc.version !== version ||
    !vscode.window.visibleTextEditors.includes(editor)
  ) {
    return false;
  }
  return editor.edit((textEditorEdit) => {
    let monotonicallyDecreasing = -1;
    orderedChanges.forEach((change) => {
      const pos1 = doc.positionAt(change.start);
      const pos2 = doc.positionAt(change.end);
      // with multiple cursors, especially near each other, the edits may overlap.
      // VS Code rejects overlapping edits. Skip them:
      if (monotonicallyDecreasing == -1 || change.end < monotonicallyDecreasing) {
        const range = new vscode.Range(pos1, pos2);
        textEditorEdit.replace(range, change.text);
        monotonicallyDecreasing = change.start;
      }
    });
  });
}

// Debounce format-as-you-type and toss it aside if User seems still to be working
// Increased from 250ms to 400ms to reduce cursor jumping issues
let scheduledFormatCircumstances = undefined;
const scheduledFormatDelayMs = 400;

function formatPositionCallback(extraConfig: CljFmtConfig) {
  if (
    scheduledFormatCircumstances &&
    vscode.window.activeTextEditor === scheduledFormatCircumstances['editor'] &&
    vscode.window.activeTextEditor.document.version ==
      scheduledFormatCircumstances['documentVersion']
  ) {
    void formatPosition(scheduledFormatCircumstances['editor'], true, extraConfig)
      .catch((error) => console.error('Scheduled formatting failed', error))
      .finally(() => {
        scheduledFormatCircumstances = undefined;
      });
  }
  // do not anull scheduledFormatCircumstances. Another callback might have been scheduled
}

export function scheduleFormatAsType(editor: vscode.TextEditor, extraConfig: CljFmtConfig = {}) {
  const expectedDocumentVersionUponCallback = 1 + editor.document.version;
  if (
    !scheduledFormatCircumstances ||
    expectedDocumentVersionUponCallback != scheduledFormatCircumstances['documentVersion']
  ) {
    // Unschedule (if scheduled) & reschedule: best effort to reformat at a quiet time
    if (scheduledFormatCircumstances?.timeoutId) {
      clearTimeout(scheduledFormatCircumstances?.timeoutId);
    }
    scheduledFormatCircumstances = {
      editor: editor,
      documentVersion: expectedDocumentVersionUponCallback,
      timeoutId: setTimeout(function () {
        formatPositionCallback(extraConfig);
      }, scheduledFormatDelayMs),
    };
  }
}

export function formatPositionCommand(editor: vscode.TextEditor) {
  return formatPosition(editor, false);
}

export function alignPositionCommand(editor: vscode.TextEditor) {
  return formatPosition(editor, true, { 'align-associative?': true });
}

export function trimWhiteSpacePositionCommand(editor: vscode.TextEditor) {
  return formatPosition(editor, false, { 'remove-multiple-non-indenting-spaces?': true });
}

export function formatCode(code: string, eol: number, fullDocument: boolean = true) {
  const d = {
    'range-text': code,
    eol: _convertEolNumToStringNotation(eol),
    config: { ...config.getConfigNow(), 'full-document?': fullDocument },
  };
  const result = cljsLib.jsify(cljsLib.formatText(d));
  if (!result['error']) {
    return result['range-text'];
  } else {
    console.error('Error in `formatCode`:', result['error']);
    return code;
  }
}

async function _formatRange(
  rangeText: string,
  allText: string,
  range: number[],
  eol: string
): Promise<string | undefined> {
  const d = {
    'range-text': rangeText,
    'all-text': allText,
    range: range,
    eol: eol,
    config: { ...(await config.getConfig()), 'full-document?': false },
  };
  const result = cljsLib.jsify(cljsLib.formatTextAtRange(d));
  if (!result['error']) {
    return result['range-text'];
  }
}

function _convertEolNumToStringNotation(eol: vscode.EndOfLine) {
  return eol == 2 ? '\r\n' : '\n';
}
