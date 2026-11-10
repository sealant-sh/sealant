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

  it("takes the Boat key, or its file, with the deployment and the credential cipher", () => {
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
    for (const key of Object.keys(file))
      expect(() =>
        parseAppEnv(Object.fromEntries(Object.entries(file).filter(([name]) => name !== key))),
      ).toThrow("Boat requires its key");
  });

  it("is on with the Boat deployment, and then refuses to start without the key, naming it", () => {
    // No Boat settings: Boat is off and the API starts (it refuses Boat requests at create).
    expect(parseAppEnv({ SEALANT_CREDENTIALS_KEY: cipher }).SEALANT_BOAT_DEPLOYMENT_ID).toBe(
      undefined,
    );
    // Boat on, with its key: the API opens Boat runs' control itself.
    expect(
      parseAppEnv({
        SEALANT_BOAT_API_KEY_FILE: "/run/secrets/boat-api-key",
        SEALANT_BOAT_DEPLOYMENT_ID: "test",
        SEALANT_CREDENTIALS_KEY: cipher,
      }).SEALANT_BOAT_DEPLOYMENT_ID,
    ).toBe("test");
    // Boat on, the key forgotten: startup fails and says which settings to give it.
    expect(() =>
      parseAppEnv({ SEALANT_BOAT_DEPLOYMENT_ID: "test", SEALANT_CREDENTIALS_KEY: cipher }),
    ).toThrow(/SEALANT_BOAT_API_KEY or SEALANT_BOAT_API_KEY_FILE/);
  });

  it("starts with the retired Boat owner list still set, and ignores it", () => {
    const env = parseAppEnv({ SEALANT_BOAT_ADMISSION_OWNER_IDS: "usr_proof,usr_second" });
    expect(env).not.toHaveProperty("SEALANT_BOAT_ADMISSION_OWNER_IDS");
  });
});
