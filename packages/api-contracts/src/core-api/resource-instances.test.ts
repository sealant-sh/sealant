import { describe, expect, it } from "vitest";

import {
  decodeResourceInstanceSpec,
  FORBIDDEN_RESOURCE_INSTANCE_SPEC_FIELDS,
} from "./resource-instances.js";

const postgres = {
  alias: "db",
  worktreeKey: null,
  image: `postgres:18@sha256:${"a".repeat(64)}`,
  command: null,
  env: { POSTGRES_HOST_AUTH_METHOD: "trust" },
  volumes: [{ name: "data", mountPath: "/var/lib/postgresql" }],
  limits: { cpuMillicores: 1000, memoryBytes: 1024 * 1024 * 1024 },
  ready: { kind: "exec", argv: ["pg_isready", "-U", "postgres"], user: "postgres" },
  idleStopAfterSeconds: 1800,
};

const refusals = (input: unknown) => {
  const decoded = decodeResourceInstanceSpec(input);
  return decoded.kind === "refused" ? decoded.refusals : [];
};

describe("decodeResourceInstanceSpec", () => {
  it("decodes a Postgres spec", () => {
    expect(decodeResourceInstanceSpec(postgres)).toEqual({ kind: "spec", spec: postgres });
  });

  it("refuses each forbidden field by name, with its sentence", () => {
    for (const [field, reason] of Object.entries(FORBIDDEN_RESOURCE_INSTANCE_SPEC_FIELDS)) {
      expect(refusals({ ...postgres, [field]: true })).toEqual([{ field, reason }]);
    }
    expect(
      refusals({ ...postgres, privileged: true, devices: ["/dev/kvm"], pid: "host" }).map(
        (refusal) => refusal.field,
      ),
    ).toEqual(["privileged", "devices", "pid"]);
    expect(refusals({ ...postgres, binds: ["/var/run/docker.sock:/var/run/docker.sock"] })).toEqual(
      [
        {
          field: "binds",
          reason: "an instance mounts named volumes only, never a host path or the Docker socket",
        },
      ],
    );
  });

  it("refuses a field the contract does not declare, and quotes neither its name nor its value", () => {
    const [refusal] = refusals({ ...postgres, s3cr3tName: "s3cr3tValue" });
    expect(refusal?.reason).toContain("is not allowed");
    expect(refusal?.reason).not.toContain("s3cr3t");
  });

  it("refuses a host path smuggled into a volume", () => {
    const [refusal] = refusals({
      ...postgres,
      volumes: [{ name: "data", mountPath: "/var/lib/postgresql", source: "/etc" }],
    });
    expect(refusal?.reason).toContain("volumes[0]");
  });

  it("refuses an image that is not pinned by digest, and mount paths that are not plain", () => {
    expect(refusals({ ...postgres, image: "postgres:18" })).toHaveLength(1);
    for (const mountPath of ["/", "relative", "/a/../b", "/a/", "/proc/x", "/dev"]) {
      expect(
        refusals({ ...postgres, volumes: [{ name: "data", mountPath }] }),
        mountPath,
      ).toHaveLength(1);
    }
    expect(
      refusals({
        ...postgres,
        volumes: [
          { name: "data", mountPath: "/a" },
          { name: "data", mountPath: "/b" },
        ],
      }),
    ).toHaveLength(1);
  });

  it("refuses a value that is not an object", () => {
    expect(refusals("privileged")).toHaveLength(1);
    expect(refusals({ ...postgres, constructor: 1 })[0]?.field).toBe("spec");
  });
});
