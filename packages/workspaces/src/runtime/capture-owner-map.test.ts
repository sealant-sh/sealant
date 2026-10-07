/**
 * The capture owner map (sealantd ADR-0015 "Per-person saved directories", Mend's ADR 0016
 * decision 8): checked on every blueprint parse, encoded exactly as sealantd's `OwnerMap::parse`
 * reads it, delivered as `SEALANT_CAPTURE_OWNER_MAP` by every runtime that boots a capture
 * executor, never settable through a blueprint's legacy `runtime.env` or a bound ConfigMap, and
 * refused at launch on an image whose daemon does not report `restore.owner_map`.
 */
import {
  captureOwnerMapProblems,
  encodeCaptureOwnerMap,
  type CaptureOwnerMap,
} from "@sealant/api-contracts/capture-owner-map";
import { parseWorkspaceBlueprint, type WorkspaceImageProbe } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { imageAppliesOwnerMap } from "../buildkit/person-layout.js";
import { ownerMapLaunchRefusal } from "../worker/process-workspace-build-job.js";
import { captureOwnerMapEnv, captureSourceEnv } from "./capture-source.js";
import { supportForCloudflare } from "./cloudflare/adapter.js";
import { cases } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import { supportForKubernetes } from "./kubernetes/adapter.js";
import { kubernetesRuntimeConfigSchema } from "./kubernetes/config.js";
import { plainEnvEntries } from "./kubernetes/manifests.js";
import { microvmBootEnv } from "./microvm/adapter.js";
import {
  parseRuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchInput,
} from "./runtime-adapter.js";

const OWNER_MAP: CaptureOwnerMap = {
  gid: 40000,
  worktreeUid: 40012,
  people: [
    { id: "acct_b", uid: 40031 },
    { id: "acct_a", uid: 40012 },
  ],
};

/** What sealantd's own tests feed `OwnerMap::parse` for the same people. */
const ENCODED = '{"gid":40000,"worktree":40012,"people":{"acct_a":40012,"acct_b":40031}}';

const captureLaunch = (
  overrides: { readonly ownerMap?: unknown; readonly env?: Record<string, string> } = {},
): RuntimeAdapterLaunchInput =>
  parseRuntimeAdapterLaunchInput({
    ...cases.capture,
    blueprint: {
      ...cases.capture.blueprint,
      sources: {
        ...cases.capture.blueprint.sources,
        workspace: {
          ...cases.capture.blueprint.sources.workspace,
          ...(overrides.ownerMap === undefined ? {} : { ownerMap: overrides.ownerMap }),
        },
      },
      runtime: {
        ...cases.capture.blueprint.runtime,
        env: overrides.env ?? cases.capture.blueprint.runtime.env,
      },
    },
  });

const captureSourceOf = (launch: RuntimeAdapterLaunchInput) => {
  const source = launch.blueprint.sources.workspace;
  if (source.kind !== "capture") throw new Error("expected a capture source");
  return source;
};

const ownerMapEntries = (entries: ReadonlyArray<readonly [string, string]>) =>
  entries.filter(([key]) => key === "SEALANT_CAPTURE_OWNER_MAP");

const k8sConfig = kubernetesRuntimeConfigSchema.parse({
  namespace: "sealant-workspaces",
  volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
  resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "8Gi" } },
  certManagerIssuer: { name: "sealant-internal" },
});

