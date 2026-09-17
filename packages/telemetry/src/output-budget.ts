/**
 * The per-run output budget (CORE-04). A run's recorded output is otherwise bounded only by how
 * long its process keeps writing. Once one ingest connection has stored `maxBytes` of io content,
 * later chunks keep their event rows (sequence, offsets, byte counts, payload hashes) and lose
 * their bytes, their scrollback rows become holes a reader skips, and the record says so with one loss span at the first chunk that was not stored. The
 * process is never stopped and nothing already stored is removed.
 *
 * The count is per ingest connection: it starts again when the worker reconnects to a runtime, so
 * a run that reconnects N times can store up to N budgets. A durable count would be read from the
 * artifact store and is later work.
 */
import type { LossSpanInput, NormalizedEvent } from "./types.js";

export interface OutputBudgetState {
  storedBytes: number;
  /** True once the loss span for this connection has been emitted. */
  reported: boolean;
}

export const makeOutputBudgetState = (): OutputBudgetState => ({
  storedBytes: 0,
  reported: false,
});

export interface OutputBudgetResult {
  readonly batch: ReadonlyArray<NormalizedEvent>;
  /** Present on the batch in which the budget was first exceeded. */
  readonly lossSpan: LossSpanInput | undefined;
}

/** Apply the budget to one batch, in order. `maxBytes <= 0` is off. Mutates `state`. */
export const applyOutputBudget = (
  state: OutputBudgetState,
  batch: ReadonlyArray<NormalizedEvent>,
  maxBytes: number,
): OutputBudgetResult => {
  if (maxBytes <= 0) return { batch, lossSpan: undefined };
  let lossSpan: LossSpanInput | undefined;
  const kept = batch.map((event) => {
    if (event.content === undefined) return event;
    const size = event.content.bytes.byteLength;
    if (state.storedBytes + size <= maxBytes) {
      state.storedBytes += size;
      return event;
    }
    if (!state.reported) {
      state.reported = true;
      lossSpan = {
        kind: "dropped_event",
        fromSequence: event.sequence,
        reason: `run output budget reached (${maxBytes} bytes): later output content was not stored`,
        detectedVia: "marker",
        atSequence: event.sequence,
      };
    }
    // The scrollback row must stop naming the content too: the readers treat a row with a hash as
    // stored and fail the whole read when the artifact is missing, and treat one without as a
    // hole. The payload keeps its hash, so the record still says what was written.
    return {
      ...event,
      content: undefined,
      scrollback:
        event.scrollback === undefined
          ? undefined
          : { ...event.scrollback, contentAlgo: undefined, contentHash: undefined },
    };
  });
  return { batch: kept, lossSpan };
};
