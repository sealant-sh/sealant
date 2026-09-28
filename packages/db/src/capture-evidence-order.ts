/**
 * How Core orders the capture evidence it receives from one executor (review 6 #6, decision 17):
 * by the executor's own history, never by the clocks of the processes that read it. sealantd
 * stamps every status and FINAL answer (and every final seal) with its position — the lease
 * epoch, the launch it runs as, the daemon boot that answered, how many boots opened its disk, and
 * an observation number that only grows within the boot — and an answer with a later position is
 * the newer one, whichever Core worker read it and whatever that worker's clock said.
 *
 * Where no position can order two answers (either lacks one: a daemon that predates the stamp;
 * different epochs or launches, which are different executors'; boots of one launch no generation
 * orders), only causality does: an answer whose request was sent after the stored one was recorded
 * is newer (both instants are read from the ONE database clock). Evidence neither can order is
 * contradictory, and fails closed: whatever is kept is not complete unless both are.
 */

/**
 * Where in its own history an executor made an answer or a seal (sealantd `CaptureStatusReport`
 * 27–30 and the `final_seal`'s stamp; decision 17).
 */
export interface ExecutorOrigin {
  /** The capture lease epoch the executor held. */
  readonly epoch: number;
  /** The launch the executor runs as (`plan.get`'s `executor`, the create's `launchId`). */
  readonly launch: string;
  /** The daemon process that answered (random per process). */
  readonly bootId: string;
  /**
   * How many daemon processes opened this disk's staging, this one included: a recovery boot of
   * the same disk has a higher one. 0 when the daemon could not persist it (then boots of this
   * launch cannot be ordered).
   */
  readonly bootGeneration: number;
  /** The answer's number within its boot; it only grows. */
  readonly observation: number;
  /** The newest capture the executor had registered then. */
  readonly headN?: number | undefined;
}

/** `a` relative to `b`. */
export type ExecutorOriginOrder = "before" | "same" | "after" | "incomparable";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An origin as a status stores it (`origin`); `undefined` when absent or incomplete. */
export const executorOriginFromStored = (stored: unknown): ExecutorOrigin | undefined => {
  if (!isRecord(stored)) {
    return undefined;
  }
  const { epoch, launch, bootId, bootGeneration, observation, headN } = stored;
  if (
    typeof epoch !== "number" ||
    typeof launch !== "string" ||
    launch.length === 0 ||
    typeof bootId !== "string" ||
    bootId.length === 0 ||
    typeof bootGeneration !== "number" ||
    typeof observation !== "number"
  ) {
    return undefined;
  }
  return {
    epoch,
    launch,
    bootId,
    bootGeneration,
    observation,
    ...(typeof headN === "number" ? { headN } : {}),
  };
};

const orderNumbers = (a: number, b: number): ExecutorOriginOrder =>
  a < b ? "before" : a > b ? "after" : "same";

/**
 * Order two positions, sealantd's rule: of the same (epoch, launch, boot), by `observation`; of
 * the same (epoch, launch) and different boots whose generations are both above 0 and differ, by
 * (`bootGeneration`, `observation`). Anything else — another epoch or launch (another executor's
 * answer), a generation of 0, two boots under one generation, a position absent — is
 * incomparable. The same observation naming two different heads is contradictory: incomparable.
 */
export const compareExecutorOrigins = (
  a: ExecutorOrigin | undefined,
  b: ExecutorOrigin | undefined,
): ExecutorOriginOrder => {
  if (a === undefined || b === undefined || a.epoch !== b.epoch || a.launch !== b.launch) {
    return "incomparable";
  }
  if (a.bootId === b.bootId) {
    const byObservation = orderNumbers(a.observation, b.observation);
    return byObservation === "same" &&
      a.headN !== undefined &&
      b.headN !== undefined &&
      a.headN !== b.headN
      ? "incomparable"
      : byObservation;
  }
  if (a.bootGeneration > 0 && b.bootGeneration > 0 && a.bootGeneration !== b.bootGeneration) {
    return orderNumbers(a.bootGeneration, b.bootGeneration);
  }
  return "incomparable";
};

/** Whether a stored status reads as saved: `complete: true` and no reason it is not. */
export const storedStatusComplete = (stored: unknown): boolean =>
  isRecord(stored) && stored["complete"] === true && stored["incompleteReason"] === undefined;

/** A stored status's origin (`origin`), when it carries one. */
export const storedStatusOrigin = (stored: unknown): ExecutorOrigin | undefined =>
  isRecord(stored) ? executorOriginFromStored(stored["origin"]) : undefined;

/**
 * Whether a status just received replaces the one on record for the same executor:
 *
 *  1. nothing on record: it does;
 *  2. both carry positions that order them: the later (or the same answer again) stands;
 *  3. otherwise, when its request was sent after the recorded one was recorded (`causallyAfter`,
 *     the one database clock): it does;
 *  4. otherwise nothing orders them: fail closed — an answer that is not complete replaces
 *     anything (an incomplete answer always outranks an unordered complete), a complete answer
 *     replaces only a complete one. What is on record then never reads saved on less than two
 *     agreeing answers.
 *
 * A position that says "older" while causality says "newer" is contradictory and falls to rule 4.
 */
export const statusSupersedes = (input: {
  /** The status on record; `undefined` or `null` when none is. */
  readonly stored: unknown;
  readonly incoming: unknown;
  /** The incoming status's request was sent after the stored one was recorded. */
  readonly causallyAfter: boolean;
}): boolean => {
  if (input.stored === undefined || input.stored === null) {
    return true;
  }
  const order = compareExecutorOrigins(
    storedStatusOrigin(input.incoming),
    storedStatusOrigin(input.stored),
  );
  if (order === "after" || order === "same") {
    return true;
  }
  if (order === "before" && !input.causallyAfter) {
    return false;
  }
  if (order === "incomparable" && input.causallyAfter) {
    return true;
  }
  return !storedStatusComplete(input.incoming) || storedStatusComplete(input.stored);
};
