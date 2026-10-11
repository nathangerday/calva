import * as vscode from 'vscode';
import * as isEqual from 'lodash.isequal';
import * as nodeUtil from 'util';
import * as docMirror from '../../doc-mirror/index';
import { getStructuralIndex } from '../../cursor-doc/structural-index';
import { hasIndentGuide, visibleHighlights } from './visible';
import * as utilities from '../../utilities';
import * as pareditConfig from '../../cursor-doc/paredit-config';
import * as config from '../../config';

function position_str(pos: vscode.Position) {
  return '' + pos.line + ':' + pos.character;
}
function is_clojure(editor) {
  return !!editor && editor.document.languageId === 'clojure';
}

// Exported for integration testing purposes
export let activeEditor: vscode.TextEditor;

let rainbowColors,
  rainbowTypes: vscode.TextEditorDecorationType[],
  rainbowGuidesTypes: vscode.TextEditorDecorationType[],
  activeGuidesTypes: vscode.TextEditorDecorationType[],
  cycleBracketColors,
  misplacedBracketStyle,
  misplacedType: vscode.TextEditorDecorationType,
  matchedBracketStyle,
  matchedType: vscode.TextEditorDecorationType,
  commentFormStyle,
  commentFormType: vscode.TextEditorDecorationType,
  ignoredFormStyle,
  ignoredFormType: vscode.TextEditorDecorationType,
  ignoredTopLevelFormStyle,
  ignoredTopLevelFormType: vscode.TextEditorDecorationType,
  enableBracketColors,
  useRainbowIndentGuides,
  highlightActiveIndent,
  rainbowTimer = undefined,
  matchTimer = undefined,
  dirty = false;

const pendingEditors = new Set<vscode.TextEditor>();
let highlightedEditors = new WeakSet<vscode.TextEditor>();
let placedGuidesColors = new WeakMap<vscode.TextEditor, Map<string, number>>();

reloadConfig();

function decorationType(opts) {
  opts.rangeBehavior = vscode.DecorationRangeBehavior.ClosedClosed;
  return vscode.window.createTextEditorDecorationType(opts);
}

function colorDecorationType(color) {
  if (nodeUtil.isArray(color)) {
    return decorationType({
      light: { color: color[0] },
      dark: { color: color[1] },
    });
  } else {
    return decorationType({ color: color });
  }
}

function guidesDecorationType_(color, isActive: boolean): vscode.TextEditorDecorationType {
  if (nodeUtil.isArray(color)) {
    return decorationType({
      light: {
        borderWidth: `0; border-right-width: ${
          isActive ? '1.5px' : '0.5px'
        }; top: -1px; bottom: -1px;`,
        borderStyle: `solid; opacity: ${isActive ? '0.5' : '0.25'};`,
        backgroundColor: color[0],
      },
      dark: {
        borderWidth: `0; border-right-width: ${
          isActive ? '1.5px' : '0.5px'
        }; top: -1px; bottom: -1px;`,
        borderStyle: `solid; opacity: ${isActive ? '0.5' : '0.25'};`,
        borderColor: color[1],
      },
    });
  } else {
    return decorationType({
      borderWidth: `0; border-right-width: ${
        isActive ? '1.5px' : '0.5px'
      }; top: -1px; bottom: -1px;`,
      borderStyle: `solid; opacity: ${isActive ? '0.5' : '0.25'};`,
      borderColor: color,
    });
  }
}

function guidesDecorationType(color): vscode.TextEditorDecorationType {
  return guidesDecorationType_(color, false);
}

function activeGuidesDecorationType(color): vscode.TextEditorDecorationType {
  return guidesDecorationType_(color, true);
}

