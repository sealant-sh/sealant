import {
  beginHomeWrite,
  planHomePut,
  pruneHome,
  removalWork,
  settleHomeWrite,
  settleInDoubt,
  type HomeState,
  type HomeWriteOutcome,
  type PlacementAccount,
  type WorkspaceCredentialPlacement,
} from "@sealant/db";
import { describe, expect, it } from "vitest";

const key = { runId: "run_1", home: "/home/m4lice000" };

const placement = (
  id: string,
  overrides: Partial<WorkspaceCredentialPlacement> = {},
): WorkspaceCredentialPlacement => ({
  id,
  ...key,
  provider: "claude",
  accountId: "cacc_a",
  revision: 1,
  path: `${key.home}/.claude/.credentials.json`,
  login: { kind: "subscription" },
  state: "ready",
  createdAt: new Date("2026-10-25T00:00:00.000Z"),
  ...overrides,
});

const account = (id: string, overrides: Partial<PlacementAccount> = {}): PlacementAccount => ({
  id,
  name: id,
  ownerUserId: "alice",
  provider: "claude",
  revision: 1,
  active: true,
  archived: false,
  ...overrides,
});

const stateOf = (
  placements: readonly WorkspaceCredentialPlacement[],
  accounts: readonly PlacementAccount[] = [account("cacc_a"), account("cacc_b")],
  defaults: readonly string[] = [],
): HomeState => ({
  held: undefined,
  placements,
  accounts: new Map(accounts.map((row) => [row.id, row])),
  defaults: new Set(defaults),
});

const stateOfRows = (rows: ReturnType<typeof stateOf>["placements"]) =>
  rows.map(({ id, provider, accountId, revision, state }) => ({
    id,
    provider,
    accountId,
    revision,
    state,
  }));

let ids = 0;
const newId = () => `cpl_new_${String((ids += 1))}`;

const begin = (state: HomeState, accountId: string, revision = 1, reuse?: string) => {
  const began = beginHomeWrite(state, {
    key,
    onBehalfOfUserId: "alice",
    writes: [
      {
        provider: "claude",
        accountId,
        revision,
        reuse,
        path: `${key.home}/.claude/.credentials.json`,
      },
    ],
    removes: [],
    newId,
  });
  if (began === undefined) throw new Error("the write did not begin");
  return began;
};

describe("planHomePut", () => {
  const ready = placement("cpl_a");

  it("writes every selection and removes every null for a caller without live placements", () => {
    const plan = planHomePut({
      placements: [ready, placement("cpl_g", { provider: "github" })],
      live: undefined,
      selected: [{ provider: "claude", accountId: "cacc_a", revision: 1 }],
      removed: ["github"],
    });
    expect(plan).toEqual({
      writes: [{ provider: "claude", accountId: "cacc_a", revision: 1, reuse: "cpl_a" }],
      removes: ["github"],
      pinned: [],
    });
  });

  it("leaves a live slot alone for another account or revision, and writes it again for its own", () => {
    for (const selection of [
      { accountId: "cacc_b", revision: 1 },
      { accountId: "cacc_a", revision: 2 },
    ]) {
      expect(
        planHomePut({
          placements: [ready],
          live: ["cpl_a"],
          selected: [{ provider: "claude", ...selection }],
          removed: [],
        }),
      ).toEqual({ writes: [], removes: [], pinned: ["cpl_a"] });
    }
    expect(
      planHomePut({
        placements: [ready],
        live: ["cpl_a"],
        selected: [{ provider: "claude", accountId: "cacc_a", revision: 1 }],
        removed: [],
      }).writes,
    ).toEqual([{ provider: "claude", accountId: "cacc_a", revision: 1, reuse: "cpl_a" }]);
  });

  it("never removes a live slot, and a live id that is not ready protects nothing", () => {
    expect(
      planHomePut({ placements: [ready], live: ["cpl_a"], selected: [], removed: ["claude"] }),
    ).toEqual({ writes: [], removes: [], pinned: ["cpl_a"] });
    expect(
      planHomePut({
        placements: [placement("cpl_a", { state: "removing" })],
        live: ["cpl_a"],
        selected: [{ provider: "claude", accountId: "cacc_b", revision: 1 }],
        removed: [],
      }),
    ).toEqual({
      writes: [{ provider: "claude", accountId: "cacc_b", revision: 1, reuse: undefined }],
      removes: [],
      pinned: [],
    });
  });
});

