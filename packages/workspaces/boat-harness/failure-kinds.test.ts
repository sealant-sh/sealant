/**
 * Every way Boat refuses a call reaches a caller as its kind, with Boat's code and request id:
 * the fake Boat answers with Boat's error envelope, sealant's HTTP client classifies it, and the
 * launch diagnostic (a Boat launch) or the provider failure (an image build) carries it into the
 * workspace's error, where the API reads it back for the SDK. No key reaches any of them.
 */
import { randomUUID } from "node:crypto";

import { BOAT_FAILURE_KINDS, type BoatFailureKind } from "@sealant/api-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { nativeProviderFailureSchema } from "../src/images/boat/command-diagnostics.js";
import { NativeBuildError } from "../src/images/boat/runtime-bundle.js";
import { BoatAdapterError } from "../src/runtime/boat/adapter.js";
import { HttpBoatApi } from "../src/runtime/boat/api.js";
import {
  BoatSecret,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatApiError,
} from "../src/runtime/boat/config.js";
import { boatFailureInMessage } from "../src/runtime/boat/failure.js";
import { boatLaunchDiagnostic } from "../src/runtime/boat/launch-diagnostics.js";
import type { DockerResult } from "./docker.js";
import { FakeBoat, type FakeBoatRefusal } from "./fake-boat.js";
import { BOAT_REFUSALS } from "./refusals.js";

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const credential = "fixture-boat-key-0123456789abcdef";

let boat: FakeBoat | undefined;
afterEach(async () => {
  await boat?.stop();
  boat = undefined;
});

const start = async () => {
  boat = new FakeBoat({
    runId: "kinds001",
    credential,
    network: "unit",
    baseImage: "unit-base",
    docker: async (args) => (args[0] === "inspect" ? ok("192.0.10.5\n") : ok("running\n")),
  });
  await boat.start();
  const secret = BoatSecret.parse(credential);
  if (!secret.ok) throw secret.error;
  const api = HttpBoatApi.create({ credential: secret.value, baseUrl: boat.baseUrl });
  if (!api.ok) throw api.error;
  return { boat, api: api.value };
};

const create = (api: HttpBoatApi) =>
  api.create({
    idempotencyKey: randomUUID(),
    marker: randomUUID(),
    purpose: "native-build",
    lifetime: { kind: "bounded" },
    requestVersion: 2,
  });

/** Arms one refusal on one call, makes the call, and returns Boat's error as sealant holds it. */
const refused = async (
  kind: BoatFailureKind,
  refusal: FakeBoatRefusal | "no-answer",
): Promise<BoatApiError> => {
  const { boat: fake, api } = await start();
  const snapshot = kind === "snapshot-allowance-full";
  fake.faults = {
    refuse: (call) =>
      call.method === "POST" && call.path === (snapshot ? "/saved-snapshots" : "/sandboxes")
        ? refusal
        : undefined,
  };
  const result = snapshot
    ? await api.saveSnapshot(
        boatSandboxIdSchema.parse("bx_23456789"),
        boatSnapshotNameSchema.parse("sealant-kinds"),
      )
    : await create(api);
  if (result.ok) throw new Error("Boat accepted the call");
  return result.error;
};

/** What the launch puts in its failure, read back as the API reads a failed runtime's message. */
const throughLaunch = (error: BoatApiError) =>
  boatFailureInMessage(
    new BoatAdapterError("launch-held", boatLaunchDiagnostic(error, "create")).message,
  );
/** The same for an image build's failure. */
const throughBuild = (error: BoatApiError) =>
  boatFailureInMessage(
    new NativeBuildError(
      `native-provider-${error.code}`,
      undefined,
      undefined,
      nativeProviderFailureSchema.parse(error),
    ).message,
  );

