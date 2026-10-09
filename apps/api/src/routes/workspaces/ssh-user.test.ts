import {
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceUnauthorizedError,
} from "@sealant/api-contracts";
/**
 * A workspace's SSH user (Mend ADR 0016: Remote-SSH runs as the launcher's Linux user): its owner
 * names it at create or with `PUT .../ssh-user`, never root or a uid outside Mend's range; the
 * gateway's target carries it, and a workspace with a user answers no target to a gateway that
 * does not say it runs sessions as one (it would run them as root). The gateway token is set
 * before the dynamic imports because runtime-env parses process.env at module load.
 */
import {
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
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

/** One workspace row, kept in `row` so a test sees what a PUT wrote. */
const harness = (sshUser: string | null) => {
  const row = {
    current: { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1", sshUser } as Workspace,
  };
  const layer = Layer.mergeAll(
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
  return { row, layer };
};

const target = (
  layer: ReturnType<typeof harness>["layer"],
  input: { readonly principal: string; readonly sshUserGateway: boolean },
) =>
  Effect.runPromise(
    workspacesModule
      .getWorkspaceSshTarget({
        workspaceId: "wks_1",
        headers: {
          "x-sealant-gateway-token": "gateway-test-token",
          "x-sealant-principal-id": input.principal,
          ...(input.sshUserGateway ? { "x-sealant-gateway-ssh-user": "1" } : {}),
        },
      })
      .pipe(Effect.result, Effect.provide(layer)),
  );

describe("the gateway's target for a workspace's SSH sessions", () => {
  it("names the workspace's user to a gateway that runs sessions as one", async () => {
    const { layer } = harness("mabcdefgh");
    const result = await target(layer, { principal: OWNER, sshUserGateway: true });
    expect(Result.isSuccess(result) && result.success.user).toBe("mabcdefgh");
  });

  it("answers an older gateway nothing for a workspace with a user, never a root session", async () => {
    const { layer } = harness("mabcdefgh");
    const result = await target(layer, { principal: OWNER, sshUserGateway: false });
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceConflictError);
  });

  it("names no user, as before, for a workspace without one, whatever the gateway", async () => {
    const { layer } = harness(null);
    for (const sshUserGateway of [true, false]) {
      const result = await target(layer, { principal: OWNER, sshUserGateway });
      expect(Result.isSuccess(result)).toBe(true);
      expect(Result.isSuccess(result) && "user" in result.success).toBe(false);
    }
  });

  it("admits only the owner: another principal is refused before any user is named", async () => {
    const { layer } = harness("mabcdefgh");
    const result = await target(layer, { principal: "usr_bob", sshUserGateway: true });
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceUnauthorizedError);
  });
});

describe("PUT /v1/workspaces/:id/ssh-user", () => {
  const put = (
    layer: ReturnType<typeof harness>["layer"],
    payload: { readonly user: string | null; readonly ownerUserId?: string },
  ) =>
    Effect.runPromise(
      workspacesModule
        .setWorkspaceSshUser({ workspaceId: "wks_1", payload })
        .pipe(Effect.result, Effect.provide(layer)),
    );

  it("sets the user, and null sets it back to root", async () => {
    const { row, layer } = harness(null);
    const set = await put(layer, { user: "mabcdefgh", ownerUserId: OWNER });
    expect(Result.isSuccess(set) && set.success).toEqual({
      workspaceId: "wks_1",
      sshUser: "mabcdefgh",
    });
    expect(row.current.sshUser).toBe("mabcdefgh");
    const cleared = await put(layer, { user: null, ownerUserId: OWNER });
    expect(Result.isSuccess(cleared) && cleared.success.sshUser).toBeNull();
    expect(row.current.sshUser).toBeNull();
  });

  it("refuses root, a uid outside Mend's range and a malformed name, and writes nothing", async () => {
    for (const user of ["root", "0", "1000", "50000", "Bad Name"]) {
      const { row, layer } = harness(null);
      const result = await put(layer, { user, ownerUserId: OWNER });
      expect(Result.isFailure(result) && result.failure, user).toBeInstanceOf(
        WorkspaceBadRequestError,
      );
      expect(row.current.sshUser, user).toBeNull();
    }
  });

  it("finds nothing for another owner or for a request that names none", async () => {
    for (const ownerUserId of ["usr_bob", undefined]) {
      const { row, layer } = harness(null);
      const result = await put(layer, {
        user: "mabcdefgh",
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
      });
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceNotFoundError);
      expect(row.current.sshUser).toBeNull();
    }
  });
});