describe("a write's placements", () => {
  it("leave a pending write's slot for removal once the lock is held again", () => {
    expect(
      stateOfRows(
        settleInDoubt([
          placement("cpl_a"),
          placement("cpl_b", { accountId: "cacc_b", state: "pending" }),
          placement("cpl_g", { provider: "github" }),
        ]),
      ).map((row) => row.state),
    ).toEqual(["removing", "removing", "ready"]);
  });

  it("do not begin for an account that moved, was archived, or is someone else's", () => {
    for (const changed of [
      account("cacc_b", { revision: 2 }),
      account("cacc_b", { active: false, archived: true }),
      account("cacc_b", { ownerUserId: "bob" }),
      account("cacc_b", { provider: "codex" }),
    ]) {
      expect(
        beginHomeWrite(stateOf([], [changed]), {
          key,
          onBehalfOfUserId: "alice",
          writes: [
            {
              provider: "claude",
              accountId: "cacc_b",
              revision: 1,
              reuse: undefined,
              path: "/home/m4lice000/.claude/.credentials.json",
            },
          ],
          removes: [],
          newId,
        }),
      ).toBeUndefined();
    }
  });

  it("retire the slot's previous placement only once the write landed", () => {
    const before = stateOf([placement("cpl_a")]);
    const began = begin(before, "cacc_b");
    expect(stateOfRows(began.placements).map((row) => row.state)).toEqual(["ready", "pending"]);
    const done = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: ["claude"],
      kept: [],
    });
    expect(stateOfRows(done.placements).map((row) => [row.accountId, row.state])).toEqual([
      ["cacc_a", "removing"],
      ["cacc_b", "ready"],
    ]);
    expect(done.stale).toBe(false);
  });

  it("keep the working login when the write is refused before anything landed", () => {
    const before = stateOf([placement("cpl_a")]);
    const began = begin(before, "cacc_b");
    const refused = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "refused",
      written: [],
    });
    expect(stateOfRows(refused.placements)).toEqual(stateOfRows([placement("cpl_a")]));
  });

  it("put back what a refused write meant to remove", () => {
    const before = stateOf([placement("cpl_a")]);
    const began = beginHomeWrite(before, {
      key,
      onBehalfOfUserId: "alice",
      writes: [],
      removes: ["claude"],
      newId,
    });
    if (began === undefined) throw new Error("the write did not begin");
    expect(began.placements.map((row) => row.state)).toEqual(["removing"]);
    const outcome: HomeWriteOutcome = { kind: "refused", written: [] };
    expect(
      settleHomeWrite({ ...before, placements: began.placements }, began.intent, outcome)
        .placements,
    ).toEqual([placement("cpl_a")]);
    expect(
      settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
        kind: "done",
        written: [],
        kept: [],
      }).placements,
    ).toEqual([]);
  });

  it("record no placement for a merged login the person's own login kept", () => {
    const pi = placement("cpl_pi", { provider: "pi", path: "/home/m4lice000/.pi/agent/auth.json" });
    const before = stateOf([pi], [account("cacc_c", { provider: "codex" })]);
    const began = beginHomeWrite(
      stateOf(
        [pi],
        [account("cacc_a", { provider: "codex" }), account("cacc_c", { provider: "codex" })],
      ),
      {
        key,
        onBehalfOfUserId: "alice",
        writes: [
          {
            provider: "pi",
            accountId: "cacc_c",
            revision: 1,
            reuse: undefined,
            path: pi.path,
          },
        ],
        removes: [],
        newId,
      },
    );
    if (began === undefined) throw new Error("the write did not begin");
    const settled = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: [],
      kept: ["pi"],
    });
    expect(stateOfRows(settled.placements)).toEqual([
      { id: "cpl_pi", provider: "pi", accountId: "cacc_a", revision: 1, state: "removing" },
    ]);
  });

  it("leave a write archive cancelled for removal, and say when the account moved past it", () => {
    const before = stateOf([]);
    const began = begin(before, "cacc_b");
    const archived = settleHomeWrite(
      {
        ...before,
        accounts: new Map([["cacc_b", account("cacc_b", { active: false, archived: true })]]),
        placements: began.placements.map((row) => ({ ...row, state: "removing" })),
      },
      began.intent,
      { kind: "done", written: ["claude"], kept: [] },
    );
    expect(archived.placements.map((row) => row.state)).toEqual(["removing"]);
    const moved = settleHomeWrite(
      {
        ...before,
        accounts: new Map([["cacc_b", account("cacc_b", { revision: 2 })]]),
        placements: began.placements,
      },
      began.intent,
      { kind: "done", written: ["claude"], kept: [] },
    );
    expect(moved).toMatchObject({ stale: true, placements: [{ state: "ready", revision: 1 }] });
  });

  it("bring a refreshed placement to its new revision under the same id", () => {
    const before = stateOf([placement("cpl_a")], [account("cacc_a", { revision: 2 })]);
    const began = begin(before, "cacc_a", 2, "cpl_a");
    expect(began.placements).toEqual([{ ...placement("cpl_a"), state: "pending" }]);
    const settled = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: ["claude"],
      kept: [],
    });
    expect(settled.placements).toEqual([{ ...placement("cpl_a"), revision: 2 }]);
    const lost = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "unconfirmed",
    });
    expect(settleInDoubt(lost.placements).map((row) => row.state)).toEqual(["removing"]);
  });
});

describe("pruneHome and removalWork", () => {
  it("keep live and default placements, and never remove a path a ready placement holds", () => {
    const rows = [
      placement("cpl_live", { provider: "codex", path: "/home/m4lice000/.codex/auth.json" }),
      placement("cpl_default"),
      placement("cpl_other", {
        provider: "github",
        accountId: "cacc_g",
        path: "/home/m4lice000/.config/gh/hosts.yml",
      }),
      placement("cpl_old", { accountId: "cacc_b", state: "removing" }),
    ];
    const pruned = pruneHome(stateOf(rows, [], ["cacc_a"]), ["cpl_live"]);
    expect(pruned.map((row) => [row.id, row.state])).toEqual([
      ["cpl_live", "ready"],
      ["cpl_default", "ready"],
      ["cpl_other", "removing"],
      ["cpl_old", "removing"],
    ]);
    expect(removalWork(pruned)).toEqual({
      removes: ["github"],
      forget: ["cpl_other", "cpl_old"],
    });
  });
});