describe("Boat's reasons reach the caller", () => {
  const cases = Object.entries(BOAT_REFUSALS).map(([kind, refusal]) => ({
    kind: BOAT_FAILURE_KINDS.find((known) => known === kind) ?? "refused",
    refusal: refusal satisfies FakeBoatRefusal,
  }));

  it("covers every kind but a call Boat never answered", () => {
    expect(cases.map((entry) => entry.kind).toSorted()).toEqual(
      BOAT_FAILURE_KINDS.filter((kind) => kind !== "no-answer").toSorted(),
    );
  });

  it.each(cases)("$kind: kind, Boat's code and request id", async ({ kind, refusal }) => {
    const error = await refused(kind, refusal);
    for (const failure of [error.boat, throughLaunch(error), throughBuild(error)]) {
      expect(failure).toMatchObject({
        kind,
        code: refusal.code,
        status: refusal.status,
        requestId: expect.stringMatching(/^req_fake[0-9a-z]+$/),
        retryable: ["rate-limited", "no-machine"].includes(kind),
      });
      expect(failure?.message).toBeDefined();
      expect(JSON.stringify(failure)).not.toContain(credential);
    }
    // Boat's own code is the error's code, not a catch-all.
    expect(error.code).toBe(refusal.code);
  });

  it("no-answer: a dropped connection is a retryable failure with nothing of Boat's", async () => {
    const error = await refused("no-answer", "no-answer");
    for (const failure of [error.boat, throughLaunch(error), throughBuild(error)])
      expect(failure).toEqual({ kind: "no-answer", retryable: true, operation: "create" });
  });

  it("names the permission, the wait and the billing link Boat or the call give", async () => {
    expect(
      (await refused("permission-missing", BOAT_REFUSALS["permission-missing"])).boat,
    ).toMatchObject({ permission: "sandbox.create" });
    expect(
      (
        await refused("permission-missing", {
          ...BOAT_REFUSALS["permission-missing"],
          details: { action: "snapshot.read" },
        })
      ).boat,
    ).toMatchObject({ permission: "snapshot.read" });
    expect((await refused("rate-limited", BOAT_REFUSALS["rate-limited"])).boat).toMatchObject({
      retryAfterSeconds: 42,
      retryAt: "2026-11-13T12:01:00.000Z",
    });
    // The header alone, as every 429 carries it.
    expect(
      (await refused("running-limit", BOAT_REFUSALS["running-limit"])).boat?.retryAfterSeconds,
    ).toBe(60);
    expect(
      (await refused("billing-required", BOAT_REFUSALS["billing-required"])).boat,
    ).toMatchObject({
      billingUrl: "https://boat.dev/billing?from=api",
    });
  });

  it("keeps nothing of Boat's body but its allowed fields, and never the key", async () => {
    const error = await refused("refused", {
      status: 400,
      code: "invalid_env",
      message: `Bad env ${credential} boat_live_abcdefgh1234 Bearer abc.def token=hunter22 see https://evil.example/x?sig=1 or https://boat.dev/docs/env?x=1`,
      details: { echoedBody: { apiKey: credential }, stack: "at handler (/srv/app.js:1)" },
      fields: { billingUrl: "https://evil.example/pay", internal: "do-not-keep" },
    });
    const kept = JSON.stringify([error.boat, error.message, throughLaunch(error)]);
    for (const leaked of [
      credential,
      "boat_live_abcdefgh1234",
      "abc.def",
      "hunter22",
      "sig=1",
      "evil.example/pay",
      "do-not-keep",
      "echoedBody",
      "/srv/app.js",
    ])
      expect(kept).not.toContain(leaked);
    expect(error.boat).toEqual({
      kind: "refused",
      retryable: false,
      operation: "create",
      status: 400,
      code: "invalid_env",
      message:
        "Bad env [REDACTED] [REDACTED] [REDACTED_AUTH] token=[REDACTED] see [link evil.example] or https://boat.dev/docs/env",
      requestId: expect.stringMatching(/^req_fake/),
    });
  });
});
