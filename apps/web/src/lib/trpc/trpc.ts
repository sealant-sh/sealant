import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";

import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

type ProtectedSession = NonNullable<TrpcContext["session"]> & {
  readonly user: NonNullable<TrpcContext["session"]>["user"] & {
    readonly id: string;
  };
  readonly session: NonNullable<TrpcContext["session"]>["session"] & {
    readonly id: string;
  };
};

const requireProtectedSession = (session: TrpcContext["session"]): ProtectedSession => {
  if (session === null) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  }

  const userId = session.user.id;
  const sessionId = session.session.id;

  if (typeof userId !== "string" || userId.length === 0) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authenticated user id is required.",
    });
  }

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authenticated session id is required.",
    });
  }

  return {
    ...session,
    user: {
      ...session.user,
      id: userId,
    },
    session: {
      ...session.session,
      id: sessionId,
    },
  };
};

export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const session = requireProtectedSession(ctx.session);

  return next({
    ctx: {
      ...ctx,
      session,
      // Every control-plane call a signed-in procedure makes is made for that user. The control
      // plane answers 404 for a resource that is not theirs, so an id from another account reads
      // like one that does not exist.
      coreApi: ctx.coreApi.forOwner(session.user.id),
    },
  });
});
