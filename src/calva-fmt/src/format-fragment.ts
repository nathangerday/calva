import * as healer from './healer';
import { formatIndexes } from './format-index';

/** Keep the enclosing data collection's indentation when formatting several
 * children as standalone forms. Cursor offsets remain relative to the fragment.
 */
export function formatLocalFragment(
  text: string,
  startColumn: number,
  indexes: number[],
  eol: string,
  onType: boolean,
  config: Record<string, any>
): string {
  const healing = healer.bandage(text, startColumn, eol);
  const prefixLength = healing.details.missingTexts.prepend.length;
  const formatted = formatIndexes(
    healing.healedText,
    [0, healing.healedText.length],
    indexes.map((index) => index + prefixLength),
    eol,
    onType,
    { ...config, 'comment-form?': false }
  );
  return healer.unbandage(healing, formatted['range-text']);
}
