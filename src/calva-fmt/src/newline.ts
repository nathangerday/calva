import type { LineInputModel } from '../../cursor-doc/model';
import { getIndent } from '../../cursor-doc/indent';
import type { FormatterConfig } from '../../formatter-config';
import { validPair } from '../../cursor-doc/clojure-lexer';

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
