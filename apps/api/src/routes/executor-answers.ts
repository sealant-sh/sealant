export interface ExecutorYesAnswers {
  readonly holds: (runId: string, subject?: string) => boolean;
  readonly rememberYes: (runId: string, subject?: string) => void;
  readonly forget: (runId: string, subject?: string) => void;
  readonly forgetAll: () => void;
}

const keyOf = (runId: string, subject = "") => `${runId}\u0000${subject}`;

export const makeExecutorYesAnswers = (options: {
  readonly ttlMs: number;
  readonly max: number;
}): ExecutorYesAnswers => {
  const expiresAt = new Map<string, number>();
  return {
    holds: (runId, subject) => (expiresAt.get(keyOf(runId, subject)) ?? 0) > Date.now(),
    rememberYes: (runId, subject) => {
      const key = keyOf(runId, subject);
      expiresAt.delete(key);
      if (expiresAt.size >= options.max) {
        const oldest = expiresAt.keys().next();
        if (oldest.done !== true) expiresAt.delete(oldest.value);
      }
      expiresAt.set(key, Date.now() + options.ttlMs);
    },
    forget: (runId, subject) => {
      expiresAt.delete(keyOf(runId, subject));
    },
    forgetAll: () => expiresAt.clear(),
  };
};
