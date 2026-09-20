import { describe, expect, it } from "vitest";

import { microvmRuntimeConfigFromEnv, MicrovmRuntimeConfigError } from "./config.js";

const roleArn = "arn:aws:iam::123456789012:role/sealant-microvm-exec";
const buildRoleArn = "arn:aws:iam::123456789012:role/sealant-microvm-build";

const full = {
  SEALANT_MICROVM_REGION: "eu-central-1",
  SEALANT_MICROVM_BUILD_ROLE_ARN: buildRoleArn,
  SEALANT_MICROVM_ARTIFACT_BUCKET: "sealant-artifacts",
  SEALANT_MICROVM_EXEC_ROLE_ARN: roleArn,
  SEALANT_CONTROL_BEARER_TOKEN: "control-token",
};

describe("microvmRuntimeConfigFromEnv", () => {
  it("is undefined until the build role is configured", () => {
    expect(microvmRuntimeConfigFromEnv({})).toBeUndefined();
    expect(microvmRuntimeConfigFromEnv({ SEALANT_MICROVM_REGION: "eu-central-1" })).toBeUndefined();
    expect(
      microvmRuntimeConfigFromEnv({ SEALANT_MICROVM_ARTIFACT_BUCKET: "sealant-artifacts" }),
    ).toBeUndefined();
  });

  it("refuses the retired one-image settings, configured or not, and says what replaces them", () => {
    for (const retired of [
      { SEALANT_MICROVM_IMAGE_ARN: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:one" },
      { SEALANT_MICROVM_IMAGE_VERSION: "3.0" },
      {
        SEALANT_MICROVM_DOCKER_IMAGE_ARN:
          "arn:aws:lambda:eu-central-1:123456789012:microvm-image:docker",
      },
      { SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7" },
    ]) {
      const [key] = Object.keys(retired);
      for (const env of [retired, { ...full, ...retired }]) {
        expect(() => microvmRuntimeConfigFromEnv(env)).toThrow(MicrovmRuntimeConfigError);
        expect(() => microvmRuntimeConfigFromEnv(env)).toThrow(
          new RegExp(`${String(key)} is retired`),
        );
        expect(() => microvmRuntimeConfigFromEnv(env)).toThrow(/SEALANT_MICROVM_BUILD_ROLE_ARN/);
      }
    }
  });

  it("applies the defaults: the managed base, a 4 GiB image, no Docker, the lifetime cap, port 8080", () => {
    expect(microvmRuntimeConfigFromEnv(full)).toEqual({
      region: "eu-central-1",
      build: {
        roleArn: buildRoleArn,
        artifactBucket: "sealant-artifacts",
        artifactPrefix: "sealant/workspace-images",
        baseImageArn: "arn:aws:lambda:eu-central-1:aws:microvm-image:al2023-1",
        imageNamePrefix: "sealant-ws",
        memoryMiB: 4096,
        maxImages: 50,
        timeoutMs: 1_800_000,
        pollIntervalMs: 10_000,
      },
      dockerService: false,
      executionRoleArn: roleArn,
      ingressNetworkConnector:
        "arn:aws:lambda:eu-central-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
      maxDurationSeconds: 28_800,
      agentPort: 8080,
      readinessTimeoutMs: 300_000,
      terminateTimeoutMs: 90_000,
      exitPollIntervalMs: 15_000,
      endpointTokenTtlMinutes: 60,
      endpointTokenRefreshMarginMs: 300_000,
      flushTimeoutMs: 50_000,
      endpointWebSocketAuth: "header",
      controlBearerToken: "control-token",
    });
  });

  it("names the missing half of the contract", () => {
    const { SEALANT_MICROVM_REGION: _region, ...noRegion } = full;
    expect(() => microvmRuntimeConfigFromEnv(noRegion)).toThrow(/SEALANT_MICROVM_REGION/);
    const { SEALANT_MICROVM_ARTIFACT_BUCKET: _bucket, ...noBucket } = full;
    expect(() => microvmRuntimeConfigFromEnv(noBucket)).toThrow(/SEALANT_MICROVM_ARTIFACT_BUCKET/);
    const { SEALANT_MICROVM_EXEC_ROLE_ARN: _role, ...noRole } = full;
    expect(() => microvmRuntimeConfigFromEnv(noRole)).toThrow(/SEALANT_MICROVM_EXEC_ROLE_ARN/);
    const { SEALANT_CONTROL_BEARER_TOKEN: _token, ...noToken } = full;
    expect(() => microvmRuntimeConfigFromEnv(noToken)).toThrow(MicrovmRuntimeConfigError);
    expect(() => microvmRuntimeConfigFromEnv(noToken)).toThrow(/SEALANT_CONTROL_BEARER_TOKEN/);
  });

  it("rejects values outside the platform's constraints, naming the field", () => {
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_MAX_DURATION_SECONDS: 28_801 }),
    ).toThrow(/maxDurationSeconds/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_TOKEN_TTL_MINUTES: 61 }),
    ).toThrow(/endpointTokenTtlMinutes/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_FLUSH_TIMEOUT_MS: 60_000 }),
    ).toThrow(/flushTimeoutMs/);
    expect(() =>
      microvmRuntimeConfigFromEnv({
        ...full,
        SEALANT_MICROVM_TOKEN_TTL_MINUTES: 5,
        SEALANT_MICROVM_TOKEN_REFRESH_MARGIN_MS: 300_000,
      }),
    ).toThrow(/refresh margin/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_BUILD_ROLE_ARN: "build-role" }),
    ).toThrow(/build\.roleArn/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_ARTIFACT_PREFIX: "/builds/" }),
    ).toThrow(/build\.artifactPrefix/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_BASE_IMAGE_ARN: "al2023-1" }),
    ).toThrow(/build\.baseImageArn/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_IMAGE_NAME_PREFIX: "ws.*" }),
    ).toThrow(/build\.imageNamePrefix/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_EGRESS_CONNECTOR: "vpc-egress" }),
    ).toThrow(/egressNetworkConnector/);
  });

  it("threads every optional knob through", () => {
    expect(
      microvmRuntimeConfigFromEnv({
        ...full,
        SEALANT_MICROVM_ARTIFACT_PREFIX: "builds/org-a",
        SEALANT_MICROVM_BASE_IMAGE_ARN:
          "arn:aws:lambda:eu-central-1:123456789012:microvm-image:own-base",
        SEALANT_MICROVM_IMAGE_NAME_PREFIX: "alpha-ws",
        SEALANT_MICROVM_MEMORY_MIB: 8192,
        SEALANT_MICROVM_MAX_IMAGES: 5,
        SEALANT_MICROVM_BUILD_LOG_GROUP: "/aws/lambda/microvms/build",
        SEALANT_MICROVM_BUILD_TIMEOUT_MS: 600_000,
        SEALANT_MICROVM_BUILD_POLL_INTERVAL_MS: 5_000,
        SEALANT_MICROVM_DOCKER_ENABLED: true,
        SEALANT_MICROVM_EGRESS_CONNECTOR:
          "arn:aws:lambda:eu-central-1:123456789012:network-connector:vpc-egress",
        SEALANT_MICROVM_MAX_DURATION_SECONDS: 7200,
        SEALANT_MICROVM_LOG_GROUP: "/aws/lambda/microvms/sealant",
        SEALANT_MICROVM_AGENT_PORT: 9000,
        SEALANT_MICROVM_WS_AUTH: "subprotocol",
        SEALANT_MICROVM_FLUSH_TIMEOUT_MS: 20_000,
      }),
    ).toMatchObject({
      build: {
        roleArn: buildRoleArn,
        artifactBucket: "sealant-artifacts",
        artifactPrefix: "builds/org-a",
        baseImageArn: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:own-base",
        imageNamePrefix: "alpha-ws",
        memoryMiB: 8192,
        maxImages: 5,
        logGroup: "/aws/lambda/microvms/build",
        timeoutMs: 600_000,
        pollIntervalMs: 5_000,
      },
      dockerService: true,
      egressNetworkConnector:
        "arn:aws:lambda:eu-central-1:123456789012:network-connector:vpc-egress",
      maxDurationSeconds: 7200,
      logGroup: "/aws/lambda/microvms/sealant",
      agentPort: 9000,
      endpointWebSocketAuth: "subprotocol",
      flushTimeoutMs: 20_000,
    });
  });
});
