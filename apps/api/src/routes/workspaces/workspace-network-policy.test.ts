/**
 * A workspace's network policy through the API (§7.3): a create stores its policy with the brokered
 * values sealed, and refuses values that do not match its secrets; "Apply updated policy" refuses
 * what the workspace's runtime cannot enforce and pushes the rest to a live egress proxy; a
 * revocation is stored before any proxy hears of it and answers what became of it there; the read
 * returns what is stored. The egress store is in memory with the live repository's watermark and
 * confirmation rules, the cipher is the real one, and the proxy's admin API is a real HTTP server
 * on a Unix socket. SEALANT_CREDENTIALS_KEY is set before the dynamic imports because
 * runtime-env parses process.env at module load.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalRevocationHost,
  WorkspaceBadRequestError,
  WorkspaceNotFoundError,
  WorkspaceRuntimeRequirementUnsupportedError,
  type BrokeredSecret,
  type CreateWorkspaceRequest,
  type NetworkPolicy,
} from "@sealant/api-contracts";
import {
  CredentialCipher,
  credentialCipherLayer,
  type CredentialCipherService,
} from "@sealant/credentials";
import {
  BoatAccountRepo,
  ConnectedAccountRepo,
  DatabaseTransaction,
  GitHubInstallationRepo,
  GitHubInstallationRepositoryCacheRepo,
  ProfileRepo,
  ResourceDomainRepo,
  UserRepo,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCaptureDrainRepo,
  WorkspaceCreateReservationRepo,
  WorkspaceEgressRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  tombstonesOf,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJobRepoService,
  type WorkspaceEgressPolicy,
  type WorkspaceEgressProxy,
  type WorkspaceEgressRepoService,
  type WorkspaceEgressRevocation,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
} from "@sealant/db";
import { fakeService } from "@sealant/db/testing/fake-service";
import {
  attemptRow,
  attemptSnapshotRow,
  buildJobRow,
  runtimeInstanceRow,
  workspaceRow,
} from "@sealant/db/testing/rows";
import { GitHubSourceIntegrationService } from "@sealant/source-integrations";
import { newWorkspaceSchema, type RuntimeAdapterId } from "@sealant/validators";
import { openBrokeredValues } from "@sealant/workspaces";
import { Effect, Layer, Redacted, Result } from "effect";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 9).toString("base64");

let workspaces: typeof import("./workspaces.module.js");
let routes: typeof import("./workspace-network-policy.js");
let capabilities: typeof import("../../services/control-plane-capabilities.js");

beforeAll(async () => {
  workspaces = await import("./workspaces.module.js");
  routes = await import("./workspace-network-policy.js");
  capabilities = await import("../../services/control-plane-capabilities.js");
});

const OWNER = "usr_owner";
const SECRET_VALUE = "Bearer vercel-real-secret";

const cipher: CredentialCipherService = Effect.runSync(
  Effect.gen(function* () {
    return yield* CredentialCipher;
  }).pipe(Effect.provide(credentialCipherLayer({ key: Buffer.alloc(32, 9).toString("base64") }))),
);

const vercelSecret = (secretId = "sec_vercel"): BrokeredSecret => ({
  secretId,
  name: "VERCEL_TOKEN",
  placeholder: "sealant-placeholder-vercel",
  secretRef: "vercel",
  headerName: "Authorization",
  bindHosts: ["api.vercel.com"],
});

const standardPolicy = (policyHash: string): NetworkPolicy => ({
  mode: "standard",
  policyHash,
  allowHosts: [{ host: "registry.npmjs.org" }],
});

/**
 * The egress store in memory, with the live repository's watermark, revision and confirmation
 * rules: every `putPolicy` of an existing row bumps its revision, and a confirmation never moves
 * the confirmed watermark or revision backwards.
 */
