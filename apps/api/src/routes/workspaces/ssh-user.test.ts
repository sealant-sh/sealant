/**
 * A workspace's SSH user (Mend ADR 0016: Remote-SSH runs as the launcher's Linux user): the owner's
 * own uid, taken at create from their `credentialsHome` (`sshAsOwner`), never a user a caller
 * names; after create it can only go back to root (`DELETE .../ssh-user`). The gateway's target
 * always states it (`sessionUser`, `null` for root), and a workspace with a user answers no target
 * to a gateway that does not say it runs sessions as one (it would run them as root). The gateway
 * token is set before the dynamic imports because runtime-env parses process.env at module load.
 */
import {
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceSshKeyNoLongerRegisteredError,
  WorkspaceUnauthorizedError,
} from "@sealant/api-contracts";
import {
  SshKeyRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type SshKey,
  type SshKeyRepoService,
  type Workspace,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["WORKSPACE_SSH_GATEWAY_TOKEN"] = "gateway-test-token";

let workspacesModule: typeof import("./workspaces.module.js");

beforeAll(async () => {
  workspacesModule = await import("./workspaces.module.js");
});

const OWNER = "usr_alice";

const instance = {
  runId: "run_1",
  adapter: "docker",
  resourceId: "container-1",
  reference: "ref-1",
  status: "ready",
  endpoint: "unix:///run/sealant/control.sock",
} as unknown as WorkspaceRuntimeInstance;

const ALICE_KEY = "SHA256:aliceKeyFingerprint";

/**
 * One workspace row, kept in `row` so a test sees what a PUT wrote, and the registered keys by
 * fingerprint (`keys`), which a test edits to remove one.
 */
const harness = (sshUser: string | null) => {
  const row = {
    current: { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1", sshUser } as Workspace,
  };
  const keys = new Map<string, string>([[ALICE_KEY, OWNER]]);
  const layer = Layer.mergeAll(
    Layer.succeed(SshKeyRepo, {
      findActiveSshKeyByFingerprint: (fingerprint: string) => {
        const ownerUserId = keys.get(fingerprint);
        return Effect.succeed(
          ownerUserId === undefined
            ? undefined
            : ({ id: `key_${fingerprint}`, ownerUserId, fingerprint } as SshKey),
        );
      },
    } as unknown as SshKeyRepoService),
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) =>
        Effect.succeed(id === row.current.id ? row.current : undefined),
      setWorkspaceSshUser: (input: { readonly id: string; readonly sshUser: string | null }) => {
        if (input.id !== row.current.id) return Effect.succeed(null);
        row.current = { ...row.current, sshUser: input.sshUser };
        return Effect.succeed(row.current);
      },
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () => Effect.succeed(instance),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
  );
  return { row, keys, layer };
};

const target = (
  layer: ReturnType<typeof harness>["layer"],
  input: {
    readonly principal: string;
    readonly sshUserGateway: boolean;
    readonly keyFingerprint?: string;
  },
) =>
  Effect.runPromise(
    workspacesModule
      .getWorkspaceSshTarget({
        workspaceId: "wks_1",
        headers: {
          "x-sealant-gateway-token": "gateway-test-token",
          "x-sealant-principal-id": input.principal,
          ...(input.sshUserGateway ? { "x-sealant-gateway-ssh-user": "1" } : {}),
          ...(input.keyFingerprint === undefined
            ? {}
            : { "x-sealant-ssh-key-fingerprint": input.keyFingerprint }),
        },
      })
      .pipe(Effect.result, Effect.provide(layer)),
  );

describe("the gateway's target for a workspace's SSH sessions", () => {
  it("names the workspace's user to a gateway that runs sessions as one", async () => {
    const { layer } = harness("40001");
    const result = await target(layer, { principal: OWNER, sshUserGateway: true });
    expect(Result.isSuccess(result) && result.success.sessionUser).toBe("40001");
  });

  it("answers an older gateway nothing for a workspace with a user, never a root session", async () => {
    const { layer } = harness("40001");
    const result = await target(layer, { principal: OWNER, sshUserGateway: false });
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceConflictError);
  });

  it("says root outright for a workspace without a user, whatever the gateway", async () => {
    const { layer } = harness(null);
    for (const sshUserGateway of [true, false]) {
      const result = await target(layer, { principal: OWNER, sshUserGateway });
      // Stated, never left out: a gateway refuses a target that does not say (an older API).
      expect(Result.isSuccess(result) && result.success.sessionUser).toBeNull();
    }
  });

  it("admits only the owner: another principal is refused before any user is named", async () => {
    const { layer } = harness("40001");
    const result = await target(layer, { principal: "usr_bob", sshUserGateway: true });
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceUnauthorizedError);
  });
});

describe("the gateway's target for a connection's key", () => {
  it("answers while the key the connection logged in with is registered, and says it checked", async () => {
    const { layer } = harness(null);
    const result = await target(layer, {
      principal: OWNER,
      sshUserGateway: true,
      keyFingerprint: ALICE_KEY,
    });
    expect(Result.isSuccess(result) && result.success.sshKeyFingerprint).toBe(ALICE_KEY);
  });

  it("refuses once the key is removed, so an open connection opens nothing new", async () => {
    const { keys, layer } = harness(null);
    keys.delete(ALICE_KEY);
    const result = await target(layer, {
      principal: OWNER,
      sshUserGateway: true,
      keyFingerprint: ALICE_KEY,
    });
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
      WorkspaceSshKeyNoLongerRegisteredError,
    );
  });

  it("refuses a key now registered to someone else", async () => {
    const { keys, layer } = harness(null);
    keys.set(ALICE_KEY, "usr_bob");
    const result = await target(layer, {
      principal: OWNER,
      sshUserGateway: true,
      keyFingerprint: ALICE_KEY,
    });
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
      WorkspaceSshKeyNoLongerRegisteredError,
    );
  });

  it("echoes no key when the gateway named none (a key from its own allowlist file)", async () => {
    const { layer } = harness(null);
    const result = await target(layer, { principal: OWNER, sshUserGateway: true });
    expect(Result.isSuccess(result) && result.success.sshKeyFingerprint).toBeUndefined();
  });
});

describe("DELETE /v1/workspaces/:id/ssh-user", () => {
  const clear = (layer: ReturnType<typeof harness>["layer"], ownerUserId?: string) =>
    Effect.runPromise(
      workspacesModule
        .clearWorkspaceSshUser({
          workspaceId: "wks_1",
          query: ownerUserId === undefined ? {} : { ownerUserId },
        })
        .pipe(Effect.result, Effect.provide(layer)),
    );

  it("sets the sessions back to root, the only change after create: no caller names a user", async () => {
    const { row, layer } = harness("40001");
    const cleared = await clear(layer, OWNER);
    expect(Result.isSuccess(cleared) && cleared.success).toEqual({
      workspaceId: "wks_1",
      sshUser: null,
    });
    expect(row.current.sshUser).toBeNull();
  });

  it("finds nothing for another owner or for a request that names none", async () => {
    for (const ownerUserId of ["usr_bob", undefined]) {
      const { row, layer } = harness("40001");
      const result = await clear(layer, ownerUserId);
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceNotFoundError);
      expect(row.current.sshUser).toBe("40001");
    }
  });
});