const dockerArgs = async (launch: RuntimeAdapterLaunchInput): Promise<string[]> => {
  const runner = vi.fn(async (_command: string, args: string[]) =>
    args[0] === "run"
      ? { stdout: "container-id\n", stderr: "" }
      : { stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n', stderr: "" },
  );
  const adapter = new DockerRuntimeAdapter({
    commandRunner: runner,
    containerNamePrefix: "sealant-test",
    runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
  });
  await adapter.launch({ ...launch, secretEnvDir: "/host/staging/secret-env" });
  const run = runner.mock.calls.find(([, args]) => args[0] === "run");
  return run?.[1] ?? [];
};

const probe = (sealantd: WorkspaceImageProbe["sealantd"]): WorkspaceImageProbe => ({
  version: 1,
  tools: {
    sudo: true,
    sudoSetuid: true,
    useradd: true,
    groupadd: true,
    setfacl: true,
    getfacl: true,
    setpriv: true,
    flock: true,
  },
  sudoersMend: true,
  sudoersIncludesDir: true,
  noNewPrivileges: false,
  passwdWritable: true,
  mendGroup: "present",
  reservedIdsInUse: [],
  personEnv: true,
  sharedDirs: [],
  sealantd,
});

describe("the owner map's checks", () => {
  it("accepts Mend's shape and keeps it as given", () => {
    const blueprint = captureLaunch({ ownerMap: OWNER_MAP }).blueprint;
    const source = blueprint.sources.workspace;
    expect(source.kind === "capture" ? source.ownerMap : undefined).toEqual(OWNER_MAP);
    expect(captureOwnerMapProblems(OWNER_MAP)).toEqual([]);
  });

  it("accepts a map that names nobody (the worktree to the group, no-new-privileges kept)", () => {
    expect(captureOwnerMapProblems({ gid: 40000, worktreeUid: 40001, people: [] })).toEqual([]);
  });

  it.each([
    [{ ...OWNER_MAP, gid: 0 }, /gid must be 40000/],
    [{ ...OWNER_MAP, gid: 1000 }, /gid must be 40000/],
    [{ ...OWNER_MAP, worktreeUid: 0 }, /worktreeUid 0 is not a uid in 40001–49999/],
    [{ ...OWNER_MAP, worktreeUid: 40000 }, /worktreeUid 40000/],
    [{ ...OWNER_MAP, worktreeUid: 50000 }, /worktreeUid 50000/],
    [{ ...OWNER_MAP, worktreeUid: 40001.5 }, /worktreeUid/],
    [{ ...OWNER_MAP, people: [{ id: "acct_a", uid: 1000 }] }, /acct_a has uid 1000/],
    [{ ...OWNER_MAP, people: [{ id: "root", uid: 0 }] }, /root has uid 0/],
    [{ ...OWNER_MAP, people: [{ id: "a/b", uid: 40002 }] }, /people\[0\]\.id must be one/],
    [{ ...OWNER_MAP, people: [{ id: "..", uid: 40002 }] }, /people\[0\]\.id/],
    [{ ...OWNER_MAP, people: [{ id: ".", uid: 40002 }] }, /people\[0\]\.id/],
    [{ ...OWNER_MAP, people: [{ id: "", uid: 40002 }] }, /people\[0\]\.id/],
    [{ ...OWNER_MAP, people: [{ id: "-x", uid: 40002 }] }, /people\[0\]\.id/],
    [{ ...OWNER_MAP, people: [{ id: "a".repeat(129), uid: 40002 }] }, /people\[0\]\.id/],
    [
      {
        ...OWNER_MAP,
        people: [
          { id: "acct_a", uid: 40012 },
          { id: "acct_a", uid: 40013 },
        ],
      },
      /names acct_a twice/,
    ],
    [
      {
        ...OWNER_MAP,
        people: [
          { id: "acct_a", uid: 40012 },
          { id: "acct_b", uid: 40012 },
        ],
      },
      /gives acct_a and acct_b the same uid 40012/,
    ],
    [
      {
        ...OWNER_MAP,
        people: Array.from({ length: 257 }, (_, index) => ({
          id: `acct_${index}`,
          uid: 40001 + index,
        })),
      },
      /257 people; the maximum is 256/,
    ],
  ])("refuses %#, on every parse", (ownerMap, message) => {
    expect(captureOwnerMapProblems(ownerMap).join("; ")).toMatch(message);
    expect(() => captureLaunch({ ownerMap })).toThrow(message);
  });

  it("refuses fields it does not know, and a map on any source but capture", () => {
    expect(() => captureLaunch({ ownerMap: { ...OWNER_MAP, worktree: 40012 } })).toThrow();
    expect(() =>
      captureLaunch({ ownerMap: { ...OWNER_MAP, people: [{ id: "a", uid: 40002, gid: 1 }] } }),
    ).toThrow();
    expect(() =>
      parseWorkspaceBlueprint({
        sources: {
          workspace: { kind: "git", url: "https://github.com/acme/app.git", ownerMap: OWNER_MAP },
        },
        harness: { id: "claude-code" },
      }),
    ).toThrow();
  });

  it("accepts 256 people", () => {
    const people = Array.from({ length: 256 }, (_, index) => ({
      id: `acct_${index}`,
      uid: 40001 + index,
    }));
    expect(captureOwnerMapProblems({ gid: 40000, worktreeUid: 40001, people })).toEqual([]);
  });
});

describe("the owner map's encoding", () => {
  it("is sealantd's JSON: worktree, people keyed by id in order", () => {
    expect(encodeCaptureOwnerMap(OWNER_MAP)).toBe(ENCODED);
  });

  it("always carries people, empty when the map names nobody", () => {
    expect(encodeCaptureOwnerMap({ gid: 40000, worktreeUid: 40001, people: [] })).toBe(
      '{"gid":40000,"worktree":40001,"people":{}}',
    );
  });

  it("keeps an id that is an object prototype's name as a key", () => {
    expect(
      JSON.parse(
        encodeCaptureOwnerMap({
          gid: 40000,
          worktreeUid: 40001,
          people: [{ id: "__proto__", uid: 40001 }],
        }),
      ),
    ).toEqual(JSON.parse('{"gid":40000,"worktree":40001,"people":{"__proto__":40001}}'));
  });
});

describe("the owner map in the boot env", () => {
  /** sealant#333 review P2-1: a name holding `=` that Docker would split into the map's name. */
  const SMUGGLED = {
    'SEALANT_CAPTURE_OWNER_MAP={"gid":40000,"worktree":1000,"people":{"x': '":1000}}',
  };

  it("is its own entry, never part of the channel facts", () => {
    const source = captureSourceOf(captureLaunch({ ownerMap: OWNER_MAP }));
    expect(ownerMapEntries(captureSourceEnv(source))).toEqual([]);
    expect(captureOwnerMapEnv(source)).toEqual([["SEALANT_CAPTURE_OWNER_MAP", ENCODED]]);
  });

  it("is empty for a capture source without one (no map to sealantd, overriding image ENV)", () => {
    expect(captureOwnerMapEnv(captureSourceOf(captureLaunch()))).toEqual([
      ["SEALANT_CAPTURE_OWNER_MAP", ""],
    ]);
    expect(captureOwnerMapEnv(cases.gitSource.blueprint.sources.workspace)).toEqual([]);
  });

  it("refuses a runtime.env name holding '=', the reviewer's exact payload, on every parse", () => {
    expect(() => captureLaunch({ env: SMUGGLED })).toThrow(/runtime\.env names must match/);
    expect(() => captureLaunch({ ownerMap: OWNER_MAP, env: SMUGGLED })).toThrow(
      /runtime\.env names must match/,
    );
    expect(() =>
      parseWorkspaceBlueprint({
        sources: { workspace: { url: "https://github.com/acme/app.git" } },
        harness: { id: "claude-code" },
        runtime: { env: SMUGGLED },
      }),
    ).toThrow(/runtime\.env names must match/);
    // The rejection never echoes the name.
    try {
      captureLaunch({ env: SMUGGLED });
    } catch (error) {
      expect(String(error)).not.toContain('"worktree":1000');
    }
  });

  it("is Docker's last -e, so nothing a launch carries overrides it", async () => {
    const legacy = { SEALANT_CAPTURE_OWNER_MAP: '{"gid":40000,"worktree":40001,"people":{"x":1}}' };
    const withMap = await dockerArgs(captureLaunch({ ownerMap: OWNER_MAP, env: legacy }));
    const envArgs = withMap.filter((arg, index) => withMap[index - 1] === "-e");
    expect(envArgs.filter((arg) => arg.startsWith("SEALANT_CAPTURE_OWNER_MAP"))).toEqual([
      `SEALANT_CAPTURE_OWNER_MAP=${ENCODED}`,
    ]);
    expect(envArgs.at(-1)).toBe(`SEALANT_CAPTURE_OWNER_MAP=${ENCODED}`);
    const without = await dockerArgs(captureLaunch({ env: legacy }));
    const withoutEnv = without.filter((arg, index) => without[index - 1] === "-e");
    expect(withoutEnv.filter((arg) => arg.startsWith("SEALANT_CAPTURE_OWNER_MAP"))).toEqual([
      "SEALANT_CAPTURE_OWNER_MAP=",
    ]);
    expect(withoutEnv.at(-1)).toBe("SEALANT_CAPTURE_OWNER_MAP=");
    const git = await dockerArgs(
      parseRuntimeAdapterLaunchInput({
        ...cases.gitSource,
        blueprint: {
          ...cases.gitSource.blueprint,
          runtime: { ...cases.gitSource.blueprint.runtime, env: legacy },
        },
      }),
    );
    expect(git.some((arg) => arg.startsWith("SEALANT_CAPTURE_OWNER_MAP"))).toBe(false);
  });

  it("is a Kubernetes Pod's last plain entry, and a legacy runtime.env never sets it", () => {
    const options = { secretEnvFile: true, dotfilesArchiveDir: undefined };
    const legacy = { SEALANT_CAPTURE_OWNER_MAP: "{}" };
    const withMap = plainEnvEntries(
      { ...captureLaunch({ ownerMap: OWNER_MAP, env: legacy }), binds: undefined },
      k8sConfig,
      options,
    );
    expect(ownerMapEntries(withMap)).toEqual([["SEALANT_CAPTURE_OWNER_MAP", ENCODED]]);
    expect(withMap.at(-1)).toEqual(["SEALANT_CAPTURE_OWNER_MAP", ENCODED]);
    const without = plainEnvEntries(
      { ...captureLaunch({ env: legacy }), binds: undefined },
      k8sConfig,
      options,
    );
    expect(ownerMapEntries(without)).toEqual([["SEALANT_CAPTURE_OWNER_MAP", ""]]);
  });

  it("is a MicroVM's boot env entry, and a legacy runtime.env never sets it", () => {
    const legacy = { SEALANT_CAPTURE_OWNER_MAP: "{}" };
    expect(
      microvmBootEnv(captureLaunch({ ownerMap: OWNER_MAP, env: legacy }), {
        secretEnvFile: true,
        dotfiles: false,
      })["SEALANT_CAPTURE_OWNER_MAP"],
    ).toBe(ENCODED);
    expect(
      microvmBootEnv(captureLaunch({ env: legacy }), { secretEnvFile: true, dotfiles: false })[
        "SEALANT_CAPTURE_OWNER_MAP"
      ],
    ).toBe("");
  });

  it("is refused on Cloudflare and on Kubernetes, where no person's sudo could work", () => {
    const blueprint = captureLaunch({ ownerMap: OWNER_MAP }).blueprint;
    expect(supportForCloudflare({ blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
    for (const id of ["k8s", "k3s"] as const) {
      expect(supportForKubernetes(id, k8sConfig, { blueprint })).toMatchObject({
        supported: false,
        reason: "unsupported-runtime-requirement",
        message: expect.stringContaining("allowPrivilegeEscalation: false"),
      });
    }
  });
});

describe("the launch's image check", () => {
  const supported = probe({
    schemaVersion: 1,
    supports: ["dotfiles.user", "exec.user", "restore.owner_map"],
  });

  it("reads restore.owner_map from what the image's sealantd reported", () => {
    expect(imageAppliesOwnerMap(supported)).toBe("yes");
    expect(imageAppliesOwnerMap(probe({ schemaVersion: 1, supports: ["exec.user"] }))).toBe("no");
    // A sealantd without the `capabilities` command.
    expect(imageAppliesOwnerMap(probe(null))).toBe("no");
    expect(imageAppliesOwnerMap(probe("unreadable"))).toBe("unknown");
    expect(imageAppliesOwnerMap(undefined)).toBe("unknown");
  });

  it("lets a map through only on an image that reports it, and never stops a launch without one", () => {
    const withMap = captureLaunch({ ownerMap: OWNER_MAP }).blueprint;
    expect(ownerMapLaunchRefusal(withMap, supported)).toBeUndefined();
    for (const [image, why] of [
      [probe({ schemaVersion: 1, supports: ["exec.user"] }), /does not report restore.owner_map/],
      [probe("unreadable"), /answered the probe with something Core cannot read/],
      [undefined, /records no probe/],
    ] as const) {
      const refusal = ownerMapLaunchRefusal(withMap, image);
      expect(refusal?.code).toBe("owner-map-unsupported");
      expect(refusal?.message).toMatch(why);
      expect(refusal?.message).toMatch(/Nothing ran/);
    }
    expect(ownerMapLaunchRefusal(captureLaunch().blueprint, undefined)).toBeUndefined();
    expect(ownerMapLaunchRefusal(cases.gitSource.blueprint, undefined)).toBeUndefined();
  });
});
