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

describe("API Boat environment", () => {
  const cipher = Buffer.alloc(32, 7).toString("base64");

  it("starts with no Boat settings, and holds none", () => {
    const env = parseAppEnv({});
    expect(env.SEALANT_BOAT_API_KEY).toBeUndefined();
    expect(env.SEALANT_BOAT_API_KEY_FILE).toBeUndefined();
    expect(env.SEALANT_BOAT_DEPLOYMENT_ID).toBeUndefined();
  });

  it("takes the Boat key, or its file, with the credential cipher and an optional deployment", () => {
    expect(
      parseAppEnv({
        SEALANT_BOAT_API_KEY: "test-key-for-local-only",
        SEALANT_BOAT_DEPLOYMENT_ID: "test",
        SEALANT_CREDENTIALS_KEY: cipher,
      }),
    ).toMatchObject({ SEALANT_BOAT_DEPLOYMENT_ID: "test" });
    const file = {
      SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
      SEALANT_BOAT_DEPLOYMENT_ID: "test",
      SEALANT_CREDENTIALS_KEY: cipher,
    };
    expect(parseAppEnv(file).SEALANT_BOAT_API_KEY_FILE).toBe(file.SEALANT_BOAT_API_KEY_FILE);
    expect(() => parseAppEnv({ ...file, SEALANT_BOAT_API_KEY: "test-key-for-local-only" })).toThrow(
      "exactly one",
    );
    expect(() => parseAppEnv({ ...file, SEALANT_BOAT_API_KEY_FILE: "relative" })).toThrow();
    // The deployment is optional (the install keeps a name of its own); the cipher is not.
    expect(
      parseAppEnv({
        SEALANT_BOAT_API_KEY_FILE: file.SEALANT_BOAT_API_KEY_FILE,
        SEALANT_CREDENTIALS_KEY: cipher,
      }).SEALANT_BOAT_DEPLOYMENT_ID,
    ).toBeUndefined();
    expect(() =>
      parseAppEnv({ SEALANT_BOAT_API_KEY_FILE: file.SEALANT_BOAT_API_KEY_FILE }),
    ).toThrow("SEALANT_CREDENTIALS_KEY");
  });

  it("starts with no Boat key, for an install that runs Boat from stored keys alone", () => {
    expect(parseAppEnv({ SEALANT_CREDENTIALS_KEY: cipher }).SEALANT_BOAT_API_KEY).toBeUndefined();
    // A deployment name alone is harmless: it names what the install's own key would make.
    expect(
      parseAppEnv({ SEALANT_BOAT_DEPLOYMENT_ID: "test", SEALANT_CREDENTIALS_KEY: cipher })
        .SEALANT_BOAT_DEPLOYMENT_ID,
    ).toBe("test");
  });

  it("names the organization the install's own key bills, only beside that key", () => {
    expect(
      parseAppEnv({
        SEALANT_BOAT_API_KEY: "test-key-for-local-only",
        SEALANT_BOAT_ORGANIZATION: "team_acme",
        SEALANT_CREDENTIALS_KEY: cipher,
      }).SEALANT_BOAT_ORGANIZATION,
    ).toBe("team_acme");
    expect(() =>
      parseAppEnv({ SEALANT_BOAT_ORGANIZATION: "team_acme", SEALANT_CREDENTIALS_KEY: cipher }),
    ).toThrow("names the Boat organization the install's own key bills");
    expect(() =>
      parseAppEnv({
        SEALANT_BOAT_API_KEY: "test-key-for-local-only",
        SEALANT_BOAT_ORGANIZATION: " team",
        SEALANT_CREDENTIALS_KEY: cipher,
      }),
    ).toThrow();
  });

  it("starts with the retired Boat owner list still set, and ignores it", () => {
    const env = parseAppEnv({ SEALANT_BOAT_ADMISSION_OWNER_IDS: "usr_proof,usr_second" });
    expect(env).not.toHaveProperty("SEALANT_BOAT_ADMISSION_OWNER_IDS");
  });
});
