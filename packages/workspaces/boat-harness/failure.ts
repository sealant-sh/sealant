/**
 * A caught failure in words, as `String` writes an Error or a string; anything else as its JSON,
 * not `[object Object]`.
 */
export const describeFailure = (failure: unknown): string => {
  if (failure instanceof Error || typeof failure === "string") return failure.toString();
  return JSON.stringify(failure) ?? "an unprintable failure";
};