function reset_styles() {
  if (rainbowTypes) {
    rainbowTypes.forEach((type) => type.dispose());
  }
  rainbowTypes = rainbowColors.map(colorDecorationType);

  if (rainbowGuidesTypes) {
    rainbowGuidesTypes.forEach((type) => type.dispose());
  }
  rainbowGuidesTypes = rainbowColors.map(guidesDecorationType);

  if (activeGuidesTypes) {
    activeGuidesTypes.forEach((type) => type.dispose());
  }
  activeGuidesTypes = rainbowColors.map(activeGuidesDecorationType);

  if (misplacedType) {
    misplacedType.dispose();
  }
  misplacedType = decorationType(
    misplacedBracketStyle || {
      light: { color: '#fff', backgroundColor: '#c33' },
      dark: { color: '#ccc', backgroundColor: '#933' },
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.errorForeground'),
      overviewRulerLane: 4,
    }
  );

  if (matchedType) {
    matchedType.dispose();
  }
  matchedType = decorationType(
    matchedBracketStyle || {
      light: { backgroundColor: '#d0d0d0' },
      dark: { backgroundColor: '#444' },
    }
  );

  if (commentFormType) {
    commentFormType.dispose();
  }
  commentFormType = decorationType(commentFormStyle || { fontStyle: 'italic' });

  if (ignoredFormType) {
    ignoredFormType.dispose();
  }
  ignoredFormType = decorationType(ignoredFormStyle || { textDecoration: 'none; opacity: 0.5' });

  if (ignoredTopLevelFormType) {
    ignoredTopLevelFormType.dispose();
  }
  ignoredTopLevelFormType = decorationType(
    ignoredTopLevelFormStyle || ignoredFormStyle || { textDecoration: 'none; opacity: 0.5' }
  );

  highlightedEditors = new WeakSet();
  placedGuidesColors = new WeakMap();
  dirty = false;
}

function reloadConfig() {
  const configuration = vscode.workspace.getConfiguration(
    'calva.highlight',
    activeEditor ? activeEditor.document.uri : null
  );

  if (!isEqual(rainbowColors, configuration.get<string[]>('bracketColors'))) {
    rainbowColors = configuration.get<string[]>('bracketColors');
    dirty = true;
  }

  if (cycleBracketColors !== configuration.get<boolean>('cycleBracketColors')) {
    cycleBracketColors = configuration.get<boolean>('cycleBracketColors');
    dirty = true;
  }

  if (!isEqual(misplacedBracketStyle, configuration.get('misplacedBracketStyle'))) {
    misplacedBracketStyle = configuration.get('misplacedBracketStyle');
    dirty = true;
  }

  if (!isEqual(matchedBracketStyle, configuration.get('matchedBracketStyle'))) {
    matchedBracketStyle = configuration.get('matchedBracketStyle');
    dirty = true;
  }

  if (enableBracketColors !== configuration.get<boolean>('enableBracketColors')) {
    enableBracketColors = configuration.get<boolean>('enableBracketColors');
    dirty = true;
  }

  if (highlightActiveIndent !== configuration.get<boolean>('highlightActiveIndent')) {
    highlightActiveIndent = configuration.get<boolean>('highlightActiveIndent');
    dirty = true;
  }

  if (useRainbowIndentGuides !== configuration.get<boolean>('rainbowIndentGuides')) {
    useRainbowIndentGuides = configuration.get<boolean>('rainbowIndentGuides');
    dirty = true;
  }

  if (!isEqual(commentFormStyle, configuration.get('commentFormStyle'))) {
    commentFormStyle = configuration.get('commentFormStyle');
    dirty = true;
  }

  if (!isEqual(ignoredFormStyle, configuration.get('ignoredFormStyle'))) {
    ignoredFormStyle = configuration.get('ignoredFormStyle');
    dirty = true;
  }

  if (!isEqual(ignoredTopLevelFormStyle, configuration.get('ignoredTopLevelFormStyle'))) {
    ignoredTopLevelFormStyle = configuration.get('ignoredTopLevelFormStyle');
    dirty = true;
  }

  if (dirty) {
    vscode.window.visibleTextEditors.forEach(scheduleRainbowBrackets);
  }
}

function scheduleRainbowBrackets(editor: vscode.TextEditor = activeEditor) {
  if (!is_clojure(editor)) {
    return;
  }
  pendingEditors.add(editor);
  // Coalesce viewports without letting one split cancel another split's repaint.
  if (!rainbowTimer) {
    rainbowTimer = setTimeout(() => {
      rainbowTimer = undefined;
      if (dirty) {
        reset_styles();
        vscode.window.visibleTextEditors
          .filter(is_clojure)
          .forEach((view) => pendingEditors.add(view));
      }
      const editors = [...pendingEditors];
      pendingEditors.clear();
      editors.forEach(updateRainbowBrackets);
    }, 16);
  }
}

