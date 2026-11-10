import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWorkerEnv, parseAppEnv } from "@sealant/validators/env";
import { describe, expect, it } from "vitest";

describe("parseWorkerEnv", () => {
  it.each([
    { SEALANT_BOAT_AUTOMATIC_PARKING: "false", SEALANT_BOAT_PARKING_DELAY_SECONDS: "3600" },
    { SEALANT_BOAT_AUTOMATIC_PARKING: "yes", SEALANT_BOAT_PARKING_DELAY_SECONDS: "1" },
  ])("starts with the retired Boat parking settings %o still set, and ignores them", (retired) => {
    const env = parseWorkerEnv(retired);
    expect(env).not.toHaveProperty("SEALANT_BOAT_AUTOMATIC_PARKING");
    expect(env).not.toHaveProperty("SEALANT_BOAT_PARKING_DELAY_SECONDS");
  });

  it.each(["usr_proof", "usr_proof,usr_second", "*", "usr_ proof,"])(
    "starts with the retired Boat owner list %s still set, and ignores it",
    (owners) => {
      for (const env of [
        parseWorkerEnv({ SEALANT_BOAT_ADMISSION_OWNER_IDS: owners }),
        parseAppEnv({ SEALANT_BOAT_ADMISSION_OWNER_IDS: owners }),
      ])
        expect(env).not.toHaveProperty("SEALANT_BOAT_ADMISSION_OWNER_IDS");
    },
  );

  it.each(["10.0.0.41", "49.12.133.97", "not-an-ip", ""])(
    "starts with the retired Boat gateway endpoint %j still set, and ignores it",
    (endpoint) => {
      // Alone, and beside a complete configuration: it is never read, so no value of it is refused.
      const alone = parseWorkerEnv({ SEALANT_BOAT_GATEWAY_ENDPOINT: endpoint });
      expect(alone).not.toHaveProperty("SEALANT_BOAT_GATEWAY_ENDPOINT");
      expect(alone.SEALANT_BOAT_GATEWAY_RELAY_HOST).toBeUndefined();
      const configured = parseWorkerEnv({
        SEALANT_BOAT_API_KEY: "test-key-for-local-only",
        SEALANT_BOAT_DEPLOYMENT_ID: "test",
        SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
        SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
        SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1",
        SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
        SEALANT_BOAT_GATEWAY_ENDPOINT: endpoint,
      });
      expect(configured).not.toHaveProperty("SEALANT_BOAT_GATEWAY_ENDPOINT");
      expect(configured.SEALANT_BOAT_GATEWAY_RELAY_HOST).toBe("127.0.0.1");
    },
  );

  it("requires the complete reconciliation contract without changing runtime selection", () => {
    expect(parseWorkerEnv({}).SEALANT_BOAT_API_KEY).toBeUndefined();
    for (const values of [
      { SEALANT_BOAT_API_KEY: "test-key-for-local-only" },
      { SEALANT_BOAT_DEPLOYMENT_ID: "test" },
    ]) {
      expect(() => parseWorkerEnv(values)).toThrow("Boat requires its key");
    }
    expect(
      parseWorkerEnv({
        SEALANT_BOAT_API_KEY: "test-key-for-local-only",
        SEALANT_BOAT_DEPLOYMENT_ID: "test",
        SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
    ).toMatchObject({ DEFAULT_RUNTIME_ADAPTER: "docker", SEALANT_BOAT_DEPLOYMENT_ID: "test" });
  });
  it("requires an immutable and complete optional Docker gateway configuration", () => {
    const base = {
      SEALANT_BOAT_API_KEY: "test-key-for-local-only",
      SEALANT_BOAT_DEPLOYMENT_ID: "test",
      SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    const gateway = {
      SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_GATEWAY_RELAY_HOST: "172.17.0.1",
      SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
    };
    expect(parseWorkerEnv({ ...base, ...gateway })).toMatchObject(gateway);
    // All of the gateway's settings, or none: any one alone refuses the worker's start.
    for (const [key, value] of Object.entries(gateway))
      expect(() => parseWorkerEnv({ ...base, [key]: value }), key).toThrow("complete gateway");
    for (const key of ["SEALANT_BOAT_GATEWAY_HOST_ID", "SEALANT_BOAT_GATEWAY_IMAGE"] as const) {
      const { [key]: _missing, ...partial } = gateway;
      expect(() => parseWorkerEnv({ ...base, ...partial }), key).toThrow("complete gateway");
    }
    expect(() =>
      parseWorkerEnv({ ...base, ...gateway, SEALANT_BOAT_GATEWAY_IMAGE: "gateway:latest" }),
    ).toThrow();
    expect(() => parseWorkerEnv({ ...base, ...gateway, DOCKER_RUNTIME_ENABLED: "false" })).toThrow(
      "Docker resource host",
    );
    // Every tunnel is carried over HTTPS to the relay host, so a gateway without one cannot be
    // reached: the start is refused, and the refusal names the variable.
    const { SEALANT_BOAT_GATEWAY_RELAY_HOST: _relay, ...carriedOnly } = gateway;
    expect(() => parseWorkerEnv({ ...base, ...carriedOnly })).toThrow(
      "Boat resource reconciliation requires SEALANT_BOAT_GATEWAY_RELAY_HOST",
    );
    // The address VMs once dialled over UDP does not stand in for it.
    expect(() =>
      parseWorkerEnv({ ...base, ...carriedOnly, SEALANT_BOAT_GATEWAY_ENDPOINT: "10.0.0.41" }),
    ).toThrow("Boat resource reconciliation requires SEALANT_BOAT_GATEWAY_RELAY_HOST");
    expect(() =>
      parseWorkerEnv({ ...base, ...carriedOnly, SEALANT_BOAT_GATEWAY_RELAY_HOST: "not-an-ip" }),
    ).toThrow();
    // The gateway port is published on the relay host: every interface is never one address.
    expect(() =>
      parseWorkerEnv({ ...base, ...carriedOnly, SEALANT_BOAT_GATEWAY_RELAY_HOST: "0.0.0.0" }),
    ).toThrow("Invalid environment variables");
  });
  it("requires one credential source with deployment and cipher, including file-only gateway configuration", () => {
    const base = {
      SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
      SEALANT_BOAT_DEPLOYMENT_ID: "proof",
      SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    expect(parseWorkerEnv(base).SEALANT_BOAT_API_KEY_FILE).toBe(base.SEALANT_BOAT_API_KEY_FILE);
    expect(parseWorkerEnv(base).SEALANT_BOAT_API_KEY).toBeUndefined();
    expect(() =>
      parseWorkerEnv({ ...base, SEALANT_BOAT_API_KEY: "test-key-for-local-only" }),
    ).toThrow("exactly one");
    for (const key of Object.keys(base)) {
      expect(() =>
        parseWorkerEnv(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))),
      ).toThrow(/Boat requires its key \(SEALANT_BOAT_API_KEY or SEALANT_BOAT_API_KEY_FILE\)/);
    }
    expect(() => parseWorkerEnv({ ...base, SEALANT_BOAT_API_KEY_FILE: "relative" })).toThrow();
    expect(
      parseWorkerEnv({
        ...base,
        SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
        SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1",
        SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
      }).DEFAULT_RUNTIME_ADAPTER,
    ).toBe("docker");
  });
  it("serves Boat workspaces where the builder is configured, and then needs the complete Boat configuration", () => {
    const base = {
      SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
      SEALANT_BOAT_DEPLOYMENT_ID: "proof",
      SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1",
      SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
      SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_STATE_DIRECTORY: "/var/lib/sealant/boat",
      SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    expect(parseWorkerEnv(base).SEALANT_BOAT_BUILDER_OWNER).toBe(base.SEALANT_BOAT_BUILDER_OWNER);
    // A gateway without its relay host is half a gateway, and the retired endpoint is no
    // substitute: the refusal names the variable that is missing.
    const { SEALANT_BOAT_GATEWAY_RELAY_HOST: _relayHost, ...unrelayed } = base;
    for (const env of [unrelayed, { ...unrelayed, SEALANT_BOAT_GATEWAY_ENDPOINT: "49.12.133.97" }])
      expect(() => parseWorkerEnv(env)).toThrow(
        "Boat resource reconciliation requires SEALANT_BOAT_GATEWAY_RELAY_HOST",
      );
    for (const key of Object.keys(base))
      expect(
        () =>
          parseWorkerEnv(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))),
        key,
      ).toThrow();
    // With its gateway, Boat still runs beside the Docker resource host.
    expect(() => parseWorkerEnv({ ...base, DOCKER_RUNTIME_ENABLED: "false" })).toThrow(
      "Docker resource host",
    );
  });
  it("serves Boat workspaces from the provider and builder settings alone, with no resource gateway and no Docker host", () => {
    const base = {
      SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
      SEALANT_BOAT_DEPLOYMENT_ID: "proof",
      SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_STATE_DIRECTORY: "/var/lib/sealant/boat",
      SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    const env = parseWorkerEnv(base);
    expect(env).toMatchObject(base);
    expect(env.SEALANT_BOAT_GATEWAY_HOST_ID).toBeUndefined();
    expect(env.SEALANT_BOAT_GATEWAY_RELAY_HOST).toBeUndefined();
    expect(env.SEALANT_BOAT_GATEWAY_IMAGE).toBeUndefined();
    // The Docker host and the default runtime are the gateway's requirements, not Boat's: a
    // worker with no Docker at all, and any other default runtime, starts.
    for (const runtime of [
      { DOCKER_RUNTIME_ENABLED: "false" },
      { DOCKER_RUNTIME_ENABLED: "false", DEFAULT_RUNTIME_ADAPTER: "boat" },
      { DEFAULT_RUNTIME_ADAPTER: "boat" },
    ])
      expect(parseWorkerEnv({ ...base, ...runtime })).toMatchObject({ ...base });
    // Every provider and builder setting is still required.
    for (const key of Object.keys(base))
      expect(
        () =>
          parseWorkerEnv(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))),
        key,
      ).toThrow();
  });
  it("refuses a half-set resource gateway at start, naming the variables that are missing", () => {
    const base = {
      SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
      SEALANT_BOAT_DEPLOYMENT_ID: "proof",
      SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_STATE_DIRECTORY: "/var/lib/sealant/boat",
      SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    const gateway = {
      SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1",
      SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
    };
    const names = Object.keys(gateway);
    // One or two of the three: the refusal names exactly what is not set, and nothing that is.
    for (const set of [
      ...names.map((name) => [name]),
      ...names.map((name) => names.filter((other) => other !== name)),
    ]) {
      const missing = names.filter((name) => !set.includes(name));
      const partial = Object.fromEntries(
        Object.entries(gateway).filter(([name]) => set.includes(name)),
      );
      let message = "";
      try {
        parseWorkerEnv({ ...base, ...partial });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, set.join("+")).toContain(
        `and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set`,
      );
      for (const name of missing)
        expect(message, set.join("+")).toContain(`Boat resource reconciliation requires ${name}`);
      for (const name of set)
        expect(message, set.join("+")).not.toContain(
          `Boat resource reconciliation requires ${name}`,
        );
      expect(message).toContain("or none of them to run Boat without a resource gateway");
    }
    // All three, or none, start.
    expect(parseWorkerEnv({ ...base, ...gateway })).toMatchObject(gateway);
    expect(parseWorkerEnv(base).SEALANT_BOAT_GATEWAY_IMAGE).toBeUndefined();
  });

  it("keeps legacy bind mode when Compose interpolates an unset mapping as empty", () => {
    const env = parseWorkerEnv({ SEALANT_DOCKER_VOLUME_MAPPINGS: "" });

    expect(env.SEALANT_DOCKER_VOLUME_MAPPINGS).toBeUndefined();
  });

  it("preserves strict Docker volume mappings for semantic parsing at worker startup", () => {
    const mappings = JSON.stringify([
      { logicalRoot: "/var/lib/mend/store", volumeName: "mend-store" },
      { logicalRoot: "/run/sealant/sockets", volumeName: "sealant-sockets" },
    ]);

    const env = parseWorkerEnv({ SEALANT_DOCKER_VOLUME_MAPPINGS: mappings });

    expect(env.SEALANT_DOCKER_VOLUME_MAPPINGS).toBe(mappings);
  });

  it("treats an empty workspace network as unset and keeps a named one", () => {
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_WORKSPACE_NETWORK: "" }).SEALANT_DOCKER_WORKSPACE_NETWORK,
    ).toBeUndefined();
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_WORKSPACE_NETWORK: "mend_default" })
        .SEALANT_DOCKER_WORKSPACE_NETWORK,
    ).toBe("mend_default");
  });

  it("keeps the registry mirrors and their container for the adapters to parse", () => {
    const env = parseWorkerEnv({
      SEALANT_DOCKER_REGISTRY_MIRRORS: "http://mend-docker-mirror:5000",
      SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER: "mend-docker-mirror",
    });
    expect(env.SEALANT_DOCKER_REGISTRY_MIRRORS).toBe("http://mend-docker-mirror:5000");
    expect(env.SEALANT_DOCKER_REGISTRY_MIRROR_CONTAINER).toBe("mend-docker-mirror");
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_REGISTRY_MIRRORS: "" }).SEALANT_DOCKER_REGISTRY_MIRRORS,
    ).toBeUndefined();
  });

  it("keeps the metadata guard image, and leaves an empty one to the adapter's default", () => {
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_NETWORK_GUARD_IMAGE: "mirror.local/busybox:1.37" })
        .SEALANT_DOCKER_NETWORK_GUARD_IMAGE,
    ).toBe("mirror.local/busybox:1.37");
    expect(
      parseWorkerEnv({ SEALANT_DOCKER_NETWORK_GUARD_IMAGE: "" }).SEALANT_DOCKER_NETWORK_GUARD_IMAGE,
    ).toBeUndefined();
  });

  it("refuses a retired one-image MicroVM setting instead of ignoring it", () => {
    expect(() =>
      parseWorkerEnv({
        SEALANT_MICROVM_IMAGE_ARN: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:base",
      }),
    ).toThrow(/SEALANT_MICROVM_IMAGE_ARN is retired/);
  });

  it("needs the build role where MicroVM is the default runtime", () => {
    expect(() => parseWorkerEnv({ DEFAULT_RUNTIME_ADAPTER: "microvm" })).toThrow(
      /SEALANT_MICROVM_BUILD_ROLE_ARN/,
    );
    expect(
      parseWorkerEnv({
        DEFAULT_RUNTIME_ADAPTER: "microvm",
        SEALANT_MICROVM_BUILD_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-build",
        SEALANT_MICROVM_MEMORY_MIB: "8192",
      }),
    ).toMatchObject({ SEALANT_MICROVM_MEMORY_MIB: 8192 });
  });

  it("loads the GitHub App private key from GITHUB_APP_PRIVATE_KEY_PATH", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "sealant-worker-github-key-"));
    const privateKeyPath = join(tempDirectory, "github-app.private-key.pem");
    const privateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "test-private-key",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");

    try {
      writeFileSync(privateKeyPath, privateKey, "utf8");

      const env = parseWorkerEnv({
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
      });

      expect(env.GITHUB_APP_PRIVATE_KEY_PATH).toBe(privateKeyPath);
      expect(env.GITHUB_APP_PRIVATE_KEY).toBe(privateKey);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
