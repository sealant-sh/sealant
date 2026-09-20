import { parseAppEnv } from "@sealant/validators/env";
import { describe, expect, it } from "vitest";

const RETIRED = {
  SEALANT_MICROVM_IMAGE_ARN: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:base",
  SEALANT_MICROVM_IMAGE_VERSION: "3.0",
  SEALANT_MICROVM_DOCKER_IMAGE_ARN:
    "arn:aws:lambda:eu-central-1:123456789012:microvm-image:docker-capable",
  SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
};

describe("API MicroVM environment", () => {
  it("refuses each retired one-image setting by name, and says what replaces it", () => {
    for (const [key, value] of Object.entries(RETIRED)) {
      expect(() => parseAppEnv({ [key]: value })).toThrow(new RegExp(`${key} is retired`));
      expect(() => parseAppEnv({ [key]: value })).toThrow(/SEALANT_MICROVM_DOCKER_ENABLED/);
    }
  });

  it("serves workspace-scoped Docker on MicroVMs only where the operator enabled it", () => {
    expect(parseAppEnv({}).SEALANT_MICROVM_DOCKER_ENABLED).toBe(false);
    expect(parseAppEnv({ SEALANT_MICROVM_DOCKER_ENABLED: "true" })).toMatchObject({
      SEALANT_MICROVM_DOCKER_ENABLED: true,
    });
  });
});
