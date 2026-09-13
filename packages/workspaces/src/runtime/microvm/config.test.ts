import { describe, expect, it } from "vitest";

import { microvmRuntimeConfigFromEnv, MicrovmRuntimeConfigError } from "./config.js";

const imageArn = "arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-workspace";
const roleArn = "arn:aws:iam::123456789012:role/sealant-microvm-exec";

const full = {
  SEALANT_MICROVM_REGION: "eu-central-1",
  SEALANT_MICROVM_IMAGE_ARN: imageArn,
  SEALANT_MICROVM_EXEC_ROLE_ARN: roleArn,
  SEALANT_CONTROL_BEARER_TOKEN: "control-token",
};

describe("microvmRuntimeConfigFromEnv", () => {
  it("is undefined when the image ARN is unset (a non-MicroVM deployment)", () => {
    expect(microvmRuntimeConfigFromEnv({})).toBeUndefined();
    expect(microvmRuntimeConfigFromEnv({ SEALANT_MICROVM_REGION: "eu-central-1" })).toBeUndefined();
  });

  it("applies the POC defaults: the lifetime cap, the managed ALL_INGRESS connector, port 8080", () => {
    expect(microvmRuntimeConfigFromEnv(full)).toEqual({
      region: "eu-central-1",
      imageArn,
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
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_IMAGE_ARN: "sealant-workspace" }),
    ).toThrow(/imageArn/);
    expect(() =>
      microvmRuntimeConfigFromEnv({ ...full, SEALANT_MICROVM_EGRESS_CONNECTOR: "vpc-egress" }),
    ).toThrow(/egressNetworkConnector/);
  });

  it("threads every optional knob through", () => {
    expect(
      microvmRuntimeConfigFromEnv({
        ...full,
        SEALANT_MICROVM_IMAGE_VERSION: "3.0",
        SEALANT_MICROVM_EGRESS_CONNECTOR:
          "arn:aws:lambda:eu-central-1:123456789012:network-connector:vpc-egress",
        SEALANT_MICROVM_MAX_DURATION_SECONDS: 7200,
        SEALANT_MICROVM_LOG_GROUP: "/aws/lambda/microvms/sealant",
        SEALANT_MICROVM_AGENT_PORT: 9000,
        SEALANT_MICROVM_WS_AUTH: "subprotocol",
        SEALANT_MICROVM_FLUSH_TIMEOUT_MS: 20_000,
      }),
    ).toMatchObject({
      imageVersion: "3.0",
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
