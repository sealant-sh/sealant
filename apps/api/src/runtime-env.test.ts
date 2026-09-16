import { parseAppEnv } from "@sealant/validators/env";
import { describe, expect, it } from "vitest";

const baseImageArn = "arn:aws:lambda:eu-central-1:123456789012:microvm-image:base";
const dockerImageArn = "arn:aws:lambda:eu-central-1:123456789012:microvm-image:docker-capable";

describe("API MicroVM Docker environment", () => {
  it("rejects a dangling Docker image pair without the base MicroVM image", () => {
    expect(() =>
      parseAppEnv({
        SEALANT_MICROVM_DOCKER_IMAGE_ARN: dockerImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
      }),
    ).toThrow(/SEALANT_MICROVM_IMAGE_ARN/);
  });

  it("rejects either partial Docker image coordinate", () => {
    expect(() =>
      parseAppEnv({
        SEALANT_MICROVM_IMAGE_ARN: baseImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_ARN: dockerImageArn,
      }),
    ).toThrow(/must be provided together/);
    expect(() =>
      parseAppEnv({
        SEALANT_MICROVM_IMAGE_ARN: baseImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
      }),
    ).toThrow(/must be provided together/);
  });

  it("requires a distinct Docker image and accepts a complete pinned pair", () => {
    expect(() =>
      parseAppEnv({
        SEALANT_MICROVM_IMAGE_ARN: baseImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_ARN: baseImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
      }),
    ).toThrow(/must differ/);
    expect(
      parseAppEnv({
        SEALANT_MICROVM_IMAGE_ARN: baseImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_ARN: dockerImageArn,
        SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
      }),
    ).toMatchObject({
      SEALANT_MICROVM_IMAGE_ARN: baseImageArn,
      SEALANT_MICROVM_DOCKER_IMAGE_ARN: dockerImageArn,
      SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
    });
  });
});
