/**
 * Expected-failure markers: a scenario that meets a known defect passes only while it fails with
 * that defect's named failure. Kept free of Core imports so a marker can be checked on its own.
 */
/** A known defect: a scenario fails with its signature until the fix lands, then must pass. */
export interface Defect {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  /**
   * The named failure: matched against the scenario's own message, the part before the guest and
   * proxy evidence the harness attaches. Name the step and the runtime row it fails with, so a
   * later or different failure does not pass for this one.
   */
  readonly failure: RegExp;
  /** When set, the attached guest and proxy evidence must match too. */
  readonly evidence?: RegExp;
  /**
   * Timing decides whether it shows. The scenario then passes either way, but any other failure
   * still fails it. Use only for a defect the harness has seen both ways.
   */
  readonly intermittent?: boolean;
  /** Any one of these (see `firstOf`). */
  readonly anyOf?: readonly Defect[];
}

/** Splits a failure into the scenario's own message and the evidence attached after it. */
export const failureParts = (message: string): { primary: string; evidence: string } => {
  const at = message.indexOf("; guest: ");
  return at === -1
    ? { primary: message, evidence: "" }
    : { primary: message.slice(0, at), evidence: message.slice(at) };
};

export const defectMatches = (defect: Defect, message: string): boolean => {
  if (defect.anyOf !== undefined) return defect.anyOf.some((each) => defectMatches(each, message));
  const { primary, evidence } = failureParts(message);
  return (
    defect.failure.test(primary) &&
    (defect.evidence === undefined || defect.evidence.test(evidence))
  );
};

/**
 * Runs `body` as an expected failure. Passing means the defect is fixed: that fails loudly so the
 * marker gets removed. Any failure other than the named one fails the scenario with that failure.
 */
export const expectDefect = async (defect: Defect, body: () => Promise<void>): Promise<void> => {
  let failure: unknown;
  try {
    await body();
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    if (defect.intermittent === true) {
      process.stderr.write(`[boat-harness] intermittent ${defect.id} did not show this time\n`);
      return;
    }
    throw new Error(
      `${defect.id} (${defect.title}) no longer reproduces: this scenario now passes. Remove its expected-failure marker in defects.ts.`,
    );
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  if (!defectMatches(defect, message)) {
    if (failure instanceof Error)
      failure.message = `not the expected ${defect.id} (${defect.title}): ${failure.message}`;
    throw failure;
  }
  process.stderr.write(`[boat-harness] expected failure ${defect.id}: ${defect.title}\n`);
};
