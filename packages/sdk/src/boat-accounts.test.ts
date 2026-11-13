/**
 * `boatAccounts` (one Boat API key per Mend organization) and `workspaces.create({ boatAccountId })`:
 * what goes on the wire, and that no answer carries a key. Driven against a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { opencode } from "./harness.js";
import { buildCreateWorkspaceRequest } from "./internal/blueprint.js";
import { resolveInternalConfig } from "./internal/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const account = {
  boatAccountId: "00000000-0000-4000-8000-0000000000a1",
  label: "Organization A",
  state: "active",
  createdAt: "2026-11-12T00:00:00.000Z",
  keyRotatedAt: null,
};

describe("Boat accounts", () => {
  it("creates, lists, rotates and removes accounts on /v1/boat-accounts", async () => {
    const seen: Array<{ readonly path: string; readonly method: string; readonly body: unknown }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const text = await request.text();
        const path = new URL(request.url).pathname;
        seen.push({
          path,
          method: request.method,
          body: text === "" ? undefined : JSON.parse(text),
        });
        const answer =
          request.method === "GET"
            ? { items: [account] }
            : request.method === "DELETE"
              ? { ...account, state: "removing" }
              : request.method === "PUT"
                ? { ...account, keyRotatedAt: "2026-11-12T01:00:00.000Z" }
                : account;
        return new Response(JSON.stringify(answer), {
          status: request.method === "POST" ? 201 : 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const created = await sealant.boatAccounts.create({
      label: "Organization A",
      apiKey: "fixture-boat-key-not-real",
    });
    // An older control plane sends no organization or report: none named, not checked.
    const read = {
      ...account,
      organization: null,
      report: null,
      lastProof: null,
      unreachable: null,
    };
    expect(created).toEqual(read);
    expect(await sealant.boatAccounts.list()).toEqual([read]);
    expect(
      (await sealant.boatAccounts.rotateKey(account.boatAccountId, "fixture-boat-key-next"))
        .keyRotatedAt,
    ).toBe("2026-11-12T01:00:00.000Z");
    expect((await sealant.boatAccounts.remove(account.boatAccountId)).state).toBe("removing");
    expect(seen).toEqual([
      {
        path: "/v1/boat-accounts",
        method: "POST",
        body: { label: "Organization A", apiKey: "fixture-boat-key-not-real" },
      },
      { path: "/v1/boat-accounts", method: "GET", body: undefined },
      {
        path: `/v1/boat-accounts/${account.boatAccountId}/key`,
        method: "PUT",
        body: { apiKey: "fixture-boat-key-next" },
      },
      { path: `/v1/boat-accounts/${account.boatAccountId}`, method: "DELETE", body: undefined },
    ]);
    await sealant.close();
  });

  it("names the account in the spec of a Boat workspace, and refuses it for another runtime", () => {
    const config = resolveInternalConfig({
      baseUrl: "http://test.invalid",
      ownerUserId: "usr_owner",
    });
    const options = {
      repository: "github.com/example/repo",
      harness: opencode(),
      boatAccountId: account.boatAccountId,
    };
    const { spec } = buildCreateWorkspaceRequest({ ...options, runtime: "boat" }, config).payload;
    expect(spec).toMatchObject({ runtime: { boatAccountId: account.boatAccountId } });
    // Without a runtime the control plane's default decides, and refuses it if that is not Boat.
    expect(buildCreateWorkspaceRequest(options, config).payload.spec).toMatchObject({
      runtime: { boatAccountId: account.boatAccountId },
    });
    expect(() => buildCreateWorkspaceRequest({ ...options, runtime: "docker" }, config)).toThrow(
      "boatAccountId",
    );
    // Omitted, the spec names no account: the control plane's default Boat account.
    expect(
      JSON.stringify(
        buildCreateWorkspaceRequest(
          { repository: "github.com/example/repo", harness: opencode() },
          config,
        ).payload.spec,
      ),
    ).not.toContain("boatAccountId");
  });
});
