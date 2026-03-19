import type { SealantAuth } from "./server.js";

export type MaybeAuthSession = Awaited<ReturnType<SealantAuth["api"]["getSession"]>>;
export type AuthSession = NonNullable<MaybeAuthSession>;
export type AuthSessionUser = AuthSession["user"];

const resolveHeaders = (input: Headers | Request): Headers => {
  return input instanceof Request ? input.headers : input;
};

export const getAuthSession = async (auth: SealantAuth, input: Headers | Request) => {
  return auth.api.getSession({
    headers: resolveHeaders(input),
  });
};

export const requireAuthSession = async (auth: SealantAuth, input: Headers | Request) => {
  const session = await getAuthSession(auth, input);

  if (session === null) {
    throw new Error("Authentication required.");
  }

  return session;
};
