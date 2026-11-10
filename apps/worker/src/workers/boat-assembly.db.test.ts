import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialCipherService } from "@sealant/credentials";
import { createSealantDB, type DB } from "@sealant/db";
import { newWorkspaceSchema } from "@sealant/validators";
import { parseWorkerEnv } from "@sealant/validators/env";
import { selectRuntimeAdapter, type BoatNativeCatalogOptions } from "@sealant/workspaces";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleBoat, type BoatResourceDockerHost } from "./boat-assembly.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

const cipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

/** Nothing here builds an image: the builder is only handed to the catalog. */
const unused = async (): Promise<never> => {
  throw new Error("the Boat builder is not used by this test");
};
const snapshotBuilder = async (): Promise<BoatNativeCatalogOptions["builder"]> => ({
  plan: unused,
  build: unused,
  findPublished: unused,
  remove: unused,
  cleanup: unused,
  journals: unused,
  reconcileBuild: unused,
});

/** A Docker resource host that is never asked for anything by these tests. */
const dockerHost: BoatResourceDockerHost = {
  subnets: { allocate: unused, release: unused },
  runtime: { attachExecutor: unused, detachExecutor: unused },
};

const provider = {
  SEALANT_BOAT_API_KEY: "test-key-for-local-only",
  SEALANT_BOAT_DEPLOYMENT_ID: "boat-assembly-test",
  SEALANT_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const gateway = {
  SEALANT_BOAT_GATEWAY_HOST_ID: "11111111-2222-4333-8444-555555555555",
  SEALANT_BOAT_GATEWAY_RELAY_HOST: "127.0.0.1",
  SEALANT_BOAT_GATEWAY_IMAGE: `sha256:${"a".repeat(64)}`,
};

/** A Boat workspace as a create stores it: `resources` is `runtime.resources` of its spec. */
const boatWorkspace = (resources?: "none") =>
  newWorkspaceSchema.parse({
    sources: {
      workspace: { kind: "capture", endpoint: "https://mend.example.com/session/s1" },
    },
    harness: { id: "claude-code" },
    target: {
      os: { family: "ubuntu", mode: "require" },
      runtime: { family: "boat", mode: "require" },
    },
    ...(resources === undefined ? {} : { runtime: { resources } }),
  });

describe.skipIf(DATABASE_URL === undefined)("the worker's Boat assembly (Postgres)", () => {
  let db: DB;
  let state: string;
  const assembled: NonNullable<Awaited<ReturnType<typeof assembleBoat>>>[] = [];

  beforeAll(async () => {
    db = await createSealantDB(DATABASE_URL ?? "");
    state = await mkdtemp(join(tmpdir(), "boat-assembly-"));
  });
  afterAll(async () => {
    for (const boat of assembled) {
      await boat.runtime.dispose();
      await boat.disposeCatalog?.();
    }
    await rm(state, { recursive: true, force: true });
  });

  const assemble = async (
    settings: Record<string, string>,
    docker: BoatResourceDockerHost | undefined,
  ) => {
    // The same parse the worker's start runs: a refused environment never reaches the assembly.
    const env = parseWorkerEnv(settings);
    const boat = await assembleBoat({ env, db, credentialCipher: cipher, docker, snapshotBuilder });
    if (boat !== undefined) assembled.push(boat);
    return boat;
  };
  const builder = () => ({
    SEALANT_BOAT_BUILDER_OWNER: "11111111-2222-4333-8444-555555555555",
    SEALANT_BOAT_STATE_DIRECTORY: state,
  });

  it("does nothing for Boat without a Boat key", async () => {
    expect(await assemble({}, undefined)).toBeUndefined();
  });

  it("registers Boat from its provider and builder settings alone: no gateway, no Docker host", async () => {
    const boat = await assemble(
      // No Docker runtime at all, and another default runtime: neither is Boat's to require.
      { ...provider, ...builder(), DOCKER_RUNTIME_ENABLED: "false" },
      undefined,
    );
    const registration = boat?.registration;
    if (boat === undefined || registration === undefined) throw new Error("Boat not registered");
    expect(registration.kind).toBe("boat-native");
    expect(registration.adapter.id).toBe("boat");
    // It serves a workspace created never to be linked to resources.
    expect(registration.adapter.supports({ blueprint: boatWorkspace("none") })).toEqual({
      supported: true,
    });
    expect(
      selectRuntimeAdapter({
        blueprint: boatWorkspace("none"),
        adapters: [registration.adapter],
        defaultAdapterId: "docker",
      }).adapterId,
    ).toBe("boat");
    // Any other Boat workspace is refused before its build, with the typed reason.
    expect(registration.adapter.supports({ blueprint: boatWorkspace() })).toMatchObject({
      supported: false,
      reason: "gateway-unavailable",
    });
    expect(() =>
      selectRuntimeAdapter({
        blueprint: boatWorkspace(),
        adapters: [registration.adapter],
        defaultAdapterId: "docker",
      }),
    ).toThrow(expect.objectContaining({ code: "gateway-unavailable" }));
    // No gateway means no resource reach to account for, and its sweeps run with nothing to do.
    expect(boat.reach).toBeUndefined();
    expect(await boat.reconcileCloses?.({ limit: 20 })).toEqual({ entries: [] });
    expect(await boat.reconcileResources?.({ limit: 20 })).toEqual({ entries: [] });
    expect(boat.control).toBeDefined();
  });

  it("registers Boat with its resource gateway as before: every Boat workspace is served", async () => {
    const boat = await assemble({ ...provider, ...builder(), ...gateway }, dockerHost);
    const registration = boat?.registration;
    if (boat === undefined || registration === undefined) throw new Error("Boat not registered");
    expect(registration.adapter.supports({ blueprint: boatWorkspace() })).toEqual({
      supported: true,
    });
    expect(registration.adapter.supports({ blueprint: boatWorkspace("none") })).toEqual({
      supported: true,
    });
    expect(await boat.reach?.()).toEqual([]);
    expect(await boat.reconcileResources?.({ limit: 20 })).toEqual({ entries: [] });
  });

  it("refuses the gateway settings without the Docker resource host they run on", async () => {
    await expect(assemble({ ...provider, ...builder(), ...gateway }, undefined)).rejects.toThrow(
      "Boat resource reconciliation configuration is incomplete.",
    );
  });

  it("launches nothing without the builder: allocations alone, or its gateway's sweeps", async () => {
    const keyOnly = await assemble(provider, undefined);
    expect(keyOnly).toMatchObject({ registration: undefined, control: undefined });
    expect(keyOnly?.reconcileCloses).toBeUndefined();
    const sweeps = await assemble({ ...provider, ...gateway }, dockerHost);
    expect(sweeps?.registration).toBeUndefined();
    expect(await sweeps?.reconcileCloses?.({ limit: 20 })).toEqual({ entries: [] });
  });
});
