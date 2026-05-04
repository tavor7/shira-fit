/**
 * Unicode directional isolates (TR9) for mixed LTR UI + Hebrew/Arabic names.
 * @see https://www.unicode.org/reports/tr9/
 */
const RE_RTL_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\ufb1d-\ufdff\ufe70-\ufefc]/;

export function isRtlScript(text: string): boolean {
  return RE_RTL_SCRIPT.test(text);
}

/** RLI + PDI — isolate RTL script so it does not reorder adjacent Latin or digits. */
export function embedRtlInLtr(segment: string): string {
  if (!segment || !RE_RTL_SCRIPT.test(segment)) return segment;
  return `\u2067${segment}\u2069`;
}

/** LRI + PDI — keep date/time in left-to-right order next to RTL runs. */
export function embedLtrInMixed(segment: string): string {
  if (!segment) return segment;
  return `\u2066${segment}\u2069`;
}
