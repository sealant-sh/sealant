/**
 * `boatAccounts.prove(id)` (SLNT-784): the full check's wire call, its result, the account's
 * `lastProof` in `list()`, and the refusal of a second check while one runs. Against a stubbed
 * `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError } from "./errors.js";
import type { BoatKeyProof } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const id = "00000000-0000-4000-8000-0000000000b2";
const proof: BoatKeyProof = {
  proofId: "00000000-0000-4000-8000-0000000000c3",
  startedAt: "2026-11-13T08:00:00.000Z",
  finishedAt: "2026-11-13T08:01:10.000Z",
  outcome: "refused",
  steps: [
    { step: "start-vm", outcome: "passed" },
    {
      step: "run-command",
      outcome: "refused",
      boat: {
        kind: "permission-missing",
        retryable: false,
        code: "api_key_action_forbidden",
        permission: "exec",
      },
    },
    { step: "publish-port", outcome: "not-reached" },
    { step: "save-snapshot", outcome: "not-reached" },
    { step: "delete-snapshot", outcome: "not-reached" },
    { step: "delete-vm", outcome: "passed" },
  ],
  starts: 1,
  leftBehind: { vm: null, snapshot: null, removalConfirmed: true },
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("a full check of a Boat key", () => {
  it("posts to /v1/boat-accounts/:id/prove, shows the result in list, and refuses a second check while one runs", async () => {
    const seen: string[] = [];
    // The client keeps the fetch it was first given: one stub, switched by `busy`.
    let busy = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        if (busy)
          return answer(409, {
            _tag: "BoatAccountConflictError",
            code: "boat-proof-running",
            message: `A full check of Boat account ${id} is already running.`,
          });
        if (request.method === "POST") return answer(200, proof);
        return answer(200, {
          items: [
            {
              boatAccountId: id,
              label: "Org",
              state: "active",
              createdAt: "2026-11-12T00:00:00.000Z",
              keyRotatedAt: null,
              lastProof: proof,
            },
          ],
        });
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    expect(await sealant.boatAccounts.prove(id)).toEqual(proof);
    const [listed] = await sealant.boatAccounts.list();
    expect(listed?.lastProof).toEqual(proof);
    expect(seen).toEqual([`POST /v1/boat-accounts/${id}/prove`, "GET /v1/boat-accounts"]);
    busy = true;
    const refused: unknown = await sealant.boatAccounts
      .prove(id)
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(SealantApiError);
    expect(refused).toMatchObject({ reason: "boat-proof-running" });
  });
});