function updateRainbowBrackets(editor: vscode.TextEditor) {
  if (
    !is_clojure(editor) ||
    editor.document.isClosed ||
    !vscode.window.visibleTextEditors.includes(editor)
  ) {
    return;
  }
  const doc = editor.document;
  const mirrorDoc = docMirror.tryToGetDocument(doc);
  const index = mirrorDoc && getStructuralIndex(mirrorDoc.model.lineInputModel);
  if (!index) {
    return;
  }
  const rainbow = rainbowTypes.map(() => []);
  const rainbowGuides = rainbowTypes.map(() => []);
  const len = rainbowTypes.length;
  const colorIndex = cycleBracketColors ? (i) => i % len : (i) => Math.min(i, len - 1);
  const { customCommentForms, aliasMap } = config.getConfig();
  const visible = editor.visibleRanges.map((range): [number, number] => [
    doc.offsetAt(new vscode.Position(range.start.line, 0)),
    doc.offsetAt(doc.lineAt(Math.min(range.end.line, doc.lineCount - 1)).range.end),
  ]);
  const data = visibleHighlights(index, visible, (head) =>
    pareditConfig.isCommentFormHead(head, { customCommentForms, aliasMap })
  );
  const decoration = ([start, end]: [number, number]) => ({
    range: new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
  });
  const placedGuidesColor = new Map<string, number>();
  placedGuidesColors.set(editor, placedGuidesColor);
  if (enableBracketColors && len) {
    for (const bracket of data.brackets) {
      rainbow[colorIndex(bracket.depth)].push(decoration(bracket.range));
    }
  }
  if ((useRainbowIndentGuides || highlightActiveIndent) && len) {
    for (const opening of data.guidePairs) {
      const start = doc.positionAt(opening.end - 1);
      const end = doc.positionAt(opening.pair.end);
      const color = colorIndex(opening.depth);
      if (decorateGuide(editor, start, end, rainbowGuides[color])) {
        placedGuidesColor.set(position_str(start), color);
      }
    }
  }
  for (let i = 0; i < rainbowTypes.length; i++) {
    editor.setDecorations(rainbowTypes[i], rainbow[i]);
    editor.setDecorations(rainbowGuidesTypes[i], useRainbowIndentGuides ? rainbowGuides[i] : []);
  }
  editor.setDecorations(misplacedType, data.misplaced.map(decoration));
  editor.setDecorations(commentFormType, data.comments.map(decoration));
  editor.setDecorations(ignoredFormType, data.ignored.map(decoration));
  editor.setDecorations(ignoredTopLevelFormType, data.topLevelIgnored.map(decoration));
  highlightedEditors.add(editor);
  if (editor === activeEditor) {
    matchPairs();
    if (highlightActiveIndent && len) {
      decorateActiveGuides();
    }
  } else {
    clearInteractiveDecorations(editor);
  }
}

function indexedPair(offset: number, after: boolean): [vscode.Range, vscode.Range] | undefined {
  const doc = activeEditor.document;
  const mirror = docMirror.tryToGetDocument(doc);
  const index = mirror && getStructuralIndex(mirror.model.lineInputModel);
  const bracket = after ? index?.openingAt(offset) : index?.byOffset.get(offset);
  if (!bracket || bracket.string || !bracket.pair || bracket.open !== after) {
    return;
  }
  const opening = bracket.open ? bracket : bracket.pair;
  const closing = bracket.open ? bracket.pair : bracket;
  return [
    new vscode.Range(doc.positionAt(opening.end - 1), doc.positionAt(opening.end)),
    new vscode.Range(doc.positionAt(closing.offset), doc.positionAt(closing.end)),
  ];
}

function matchBefore(selection) {
  const cursor = selection.active;
  if (cursor.isBeforeOrEqual(selection.anchor)) {
    if (cursor.character > 0) {
      return indexedPair(activeEditor.document.offsetAt(cursor.translate(0, -1)), false);
    }
  }
}

function matchAfter(selection) {
  const cursor = selection.active;
  if (cursor.isAfterOrEqual(selection.anchor)) {
    if (cursor.translate(0, 1).line === cursor.line) {
      return indexedPair(activeEditor.document.offsetAt(cursor), true);
    }
  }
}

function matchPairs() {
  if (
    !is_clojure(activeEditor) ||
    !matchedType ||
    !vscode.window.visibleTextEditors.includes(activeEditor)
  ) {
    return;
  }

  const matches: { range: vscode.Range }[] = [];
  activeEditor.selections.forEach((selection) => {
    const match_before = matchBefore(selection),
      match_after = matchAfter(selection);
    if (match_before) {
      matches.push({ range: match_before[0] });
      matches.push({ range: match_before[1] });
    }
    if (match_after) {
      matches.push({ range: match_after[0] });
      matches.push({ range: match_after[1] });
    }
  });
  activeEditor.setDecorations(matchedType, matches);
}

