/**
 * `users.bindPerson()` (Mend ADR 0016): a user's person, bound once by the service that provisions
 * them, posted as given. Driven against a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a user's person", () => {
  it("binds the owner's person through users.bindPerson()", async () => {
    const seen: Array<{ readonly url: string; readonly method: string; readonly body: unknown }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body: unknown = await request.json();
        seen.push({ url: new URL(request.url).pathname, method: request.method, body });
        return new Response(JSON.stringify({ userId: "usr_alice", person: body, created: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const person = { id: "acct_alice", uid: 40001, home: "/home/m4lice000" };
    expect(await sealant.users.bindPerson("usr_alice", person)).toEqual({
      userId: "usr_alice",
      person,
      created: true,
    });
    expect(seen).toEqual([{ url: "/v1/users/usr_alice/person", method: "POST", body: person }]);
    await sealant.close();
  });
});
