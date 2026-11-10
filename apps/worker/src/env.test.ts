import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boatAdmissionEnvSchema, parseWorkerEnv, appEnvSchema } from "@sealant/validators/env";
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

  it("requires the complete reconciliation contract without changing runtime selection", () => {
    expect(parseWorkerEnv({}).SEALANT_BOAT_API_KEY).toBeUndefined();
    for (const values of [
      { SEALANT_BOAT_API_KEY: "test-key-for-local-only" },
      { SEALANT_BOAT_DEPLOYMENT_ID: "test" },
    ]) {
      expect(() => parseWorkerEnv(values)).toThrow("Boat reconciliation requires");
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
      SEALANT_BOAT_GATEWAY_ENDPOINT: "10.0.0.41",
      SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
    };
    expect(parseWorkerEnv({ ...base, ...gateway })).toMatchObject(gateway);
    for (const [key, value] of Object.entries(gateway))
      expect(() => parseWorkerEnv({ ...base, [key]: value })).toThrow("complete gateway");
    expect(() =>
      parseWorkerEnv({ ...base, ...gateway, SEALANT_BOAT_GATEWAY_IMAGE: "gateway:latest" }),
    ).toThrow();
    expect(() => parseWorkerEnv({ ...base, ...gateway, DOCKER_RUNTIME_ENABLED: "false" })).toThrow(
      "Docker resource host",
    );
    // Carried over HTTPS: a relay host stands in for the public endpoint; one of the two is needed.
    const { SEALANT_BOAT_GATEWAY_ENDPOINT: _endpoint, ...carriedOnly } = gateway;
    expect(
      parseWorkerEnv({ ...base, ...carriedOnly, SEALANT_BOAT_GATEWAY_RELAY_HOST: "172.17.0.1" }),
    ).toMatchObject({ SEALANT_BOAT_GATEWAY_RELAY_HOST: "172.17.0.1" });
    expect(() => parseWorkerEnv({ ...base, ...carriedOnly })).toThrow(
      "SEALANT_BOAT_GATEWAY_RELAY_HOST",
    );
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
      ).toThrow("Boat reconciliation requires");
    }
    expect(() => parseWorkerEnv({ ...base, SEALANT_BOAT_API_KEY_FILE: "relative" })).toThrow();
    expect(
      parseWorkerEnv({
        ...base,
        SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
        SEALANT_BOAT_GATEWAY_ENDPOINT: "49.12.133.97",
        SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
      }).DEFAULT_RUNTIME_ADAPTER,
    ).toBe("docker");
  });
  it("keeps admission off by default and preserves exact asserted owners through both parses", () => {
    expect(parseWorkerEnv({}).SEALANT_BOAT_ADMISSION_OWNER_IDS).toEqual([]);
    const base = {
      SEALANT_BOAT_ADMISSION_OWNER_IDS: "usr_proof,usr_second",
      SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
      SEALANT_BOAT_DEPLOYMENT_ID: "proof",
      SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_GATEWAY_ENDPOINT: "49.12.133.97",
      SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
      SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
      SEALANT_BOAT_STATE_DIRECTORY: "/var/lib/sealant/boat",
      SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    expect(parseWorkerEnv(base).SEALANT_BOAT_ADMISSION_OWNER_IDS).toEqual([
      "usr_proof",
      "usr_second",
    ]);
    // Admission with every tunnel carried: no public endpoint.
    const { SEALANT_BOAT_GATEWAY_ENDPOINT: _publicEndpoint, ...carried } = base;
    expect(
      parseWorkerEnv({ ...carried, SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1" })
        .SEALANT_BOAT_ADMISSION_OWNER_IDS,
    ).toEqual(["usr_proof", "usr_second"]);
    const parsed = boatAdmissionEnvSchema.parse(base);
    expect(boatAdmissionEnvSchema.parse(parsed)).toEqual(parsed);
    for (const key of Object.keys(base).filter(
      (name) => name !== "SEALANT_BOAT_ADMISSION_OWNER_IDS",
    ))
      expect(() =>
        parseWorkerEnv(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))),
      ).toThrow();
    for (const value of [
      "usr_proof,usr_proof",
      "*",
      "usr_proof,",
      "usr_ proof",
      "usr_proof\nother",
    ])
      expect(
        boatAdmissionEnvSchema.safeParse({ SEALANT_BOAT_ADMISSION_OWNER_IDS: value }).success,
      ).toBe(false);
    expect(appEnvSchema.safeParse({ SEALANT_BOAT_ADMISSION_OWNER_IDS: "usr_proof" }).success).toBe(
      false,
    );
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