const memoryEgress = () => {
  const policies = new Map<string, WorkspaceEgressPolicy>();
  const revocations: WorkspaceEgressRevocation[] = [];
  const proxies = new Map<string, WorkspaceEgressProxy>();
  const at = new Date("2026-11-24T10:00:00.000Z");
  const emptyPolicy = (workspaceId: string): WorkspaceEgressPolicy => ({
    workspaceId,
    networkPolicy: null,
    brokeredSecrets: [],
    brokeredValuesSealed: null,
    encryptionKeyId: null,
    revocationWatermark: 0,
    policyRevision: 0,
    createdAt: at,
    updatedAt: at,
  });
  const listRevocations = (workspaceId: string) =>
    Effect.succeed(revocations.filter((row) => row.workspaceId === workspaceId));
  const service = fakeService<WorkspaceEgressRepoService>({
    getPolicy: (workspaceId) => Effect.succeed(policies.get(workspaceId)),
    putPolicy: (input) =>
      Effect.sync(() => {
        const existing = policies.get(input.workspaceId);
        const row: WorkspaceEgressPolicy = {
          ...(existing ?? emptyPolicy(input.workspaceId)),
          policyRevision: existing === undefined ? 0 : existing.policyRevision + 1,
          networkPolicy: input.networkPolicy ?? null,
          brokeredSecrets: input.brokeredSecrets,
          brokeredValuesSealed: input.brokeredValuesSealed ?? null,
          encryptionKeyId: input.encryptionKeyId ?? null,
        };
        policies.set(input.workspaceId, row);
        return row;
      }),
    revoke: (input) =>
      Effect.sync(() => {
        const current = policies.get(input.workspaceId) ?? emptyPolicy(input.workspaceId);
        const watermark = current.revocationWatermark + 1;
        policies.set(input.workspaceId, { ...current, revocationWatermark: watermark });
        const rows = [
          ...[...new Set(input.secretIds)].map((target) => ({ kind: "secret" as const, target })),
          ...[...new Set(input.hosts.map((host) => canonicalRevocationHost(host) ?? host))].map(
            (target) => ({
              kind: "host" as const,
              target,
            }),
          ),
          ...(input.all ? [{ kind: "all" as const, target: null }] : []),
        ];
        for (const row of rows) {
          revocations.push({
            id: revocations.length + 1,
            workspaceId: input.workspaceId,
            revocationWatermark: watermark,
            kind: row.kind,
            target: row.target,
            createdAt: at,
          });
        }
        return tombstonesOf(
          watermark,
          revocations.filter((row) => row.workspaceId === input.workspaceId),
        );
      }),
    listRevocations,
    tombstones: (workspaceId) =>
      Effect.sync(() =>
        tombstonesOf(
          policies.get(workspaceId)?.revocationWatermark ?? 0,
          revocations.filter((row) => row.workspaceId === workspaceId),
        ),
      ),
    getProxy: (runId) => Effect.succeed(proxies.get(runId)),
    confirmProxy: (input) =>
      Effect.sync(() => {
        const proxy = proxies.get(input.runId);
        if (proxy === undefined) return;
        if (
          proxy.confirmedRevocationWatermark !== null &&
          proxy.confirmedRevocationWatermark > input.revocationWatermark
        )
          return;
        proxies.set(input.runId, {
          ...proxy,
          ...(input.policyHash === undefined ? {} : { confirmedPolicyHash: input.policyHash }),
          ...(input.policyRevision === undefined
            ? {}
            : {
                confirmedPolicyRevision: Math.max(
                  proxy.confirmedPolicyRevision ?? -1,
                  input.policyRevision,
                ),
              }),
          confirmedRevocationWatermark: input.revocationWatermark,
        });
      }),
  });
  return { service, policies, revocations, proxies };
};

type MemoryEgress = ReturnType<typeof memoryEgress>;

/** What the fake proxy admin API received, and how it answers. */
interface AdminCall {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly body: unknown;
  /** How many revocations were stored when the proxy heard of this one. */
  readonly storedRevocations: number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** A refusal the fake admin API answers with instead of confirming. */
interface AdminRefusal {
  readonly status: number;
  readonly error: string;
}

/**
 * A proxy admin API on a Unix socket that confirms every request, closing `closed` streams, unless
 * `refuse` answers the call (by its index among the calls) with a refusal.
 */
const startAdminSocket = async (
  egress: MemoryEgress,
  closed: number,
  refuse: (call: AdminCall, index: number) => AdminRefusal | undefined = () => undefined,
) => {
  const dir = await tempDir("sealant-proxy-admin-");
  const socketPath = join(dir, "proxy-admin.sock");
  const calls: AdminCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const call: AdminCall = {
        method: req.method,
        url: req.url,
        body,
        storedRevocations: egress.revocations.length,
      };
      calls.push(call);
      const refusal = refuse(call, calls.length - 1);
      if (refusal !== undefined) {
        res.writeHead(refusal.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: refusal.error, message: "refused by the test" }));
        return;
      }
      const fields = typeof body === "object" && body !== null ? body : {};
      const answer = {
        policyHash: "policyHash" in fields ? fields.policyHash : undefined,
        revocationWatermark: "revocationWatermark" in fields ? fields.revocationWatermark : 0,
        closed,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socketPath, calls };
};

