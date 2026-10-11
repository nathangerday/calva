import type * as formatterConfig from '../formatter-config';
import * as indent from './indent';
import type * as model from './model';
import type * as tokenCursor from './token-cursor';

export function backspaceOnWhitespace(
  doc: model.EditableDocument,
  cursor: tokenCursor.LispTokenCursor,
  config?: formatterConfig.FormatterConfig
) {
  const origIndent = indent.getIndent(doc.model, cursor.offsetStart, config);
  const onCloseToken = cursor.getToken().type === 'close';
  let start = doc.selections[0].anchor;
  let token = cursor.getToken();
  if (token.type === 'ws') {
    start = cursor.offsetEnd;
  }
  const suffix = doc.model
    .getLineText(cursor.line)
    .slice(start - doc.model.getOffsetForLine(cursor.line));
  // Normalize to the whitespace being removed, whether the caret is inside
  // that token or just after it. Do not skip its preceding newline twice.
  if (token.type !== 'ws') {
    cursor.previous();
    const prevToken = cursor.getToken();
    if (prevToken.type === 'ws' && start === cursor.offsetEnd) {
      token = prevToken;
    }
  }

  let end = start;
  if (token.type === 'ws') {
    end = cursor.offsetStart;
    cursor.previous();
    if (cursor.getToken().type === 'eol') {
      end = cursor.offsetStart;
      cursor.previous();
      // Removing a blank line does not join two tokens. Keep the preceding
      // line (and its trailing whitespace) without inventing a separator.
      if (/^[ \t]*$/.test(suffix) && /\S/.test(doc.model.getLineText(cursor.line))) {
        return { start, end, indent: 0 };
      }
      if (cursor.getToken().type === 'ws') {
        // Commas already separate forms. Preserve the preceding line exactly,
        // including any existing spaces/tabs, without adding a separator.
        if (cursor.getToken().raw.includes(',')) {
          return { start, end, indent: 0 };
        }
        end = cursor.offsetStart;
        cursor.previous();
      }
    }
  }

  const destTokenType = cursor.getToken().type;
  let targetIndent = destTokenType === 'eol' ? origIndent : 1;
  if (destTokenType === 'open' || onCloseToken) {
    targetIndent = 0;
  }
  return { start, end, indent: targetIndent };
}
