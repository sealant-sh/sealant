/**
 * Pure inference-session mechanics — NO agent-SDK imports, fully unit-testable.
 *
 * One session = one live agent exchange whose MCP tool handlers PARK here across HTTP requests:
 * when the model calls a caller-defined tool, the handler registers the call and awaits a promise;
 * the pending calls are batched into a `toolCalls` turn for the HTTP response; the caller executes
 * them client-side and posts results back, which resolve the parked promises so the exchange
 * continues. A short QUIET window after the last parked call batches parallel tool calls into one
 * turn instead of round-tripping them one at a time.
 */

export interface ParkedToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
}

/** What the parked MCP handler receives once the caller posts the tool's result. */
export interface ToolResultInput {
  readonly content: string;
  readonly isError: boolean;
}

export interface SessionDone {
  readonly text: string;
  readonly json?: unknown;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export type SessionTurn =
  | { readonly type: "toolCalls"; readonly calls: readonly ParkedToolCall[] }
  | ({ readonly type: "done" } & SessionDone);

export class SessionExpiredError extends Error {
  override readonly name = "SessionExpiredError";
}

export class SessionTurnTimeoutError extends Error {
  override readonly name = "SessionTurnTimeoutError";
}

interface PendingCall {
  readonly call: ParkedToolCall;
  readonly resolve: (result: ToolResultInput) => void;
  readonly reject: (error: Error) => void;
}

interface TurnWaiter {
  readonly resolve: (turn: SessionTurn) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

let callCounter = 0;

/**
 * In-memory state for one exchange. The engine drives `park`/`finish`/`fail` from the agent-SDK
 * side; the HTTP module drives `nextTurn`/`resolveToolResult` from the request side.
 */
export class InferenceSessionState {
  readonly id: string;
  lastActivityAt: number;

  /** Calls parked but not yet handed out as a turn. */
  #collected: ParkedToolCall[] = [];
  /** Calls handed out (or about to be), awaiting the caller's results, keyed by toolCallId. */
  #pending = new Map<string, PendingCall>();
  #done: SessionDone | undefined;
  #failure: Error | undefined;
  #waiter: TurnWaiter | undefined;
  #quietTimer: NodeJS.Timeout | undefined;
  readonly #quietMs: number;

  constructor(id: string, options?: { readonly quietMs?: number }) {
    this.id = id;
    this.#quietMs = options?.quietMs ?? 250;
    this.lastActivityAt = Date.now();
  }

  /** Registers a model tool call; the returned promise settles when the caller posts its result. */
  park(name: string, input: unknown): Promise<ToolResultInput> {
    this.lastActivityAt = Date.now();
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    callCounter += 1;
    const call: ParkedToolCall = { toolCallId: `tc_${callCounter}_${this.id}`, name, input };
    this.#collected.push(call);
    const promise = new Promise<ToolResultInput>((resolve, reject) => {
      this.#pending.set(call.toolCallId, { call, resolve, reject });
    });
    this.#scheduleQuietFlush();
    return promise;
  }

  /** The caller posted a result for a parked call. Returns false for an unknown/settled id. */
  resolveToolResult(toolCallId: string, result: ToolResultInput): boolean {
    this.lastActivityAt = Date.now();
    const pending = this.#pending.get(toolCallId);
    if (pending === undefined) {
      return false;
    }
    this.#pending.delete(toolCallId);
    pending.resolve(result);
    return true;
  }

  /** The exchange produced its final answer. */
  finish(done: SessionDone): void {
    this.lastActivityAt = Date.now();
    this.#done = done;
    this.#settleWaiter();
  }

  /** The exchange died (engine/subprocess error). Pending handlers and waiters are rejected. */
  fail(error: Error): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#settleWaiter();
  }

  /** Expire the session (idle sweep / shutdown): everything still parked or waiting is rejected. */
  expire(reason: string): void {
    this.fail(new SessionExpiredError(reason));
  }

  get isSettled(): boolean {
    return this.#done !== undefined || this.#failure !== undefined;
  }

  get pendingCallIds(): readonly string[] {
    return [...this.#pending.keys()];
  }

  /**
   * Resolves with the next assistant turn: the final `done` answer, or the batch of tool calls
   * parked since the last turn (after the quiet window, so parallel calls travel together).
   * One waiter at a time — the HTTP protocol serializes calls per session.
   */
  nextTurn(timeoutMs: number): Promise<SessionTurn> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#done !== undefined) {
      return Promise.resolve({ type: "done", ...this.#done });
    }
    if (this.#waiter !== undefined) {
      return Promise.reject(
        new Error(`Session ${this.id} already has a request waiting on its next turn.`),
      );
    }
    return new Promise<SessionTurn>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiter = undefined;
        reject(new SessionTurnTimeoutError(`Timed out waiting for session ${this.id}'s turn.`));
      }, timeoutMs);
      timeout.unref?.();
      this.#waiter = { resolve, reject, timeout };
      // Calls may have finished parking before this request arrived — flush after the quiet window.
      if (this.#collected.length > 0) {
        this.#scheduleQuietFlush();
      }
    });
  }

  #scheduleQuietFlush(): void {
    if (this.#quietTimer !== undefined) {
      clearTimeout(this.#quietTimer);
    }
    const timer = setTimeout(() => {
      this.#quietTimer = undefined;
      this.#settleWaiter();
    }, this.#quietMs);
    timer.unref?.();
    this.#quietTimer = timer;
  }

  #settleWaiter(): void {
    const waiter = this.#waiter;
    if (waiter === undefined) {
      return;
    }
    if (this.#failure !== undefined) {
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.reject(this.#failure);
      return;
    }
    if (this.#done !== undefined) {
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.resolve({ type: "done", ...this.#done });
      return;
    }
    if (this.#collected.length > 0) {
      const calls = this.#collected;
      this.#collected = [];
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.resolve({ type: "toolCalls", calls });
    }
  }
}
