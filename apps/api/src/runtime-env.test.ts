import { parseAppEnv } from "@sealant/validators/env";
import { describe, expect, it } from "vitest";

const RETIRED = {
  SEALANT_MICROVM_IMAGE_ARN: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:base",
  SEALANT_MICROVM_IMAGE_VERSION: "3.0",
  SEALANT_MICROVM_DOCKER_IMAGE_ARN:
    "arn:aws:lambda:eu-central-1:123456789012:microvm-image:docker-capable",
  SEALANT_MICROVM_DOCKER_IMAGE_VERSION: "7",
};

describe("API service request budget defaults", () => {
  it("gives each owner 6000 requests under the fixed key ceiling with a 20% reserve", () => {
    expect(parseAppEnv({})).toMatchObject({
      SEALANT_BUDGET_SERVICE_OWNER_REQUESTS_PER_MINUTE: 6000,
      SEALANT_BUDGET_SERVICE_UNOWNED_REQUESTS_PER_MINUTE: 6000,
      SEALANT_BUDGET_PRINCIPAL_REQUESTS_PER_MINUTE: 12000,
      SEALANT_BUDGET_REQUEST_INTERACTIVE_RESERVE_PERCENT: 20,
    });
  });
});

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