/** The run's proxy row, as the launch leaves it once it has measured the host. */
const proxyRow = (socketPath: string): WorkspaceEgressProxy => ({
  runId: "run_1",
  workspaceId: "ws_1",
  proxyContainer: "sealant-ws-1-proxy",
  adminSocketPath: socketPath,
  caCertPem: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
  caKeySealed: Effect.runSync(cipher.encrypt("ca-private-key")).sealed,
  encryptionKeyId: "k1",
  caNotAfter: new Date("2026-12-24T00:00:00.000Z"),
  network: {
    proxyIp: "172.30.0.2",
    operatorAllowedPrivateCidrs: [],
    hostPublicIps: ["203.0.113.7"],
    blockedCidrs: ["172.17.0.0/16"],
  },
  confirmedPolicyHash: null,
  confirmedPolicyRevision: null,
  confirmedRevocationWatermark: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

/** A launched workspace (`ws_1`, run `run_1`) on `runtime`, whose executor is `status`. */
const launchedLayer = (
  egress: MemoryEgress,
  options: {
    readonly runtime?: RuntimeAdapterId;
    readonly status?: WorkspaceRuntimeInstance["status"];
  } = {},
) => {
  const spec = newWorkspaceSchema.parse({
    sources: { workspace: { kind: "git", url: "https://github.com/example/repo.git" } },
    harness: { id: "opencode" },
    target: { runtime: { family: options.runtime ?? "docker", mode: "require" } },
  });
  return Layer.mergeAll(
    Layer.succeed(
      WorkspaceRepo,
      fakeService<WorkspaceRepoService>({
        getWorkspaceById: (id) =>
          Effect.succeed(
            id === "ws_1"
              ? workspaceRow({ id, ownerUserId: OWNER, latestRunId: "run_1" })
              : undefined,
          ),
      }),
    ),
    Layer.succeed(
      WorkspaceAttemptRepo,
      fakeService<WorkspaceAttemptRepoService>({
        getAttemptSnapshotByRunId: (runId) =>
          Effect.succeed(
            attemptSnapshotRow({ runId, userSpecPayload: spec, resolvedSpecPayload: spec }),
          ),
      }),
    ),
    Layer.succeed(
      WorkspaceBuildJobRepo,
      fakeService<WorkspaceBuildJobRepoService>({
        getLatestJobByRunId: (runId) => Effect.succeed(buildJobRow({ runId })),
      }),
    ),
    Layer.mock(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: (runId: string) =>
        Effect.succeed(
          runtimeInstanceRow({
            runId,
            adapter: options.runtime ?? "docker",
            status: options.status ?? "ready",
          }),
        ),
    }),
    Layer.succeed(WorkspaceEgressRepo, egress.service),
    Layer.succeed(CredentialCipher, cipher),
  );
};

describe("revokeWorkspaceAccess", () => {
  it("stores the revocation and answers next-start when no proxy runs for the workspace", async () => {
    const egress = memoryEgress();
    const response = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, secretIds: ["sec_vercel"] },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(response).toEqual({
      workspaceId: "ws_1",
      revocationWatermark: 1,
      enforcement: "next-start",
    });
    expect(egress.revocations.map((row) => [row.kind, row.target])).toEqual([
      ["secret", "sec_vercel"],
    ]);
  });

  it("stores the revocation before the live proxy hears of it, and answers enforced once it confirms", async () => {
    const egress = memoryEgress();
    const admin = await startAdminSocket(egress, 3);
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    const response = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, hosts: ["api.vercel.com"] },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(response).toEqual({
      workspaceId: "ws_1",
      revocationWatermark: 1,
      enforcement: "enforced",
      closed: 3,
    });
    expect(admin.calls).toEqual([
      {
        method: "POST",
        url: "/v1/revoke",
        body: {
          revocationWatermark: 1,
          revokeSecretIds: [],
          revokeHosts: ["api.vercel.com"],
          revokeAll: false,
        },
        storedRevocations: 1,
      },
    ]);
    expect(egress.proxies.get("run_1")?.confirmedRevocationWatermark).toBe(1);
  });

  it("answers pending, with the revocation still stored, when the proxy's socket is gone", async () => {
    const egress = memoryEgress();
    const dir = await tempDir("sealant-proxy-gone-");
    egress.proxies.set("run_1", proxyRow(join(dir, "proxy-admin.sock")));
    const response = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, secretIds: ["sec_vercel"] },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(response).toEqual({
      workspaceId: "ws_1",
      revocationWatermark: 1,
      enforcement: "pending",
    });
    expect(egress.revocations).toHaveLength(1);
    expect(egress.proxies.get("run_1")?.confirmedRevocationWatermark).toBeNull();
  });

  it("does not push to the proxy of a run that is no longer up", async () => {
    const egress = memoryEgress();
    const admin = await startAdminSocket(egress, 0);
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    const response = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({ workspaceId: "ws_1", payload: { ownerUserId: OWNER, all: true } })
        .pipe(Effect.provide(launchedLayer(egress, { status: "stopped" }))),
    );
    expect(response.enforcement).toBe("next-start");
    expect(admin.calls).toEqual([]);
  });

  it("revokes every grant the stored policy holds when it revokes all", async () => {
    const egress = memoryEgress();
    egress.policies.set("ws_1", {
      workspaceId: "ws_1",
      networkPolicy: standardPolicy("ph_1"),
      brokeredSecrets: [vercelSecret()],
      brokeredValuesSealed: null,
      encryptionKeyId: null,
      revocationWatermark: 0,
      policyRevision: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({ workspaceId: "ws_1", payload: { ownerUserId: OWNER, all: true } })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(egress.revocations.map((row) => [row.kind, row.target])).toEqual([
      ["secret", "sec_vercel"],
      ["host", "registry.npmjs.org"],
      ["host", "api.vercel.com"],
      ["all", null],
    ]);
  });

  it("sends every stored tombstone, so a revocation an earlier push missed goes with the next", async () => {
    const egress = memoryEgress();
    // The first revocation's push is not confirmed: the proxy may not hold it.
    const admin = await startAdminSocket(egress, 0, (_call, index) =>
      index === 0 ? { status: 500, error: "close_unconfirmed" } : undefined,
    );
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    const revoke = (payload: { secretIds?: string[]; hosts?: string[] }) =>
      Effect.runPromise(
        routes
          .revokeWorkspaceAccess({
            workspaceId: "ws_1",
            payload: { ownerUserId: OWNER, ...payload },
          })
          .pipe(Effect.provide(launchedLayer(egress))),
      );
    expect((await revoke({ secretIds: ["sec_vercel"] })).enforcement).toBe("pending");
    expect(await revoke({ hosts: ["API.Vercel.com."] })).toEqual({
      workspaceId: "ws_1",
      revocationWatermark: 2,
      enforcement: "enforced",
      closed: 0,
    });
    expect(admin.calls[1]?.body).toEqual({
      revocationWatermark: 2,
      revokeSecretIds: ["sec_vercel"],
      revokeHosts: ["api.vercel.com"],
      revokeAll: false,
    });
    expect(egress.proxies.get("run_1")?.confirmedRevocationWatermark).toBe(2);
  });

  it("pushes the whole stored policy when the proxy holds a later watermark, and answers enforced once it takes it", async () => {
    const egress = memoryEgress();
    egress.policies.set("ws_1", {
      workspaceId: "ws_1",
      networkPolicy: standardPolicy("ph_1"),
      brokeredSecrets: [],
      brokeredValuesSealed: null,
      encryptionKeyId: null,
      revocationWatermark: 0,
      policyRevision: 4,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const admin = await startAdminSocket(egress, 2, (call) =>
      call.url === "/v1/revoke" ? { status: 409, error: "watermark_rollback" } : undefined,
    );
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    const layer = launchedLayer(egress);
    await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, secretIds: ["sec_old"] },
        })
        .pipe(Effect.provide(layer)),
    );
    const response = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, hosts: ["registry.npmjs.org"] },
        })
        .pipe(Effect.provide(layer)),
    );
    expect(response).toEqual({
      workspaceId: "ws_1",
      revocationWatermark: 2,
      enforcement: "enforced",
      closed: 2,
    });
    const put = admin.calls.at(-1);
    expect(put).toMatchObject({ method: "PUT", url: "/v1/policy" });
    expect(put?.body).toMatchObject({
      policyHash: "ph_1",
      revocationWatermark: 2,
      revokedSecretIds: ["sec_old"],
      revokedHosts: ["registry.npmjs.org"],
    });
    expect(egress.proxies.get("run_1")).toMatchObject({
      confirmedPolicyHash: "ph_1",
      confirmedPolicyRevision: 4,
      confirmedRevocationWatermark: 2,
    });
  });

  it("refuses a host revocation on a runtime that runs no egress proxy, storing nothing", async () => {
    for (const runtime of ["k8s", "boat"] as const) {
      const egress = memoryEgress();
      const result = await Effect.runPromise(
        routes
          .revokeWorkspaceAccess({
            workspaceId: "ws_1",
            payload: { ownerUserId: OWNER, hosts: ["api.vercel.com"] },
          })
          .pipe(Effect.result, Effect.provide(launchedLayer(egress, { runtime }))),
      );
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
        WorkspaceRuntimeRequirementUnsupportedError,
      );
      expect(egress.revocations).toEqual([]);
      expect(egress.policies.size).toBe(0);
    }
    // A secret revocation there is stored, and holds from the next start.
    const egress = memoryEgress();
    const allowed = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, secretIds: ["sec_vercel"] },
        })
        .pipe(Effect.provide(launchedLayer(egress, { runtime: "k8s" }))),
    );
    expect(allowed.enforcement).toBe("next-start");
  });

  it("refuses another owner's workspace as not found, storing nothing", async () => {
    const egress = memoryEgress();
    const result = await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: "usr_other", all: true },
        })
        .pipe(Effect.result, Effect.provide(launchedLayer(egress))),
    );
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceNotFoundError);
    expect(egress.revocations).toEqual([]);
  });
});

