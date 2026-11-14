/**
 * The words a check may return while a request is decoded, declared when the contract is built, so
 * that a refusal (`request-refusal.ts`) can repeat them. A refusal repeats a check's returned text
 * only when it is one of these strings exactly or matches one of these patterns whole; any other
 * text the check returns reads "is invalid". Declare only words built from constants, positions and
 * sizes, never from the value checked.
 */

/** The filter annotation that holds a check's declared words. */
export const REFUSAL_WORDS = "@sealant/api-contracts/refusalWords";

/** One declared word: a constant, or a pattern the whole text must match. */
export type RefusalWord = string | RegExp;

/** Filter annotations declaring `words`, for `Schema.makeFilter(check, refusalWords(...))`. */
export const refusalWords = (
  ...words: ReadonlyArray<RefusalWord>
): { readonly [REFUSAL_WORDS]: ReadonlyArray<RefusalWord> } => ({ [REFUSAL_WORDS]: words });
