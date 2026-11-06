import { LineInputModel, ModelEdit } from '../../cursor-doc/model';
import { getIndent } from '../../cursor-doc/indent';
import type { FormatterConfig } from '../../formatter-config';
import { validPair } from '../../cursor-doc/clojure-lexer';

export interface NewlineInsertion {
  start: number;
  end: number;
  text: string;
  closingText?: string;
}

/** Plan in document order, letting each split update the context for the next
 * one. Return edits in original coordinates, for a single VS Code transaction.
 * A fork shares existing tokens rather than tokenizing a large document again.
 */
export function newlineInsertions(
  model: LineInputModel,
  offsets: number[],
  config: FormatterConfig,
  expandEmptyPairs = true
): NewlineInsertion[] | undefined {
  if (model.dirtyLines.length) {
    return undefined;
  }
  let simulation = model;
  const ordered = [...offsets].sort((a, b) => a - b);
  const result: NewlineInsertion[] = [];
  let delta = 0;
  for (const [i, start] of ordered.entries()) {
    const previous = result[result.length - 1];
    if (previous && previous.end >= start) {
      return undefined;
    }
    const offset = start + delta;
    const insertion = newlineInsertion(simulation, offset, config, expandEmptyPairs);
    if (!insertion) {
      return undefined;
    }
    result.push({ start, ...insertion, end: insertion.end - delta });
    if (i < ordered.length - 1) {
      // Reuse the original cached index for the first cursor. Only fork once
      // its valid edit must become context for another cursor.
      if (simulation === model) {
        simulation = model.fork();
      }
      const text = insertion.text + (insertion.closingText ?? '');
      simulation.editNow([new ModelEdit('changeRange', [offset, insertion.end, text])], {});
      simulation.flushChanges();
      delta += text.length - (insertion.end - offset);
    }
  }
  return result;
}

/** Plan a newline at a code token boundary using the existing indent engine.
 * The prefix is unchanged by inserting a newline, so its indent can be computed
 * before editing. String/comment interiors and token splits retain native handling.
 * Empty collections also move their closer to a separate line, as native Enter
 * does, with closingText separating that edit from the cursor-moving insertion.
 */
export function newlineInsertion(
  model: LineInputModel,
  offset: number,
  config: FormatterConfig,
  expandEmptyPairs = true
): { end: number; text: string; closingText?: string } | undefined {
  const [row, column] = model.getRowCol(offset);
  const line = model.lines[row];
  if (
    model.dirtyLines.length ||
    line.tokens.some((token) => ['prompt', 'too-long-line', 'junk'].includes(token.type))
  ) {
    return undefined;
  }
  const cursor = model.getTokenCursor(offset);
  const token = cursor.getToken();
  const atTokenStart = cursor.offsetStart === offset;
  if (
    (atTokenStart ? cursor.getPrevToken().state?.inString : token.state.inString) ||
    (!atTokenStart && offset < cursor.offsetEnd && token.type !== 'ws')
  ) {
    return undefined;
  }
  const whitespace = line.text.slice(column).match(/^[ \t]*/)[0];
  const end = offset + whitespace.length;
  const text = model.lineEnding + ' '.repeat(getIndent(model, offset, config, offset));
  const before = cursor.clone();
  before.backwardWhitespace(false);
  const open = before.getPrevToken();
  const after = model.getTokenCursor(end);
  const close = after.getToken();
  if (
    expandEmptyPairs &&
    before.line === row &&
    open.type === 'open' &&
    close.type === 'close' &&
    after.offsetStart === end &&
    validPair(open.raw, close.raw) &&
    /^[ \t]*$/.test(line.text.slice(open.offset + open.raw.length, column))
  ) {
    // Preserve native Enter's closing-line indentation and existing whitespace
    // before the closer. The inner line uses Calva's structural indentation.
    return {
      end: after.offsetEnd,
      text,
      closingText: model.lineEnding + line.text.match(/^[ \t]*/)[0] + whitespace + close.raw,
    };
  }
  return {
    end,
    text,
  };
}