function decorateGuide(
  editor: vscode.TextEditor,
  startPos: vscode.Position,
  endPos: vscode.Position,
  guides: any[]
): number {
  const doc = editor.document;
  let guideLength = 0;
  const seen = new Set<number>();
  for (const visible of editor.visibleRanges) {
    const first = Math.max(startPos.line + 1, visible.start.line);
    const last = Math.min(endPos.line, visible.end.line);
    for (let line = first; line <= last; line++) {
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      const guidePos = new vscode.Position(line, startPos.character);
      if (doc.lineAt(line).text.match(/^ */)[0].length >= startPos.character) {
        guides.push({ range: new vscode.Range(guidePos, guidePos) });
        guideLength++;
      }
    }
  }
  return guideLength;
}

function decorateActiveGuides() {
  if (
    !is_clojure(activeEditor) ||
    !activeGuidesTypes ||
    !vscode.window.visibleTextEditors.includes(activeEditor)
  ) {
    return;
  }
  const placedGuidesColor = placedGuidesColors.get(activeEditor);
  if (!placedGuidesColor) {
    return;
  }
  const doc = activeEditor.document;
  const mirror = docMirror.tryToGetDocument(doc);
  const index = mirror && getStructuralIndex(mirror.model.lineInputModel);
  if (!index) {
    return;
  }
  const active = activeGuidesTypes.map(() => []);
  const seen = new Set<number>();
  for (const selection of activeEditor.selections) {
    const offset = mirror.getTokenCursor(doc.offsetAt(selection.start)).offsetStart;
    let opening = index.enclosing(offset);
    while (opening) {
      if (!opening.string && opening.pair) {
        const start = doc.positionAt(opening.end - 1);
        const end = doc.positionAt(opening.pair.end);
        const color = placedGuidesColor.get(position_str(start));
        if (new vscode.Range(start, end).contains(selection) && hasIndentGuide(index, opening)) {
          if (color !== undefined && !seen.has(opening.offset)) {
            seen.add(opening.offset);
            decorateGuide(activeEditor, start, end, active[color]);
          }
          break;
        }
      }
      opening = opening.parent;
    }
  }
  activeGuidesTypes.forEach((type, i) => activeEditor.setDecorations(type, active[i]));
}

function clearInteractiveDecorations(editor: vscode.TextEditor) {
  if (!editor || editor.document.isClosed || !vscode.window.visibleTextEditors.includes(editor)) {
    return;
  }
  if (matchedType) {
    editor.setDecorations(matchedType, []);
  }
  activeGuidesTypes?.forEach((type) => editor.setDecorations(type, []));
}

export function activate(context: vscode.ExtensionContext) {
  activeEditor = utilities.tryToGetActiveTextEditor();
  vscode.window.visibleTextEditors.forEach(scheduleRainbowBrackets);

  vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      clearInteractiveDecorations(activeEditor);
      activeEditor = editor;
      scheduleRainbowBrackets(editor);
    },
    null,
    context.subscriptions
  );

  vscode.window.onDidChangeTextEditorSelection(
    (event) => {
      if (event.textEditor === activeEditor && is_clojure(activeEditor)) {
        if (!highlightedEditors.has(event.textEditor)) {
          scheduleRainbowBrackets(event.textEditor);
        } else {
          if (matchTimer) {
            clearTimeout(matchTimer);
          }
          const editor = event.textEditor;
          matchTimer = setTimeout(() => {
            matchTimer = undefined;
            if (editor !== activeEditor) {
              return;
            }
            matchPairs();
            if (highlightActiveIndent && rainbowTypes.length) {
              decorateActiveGuides();
            }
          }, 16);
        }
      }
    },
    null,
    context.subscriptions
  );

  vscode.workspace.onDidChangeTextDocument(
    (event) => {
      vscode.window.visibleTextEditors
        .filter((editor) => editor.document === event.document)
        .forEach(scheduleRainbowBrackets);
    },
    null,
    context.subscriptions
  );

  vscode.window.onDidChangeTextEditorVisibleRanges(
    (event) => scheduleRainbowBrackets(event.textEditor),
    null,
    context.subscriptions
  );

  vscode.window.onDidChangeVisibleTextEditors(
    (editors) => editors.forEach(scheduleRainbowBrackets),
    null,
    context.subscriptions
  );

  vscode.workspace.onDidChangeConfiguration(
    () => {
      reloadConfig();
      vscode.window.visibleTextEditors.forEach(scheduleRainbowBrackets);
    },
    null,
    context.subscriptions
  );

  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(rainbowTimer);
      clearTimeout(matchTimer);
      rainbowTimer = matchTimer = undefined;
      pendingEditors.clear();
    })
  );
}

export function highlight(editor: vscode.TextEditor) {
  if (activeEditor !== editor) {
    clearInteractiveDecorations(activeEditor);
  }
  activeEditor = editor;
  scheduleRainbowBrackets(editor);
}
