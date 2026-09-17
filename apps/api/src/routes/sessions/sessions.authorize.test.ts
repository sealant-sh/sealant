import { SessionUnauthorizedError } from "@sealant/api-contracts";
import { AccessTokenRepo } from "@sealant/db";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { authorize } from "./sessions.module.js";

/**
 * The transport gate admits the session surface on ANY bearer, including a `?token=` the handler
 * never reads. `authorize` must therefore never treat a missing Authorization header as a trusted
 * caller: outside the development exception that would let `?token=x&ownerUserId=<victim>` act as
 * any owner. This process has no service keys and no exception, so it is not open.
 */
describe("session authorize without a credential", () => {
  it("refuses instead of trusting the asserted owner", async () => {
    let lookups = 0;
    const touched = Effect.sync(() => {
      lookups += 1;
    }).pipe(Effect.andThen(Effect.die("the refusal must come before any token lookup")));
    const outcome = await Effect.runPromise(
      authorize({
        headers: {},
        requiredScope: "session:read",
        assertedOwnerUserId: "usr_victim",
      }).pipe(
        Effect.flip,
        Effect.provideService(AccessTokenRepo, {
          createToken: () => touched,
          getTokenByHash: () => touched,
          listTokens: () => touched,
          revokeToken: () => touched,
        }),
      ),
    );
    expect(lookups).toBe(0);
    expect(outcome).toBeInstanceOf(SessionUnauthorizedError);
  });
});
