import * as respacer from './respacer';
import * as nsForm from '../../util/ns-form';
import * as cljsLib from '../../../out/cljs-lib/cljs-lib';
import * as formatIndex from './format-index';
import * as healer from './healer';
import { formatLocalFragment } from './format-fragment';

export interface FormatJob {
  kind: 'indexes' | 'local' | 'range';
  text: string;
  range: [number, number];
  indexes: number[];
  eol: string;
  onType: boolean;
  startColumn: number;
  fullDocument?: boolean;
  config: Record<string, any>;
  scannerMaxLength: number;
}

export interface FormatResult {
  formattedText: string;
  previousText: string;
  range: [number, number];
  changes: respacer.WhitespaceChange[];
}

/** Pure formatter and diff work. The raw EDN preserves regex/custom indent
 * options across the worker boundary; ClojureScript values are reconstructed.
 */
export function runFormatJob(job: FormatJob): FormatResult {
  const config = { ...job.config };
  if (config['cljfmt-options-string']) {
    config['cljfmt-options'] = cljsLib.cljfmtOptionsFromString(config['cljfmt-options-string']);
  }
  let range = job.range;
  const previousText = job.kind === 'indexes' ? job.text.slice(...range) : job.text;
  let formattedText: string;
  if (job.kind === 'indexes') {
    const formatted = formatIndex.formatIndexes(
      job.text,
      range,
      job.indexes,
      job.eol,
      job.onType,
      config
    );
    formattedText = formatted['range-text'];
    range = formatted.range as [number, number];
  } else if (job.kind === 'local') {
    formattedText = formatLocalFragment(
      job.text,
      job.startColumn,
      job.indexes,
      job.eol,
      job.onType,
      config
    );
  } else {
    const healing = job.fullDocument
      ? undefined
      : healer.bandage(job.text, job.startColumn, job.eol);
    const result = cljsLib.jsify(
      cljsLib.formatText({
        'range-text': healing ? healing.healedText : job.text,
        eol: job.eol,
        config: { ...config, 'full-document?': !!job.fullDocument },
      })
    );
    if (result.error) {
      throw new Error(String(result.error));
    }
    formattedText = healing
      ? healer.unbandage(healing, result['range-text'])
      : result['range-text'];
  }
  return {
    formattedText,
    previousText,
    range,
    changes: whitespaceAndNsEdits(job.eol, range[0], previousText, formattedText),
  };
}

/** Micro-edits to change previousText to formattedText.
 * The formatter usually changes only whitespace.
 * However, its :sort-ns-references? may change text too.
 * Computation of micro-edits is more efficient for whitespace-only changes.
 * Therefore, if a ns form is found,
 * we compute one set of edits for the ns form
 * (which is 1 large, degenerate edit if more than whitespace changed)
 * plus another set of edits for the rest of the document.
 * In the worst case, there are multiple ns forms
 * and the "rest-of-document" changes also degenerate
 * to a single large edit.
 * Micro-edits are preferable because they nudge all cursors
 * and they seem to avoid re-syntax-highlighting,
 * compared with replacing swaths of substantive text.
 */
export function whitespaceAndNsEdits(
  eol: string,
  startIndex: number,
  previousText: string,
  formattedText: string
): respacer.WhitespaceChange[] {
  if (previousText == formattedText) {
    return [];
  } else {
    const previousNsInfo = nsForm.nsRangeFromText(previousText);
    const formattedNsInfo = nsForm.nsRangeFromText(formattedText);
    if (previousNsInfo && formattedNsInfo) {
      const [previousNsName, previousNsRange] = previousNsInfo;
      const [formattedNsName, formattedNsRange] = formattedNsInfo;
      const nsEdits = respacer.whitespaceEdits(
        eol,
        startIndex,
        previousText.substring(0, previousNsRange[1]),
        formattedText.substring(0, formattedNsRange[1])
      );
      const otherEdits = respacer.whitespaceEdits(
        eol,
        startIndex + previousNsRange[1],
        previousText.substring(previousNsRange[1]),
        formattedText.substring(formattedNsRange[1])
      );
      return [...otherEdits, ...nsEdits];
    } else {
      return respacer.whitespaceEdits(eol, startIndex, previousText, formattedText);
    }
  }
}