describe("applyWorkspaceNetworkPolicy", () => {
  it("refuses a brokered secret on a runtime that runs no egress proxy, storing nothing", async () => {
    const egress = memoryEgress();
    const result = await Effect.runPromise(
      routes
        .applyWorkspaceNetworkPolicy({
          workspaceId: "ws_1",
          payload: {
            ownerUserId: OWNER,
            networkPolicy: standardPolicy("ph_2"),
            brokeredSecrets: [vercelSecret()],
            brokeredSecretValues: { vercel: SECRET_VALUE },
          },
        })
        .pipe(Effect.result, Effect.provide(launchedLayer(egress, { runtime: "k8s" }))),
    );
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
      WorkspaceRuntimeRequirementUnsupportedError,
    );
    expect(egress.policies.size).toBe(0);
  });

  it("stores the policy with its values sealed and answers next-start when no proxy runs", async () => {
    const egress = memoryEgress();
    const response = await Effect.runPromise(
      routes
        .applyWorkspaceNetworkPolicy({
          workspaceId: "ws_1",
          payload: {
            ownerUserId: OWNER,
            networkPolicy: standardPolicy("ph_2"),
            brokeredSecrets: [vercelSecret()],
            brokeredSecretValues: { vercel: SECRET_VALUE },
          },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(response).toEqual({
      workspaceId: "ws_1",
      policyHash: "ph_2",
      revocationWatermark: 0,
      enforcement: "next-start",
    });
    const stored = egress.policies.get("ws_1");
    expect(stored?.networkPolicy).toEqual(standardPolicy("ph_2"));
    expect(stored?.brokeredValuesSealed).not.toContain("vercel-real-secret");
    const opened = await Effect.runPromise(
      openBrokeredValues(cipher, stored?.brokeredValuesSealed),
    );
    expect(Redacted.value(opened)).toEqual({ vercel: SECRET_VALUE });
  });

  it("pushes the stored policy, revocations included, to the live proxy and records what it confirmed", async () => {
    const egress = memoryEgress();
    // The workspace already holds the secret's placeholder: only the proxy's side changes.
    egress.policies.set("ws_1", {
      workspaceId: "ws_1",
      networkPolicy: standardPolicy("ph_1"),
      brokeredSecrets: [vercelSecret()],
      brokeredValuesSealed: null,
      encryptionKeyId: null,
      revocationWatermark: 0,
      policyRevision: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const admin = await startAdminSocket(egress, 1);
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    await Effect.runPromise(
      routes
        .revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, secretIds: ["sec_old"] },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    const response = await Effect.runPromise(
      routes
        .applyWorkspaceNetworkPolicy({
          workspaceId: "ws_1",
          payload: {
            ownerUserId: OWNER,
            networkPolicy: standardPolicy("ph_3"),
            brokeredSecrets: [vercelSecret()],
            brokeredSecretValues: { vercel: SECRET_VALUE },
          },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(response).toEqual({
      workspaceId: "ws_1",
      policyHash: "ph_3",
      revocationWatermark: 1,
      enforcement: "enforced",
      closed: 1,
    });
    const put = admin.calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("/v1/policy");
    expect(put?.body).toMatchObject({
      policyHash: "ph_3",
      revocationWatermark: 1,
      revokedSecretIds: ["sec_old"],
      brokeredSecrets: [{ secretId: "sec_vercel", value: SECRET_VALUE }],
    });
    expect(egress.proxies.get("run_1")).toMatchObject({
      confirmedPolicyHash: "ph_3",
      confirmedRevocationWatermark: 1,
    });
  });
});

describe("applyWorkspaceNetworkPolicy · what a live proxy can take", () => {
  const apply = (egress: MemoryEgress, value: string) =>
    Effect.runPromise(
      routes
        .applyWorkspaceNetworkPolicy({
          workspaceId: "ws_1",
          payload: {
            ownerUserId: OWNER,
            networkPolicy: standardPolicy("ph_5"),
            brokeredSecrets: [vercelSecret()],
            brokeredSecretValues: { vercel: value },
          },
        })
        .pipe(Effect.provide(launchedLayer(egress))),
    );

  it("answers next-start for a brokered secret new to the workspace, though the proxy took it", async () => {
    const egress = memoryEgress();
    const admin = await startAdminSocket(egress, 1);
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    expect(await apply(egress, SECRET_VALUE)).toEqual({
      workspaceId: "ws_1",
      policyHash: "ph_5",
      revocationWatermark: 0,
      enforcement: "next-start",
    });
    expect(admin.calls.map((call) => [call.method, call.url])).toEqual([["PUT", "/v1/policy"]]);
    expect(egress.proxies.get("run_1")?.confirmedPolicyHash).toBe("ph_5");
  });

  it("enforces a rotated value at once, and records the revision the proxy confirmed", async () => {
    const egress = memoryEgress();
    // Applied while no proxy ran: the workspace boots with the secret's placeholder.
    await apply(egress, SECRET_VALUE);
    const admin = await startAdminSocket(egress, 1);
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    const rotated = await apply(egress, "Bearer vercel-rotated");
    expect(rotated.enforcement).toBe("enforced");
    expect(admin.calls[0]?.body).toMatchObject({
      brokeredSecrets: [{ secretId: "sec_vercel", value: "Bearer vercel-rotated" }],
    });
    // Same policy hash as before: only the revision tells the proxy has the new value.
    expect(egress.policies.get("ws_1")?.policyRevision).toBe(1);
    expect(egress.proxies.get("run_1")).toMatchObject({
      confirmedPolicyHash: "ph_5",
      confirmedPolicyRevision: 1,
    });
  });
});

describe("getWorkspaceNetworkPolicy", () => {
  it("returns the stored policy, every revocation and what the proxy last confirmed", async () => {
    const egress = memoryEgress();
    const admin = await startAdminSocket(egress, 0);
    egress.proxies.set("run_1", proxyRow(admin.socketPath));
    const layer = launchedLayer(egress);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* routes.applyWorkspaceNetworkPolicy({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, networkPolicy: standardPolicy("ph_4") },
        });
        yield* routes.revokeWorkspaceAccess({
          workspaceId: "ws_1",
          payload: { ownerUserId: OWNER, hosts: ["registry.npmjs.org"], all: true },
        });
      }).pipe(Effect.provide(layer)),
    );
    const read = await Effect.runPromise(
      routes
        .getWorkspaceNetworkPolicy({ workspaceId: "ws_1", query: { ownerUserId: OWNER } })
        .pipe(Effect.provide(layer)),
    );
    expect(read).toEqual({
      workspaceId: "ws_1",
      networkPolicy: standardPolicy("ph_4"),
      brokeredSecrets: [],
      revocationWatermark: 1,
      revocations: [
        {
          revocationWatermark: 1,
          kind: "host",
          target: "registry.npmjs.org",
          revokedAt: "2026-11-24T10:00:00.000Z",
        },
        { revocationWatermark: 1, kind: "all", revokedAt: "2026-11-24T10:00:00.000Z" },
      ],
      proxy: { runId: "run_1", confirmedPolicyHash: "ph_4", confirmedRevocationWatermark: 1 },
    });
  });

  it("reads a workspace created without a policy as no policy and no revocations", async () => {
    const egress = memoryEgress();
    const read = await Effect.runPromise(
      routes
        .getWorkspaceNetworkPolicy({ workspaceId: "ws_1", query: { ownerUserId: OWNER } })
        .pipe(Effect.provide(launchedLayer(egress))),
    );
    expect(read).toEqual({
      workspaceId: "ws_1",
      brokeredSecrets: [],
      revocationWatermark: 0,
      revocations: [],
    });
  });
});

describe("createWorkspace · network policy and brokered secrets", () => {
  interface CreateState {
    job?: unknown;
    snapshot?: unknown;
    published?: string;
  }

  const createLayer = (egress: MemoryEgress, state: CreateState) =>
    Layer.mergeAll(
      Layer.mock(ConnectedAccountRepo, {}),
      Layer.mock(BoatAccountRepo, {}),
      Layer.mock(GitHubInstallationRepo, {}),
      Layer.mock(GitHubInstallationRepositoryCacheRepo, {}),
      Layer.mock(GitHubSourceIntegrationService, {
        isConfigured: () => false,
        isWebhookVerificationConfigured: () => false,
        verifyWebhookSignature: () => false,
      }),
      Layer.mock(ProfileRepo, {}),
      Layer.mock(UserRepo, {}),
      Layer.mock(ResourceDomainRepo, {}),
      Layer.mock(WorkspaceCaptureDrainRepo, {}),
      Layer.mock(WorkspaceRuntimeInstanceRepo, {}),
      Layer.mock(WorkspaceCreateReservationRepo, {}),
      Layer.succeed(
        WorkspaceRepo,
        fakeService<WorkspaceRepoService>({
          listWorkspaces: () => Effect.succeed([]),
          createWorkspace: (input) =>
            Effect.succeed(workspaceRow({ id: input.id, ownerUserId: input.ownerUserId })),
          linkWorkspaceAttempt: (input) =>
            Effect.succeed({
              workspaceId: input.workspaceId,
              runId: input.attemptId,
              relation: "launch" as const,
              linkedAt: new Date(0),
            }),
        }),
      ),
      Layer.succeed(
        WorkspaceAttemptRepo,
        fakeService<WorkspaceAttemptRepoService>({
          createQueuedAttempt: (input) => Effect.succeed(attemptRow({ id: input.id })),
          setAttemptSnapshot: (input) =>
            Effect.sync(() => {
              state.snapshot = input.specPayload;
              return attemptSnapshotRow({ runId: input.runId });
            }),
        }),
      ),
      Layer.succeed(
        WorkspaceBuildJobRepo,
        fakeService<WorkspaceBuildJobRepoService>({
          insertQueuedJob: (input) =>
            Effect.sync(() => {
              state.job = input.requestPayload;
              return buildJobRow({ id: input.id });
            }),
        }),
      ),
      Layer.succeed(WorkspaceEgressRepo, egress.service),
      Layer.succeed(DatabaseTransaction, { run: (effect) => effect }),
      Layer.succeed(CredentialCipher, cipher),
      Layer.succeed(capabilities.PackageStandardizerService, {
        resolvePackage: () => Effect.die("unused"),
      }),
      Layer.succeed(capabilities.WorkspaceBuildJobPublisherService, {
        publishRequested: ({ jobId }) => {
          state.published = jobId;
          return Promise.resolve();
        },
      }),
    );

  const payload = (input: {
    readonly runtime?: RuntimeAdapterId;
    readonly brokeredSecrets?: readonly BrokeredSecret[];
    readonly values?: Record<string, string>;
    readonly secretEnv?: Record<string, string>;
  }): CreateWorkspaceRequest => ({
    ownerUserId: OWNER,
    registryId: "default",
    repository: "network-policy",
    tag: "latest",
    captureToken: "channel_secret",
    ...(input.secretEnv === undefined ? {} : { secretEnv: input.secretEnv }),
    ...(input.values === undefined ? {} : { brokeredSecretValues: input.values }),
    spec: {
      sources: {
        workspace: {
          kind: "capture",
          endpoint: "https://mend.example.com/session/s1",
          worktreeId: "wt_1",
          harnessHome: "/workspace/harness-home",
        },
      },
      harness: { id: "claude-code" },
      target: { runtime: { family: input.runtime ?? "docker", mode: "require" } },
      networkPolicy: standardPolicy("ph_create"),
      ...(input.brokeredSecrets === undefined ? {} : { brokeredSecrets: input.brokeredSecrets }),
    },
  });

  const create = (egress: MemoryEgress, state: CreateState, body: CreateWorkspaceRequest) =>
    Effect.runPromise(
      workspaces
        .createWorkspace({ payload: body, headers: {} })
        .pipe(Effect.result, Effect.provide(createLayer(egress, state))),
    );

  it("stores the policy with the values sealed, never in the spec, before the launch is published", async () => {
    const egress = memoryEgress();
    const state: CreateState = {};
    const result = await create(
      egress,
      state,
      payload({ brokeredSecrets: [vercelSecret()], values: { vercel: SECRET_VALUE } }),
    );
    expect(Result.isSuccess(result)).toBe(true);
    const workspaceId = Result.isSuccess(result) ? result.success.workspaceId : "";
    const stored = egress.policies.get(workspaceId);
    expect(stored?.networkPolicy).toEqual(standardPolicy("ph_create"));
    expect(stored?.brokeredSecrets).toEqual([vercelSecret()]);
    expect(stored?.brokeredValuesSealed).not.toContain("vercel-real-secret");
    const opened = await Effect.runPromise(
      openBrokeredValues(cipher, stored?.brokeredValuesSealed),
    );
    expect(Redacted.value(opened)).toEqual({ vercel: SECRET_VALUE });
    expect(JSON.stringify(state.job)).not.toContain("vercel-real-secret");
    expect(JSON.stringify(state.snapshot)).not.toContain("vercel-real-secret");
    expect(state.published).toBeDefined();
  });

  it("refuses a brokered secret with no value, storing and publishing nothing", async () => {
    const egress = memoryEgress();
    const state: CreateState = {};
    const result = await create(egress, state, payload({ brokeredSecrets: [vercelSecret()] }));
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceBadRequestError);
    expect(egress.policies.size).toBe(0);
    expect(state.published).toBeUndefined();
  });

  it("refuses a brokered secret whose variable secretEnv also sets", async () => {
    const egress = memoryEgress();
    const state: CreateState = {};
    const result = await create(
      egress,
      state,
      payload({
        brokeredSecrets: [vercelSecret()],
        values: { vercel: SECRET_VALUE },
        secretEnv: { VERCEL_TOKEN: "plain" },
      }),
    );
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(WorkspaceBadRequestError);
    expect(egress.policies.size).toBe(0);
    expect(state.published).toBeUndefined();
  });

  it("refuses a brokered secret on a runtime that runs no egress proxy, from the runtime table", async () => {
    const egress = memoryEgress();
    const refused = await create(
      egress,
      {},
      payload({
        runtime: "k8s",
        brokeredSecrets: [vercelSecret()],
        values: { vercel: SECRET_VALUE },
      }),
    );
    expect(Result.isFailure(refused) && refused.failure).toBeInstanceOf(
      WorkspaceRuntimeRequirementUnsupportedError,
    );
    // The same create without the secret is not refused for its runtime.
    const unbrokered = await create(memoryEgress(), {}, payload({ runtime: "k8s" }));
    expect(Result.isFailure(unbrokered) && unbrokered.failure).not.toBeInstanceOf(
      WorkspaceRuntimeRequirementUnsupportedError,
    );
    expect(egress.policies.size).toBe(0);
  });
});
