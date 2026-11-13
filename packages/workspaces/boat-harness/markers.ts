/**
 * Expected-failure markers: a scenario that meets a known defect passes only while it fails with
 * that defect's named failure. Kept free of sealant imports so a marker can be checked on its own.
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
  /**
   * The defect leaves its launch for the owner's discard to release (e.g. sealant keeps it as
   * `retained`). Without this, a launch that releases only after a discard is a leak even when the
   * marker excused the scenario's own failure.
   */
  readonly releasedByDiscard?: boolean;
}

/** How a scenario's body ended, as the release checks after it need to know. */
export interface BodyOutcome {
  /** The body threw, whether or not a marker then excused it. */
  readonly bodyFailed: boolean;
  /** The marker that excused the body's failure, if one did. */
  readonly excusedBy: Defect | undefined;
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

/**
 * A scenario: its body (as an expected failure when `defect` is set), then `releaseChecks`, which
 * always run and whose failures no marker excuses. A marker excuses its named step, never a leak.
 */
export const runScenario = async (
  defect: Defect | undefined,
  body: () => Promise<void>,
  releaseChecks: (outcome: BodyOutcome) => Promise<readonly string[]>,
): Promise<void> => {
  let failure: unknown;
  let threw = false;
  const tracked = async () => {
    try {
      await body();
    } catch (error) {
      threw = true;
      throw error;
    }
  };
  try {
    await (defect === undefined ? tracked() : expectDefect(defect, tracked));
  } catch (error) {
    failure = error;
  }
  const leaks = await releaseChecks({
    bodyFailed: threw,
    excusedBy: threw && failure === undefined ? defect : undefined,
  });
  if (failure !== undefined) {
    if (leaks.length > 0 && failure instanceof Error)
      failure.message = `${failure.message}\nand left behind: ${leaks.join("\n")}`;
    throw failure;
  }
  if (leaks.length > 0) throw new Error(`left behind: ${leaks.join("\n")}`);
};
