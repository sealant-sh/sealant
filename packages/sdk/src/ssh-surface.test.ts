/**
 * Unit tests for the workspace-SSH surface — the setup-state → gateway-info mapping, the ssh-key
 * mapping, and the ops' call shapes — driven against a stub contract client (no live API).
 */
import type { SetupStateResponse, SshKeySummary } from "@sealant/api-contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import {
  archiveSshKeyOp,
  createSshKeyOp,
  getSetupStateOp,
  listSshKeysOp,
} from "./effect/operations.js";
import { mapSshKey, mapWorkspaceSshInfo } from "./internal/ssh.js";

const KEY: SshKeySummary = {
  sshKeyId: "sshk_1",
  ownerUserId: "usr_local",
  name: "macbook",
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEF0",
  createdAt: "2026-08-29T00:00:00.000Z",
};

const SETUP_STATE: SetupStateResponse = {
  needsSetup: false,
  sshGateway: { host: "10.0.0.214", port: 2222, usernamePrefix: "ws" },
};

interface StubCalls {
  getSetupState: number;
  createSshKey: unknown[];
  listSshKeys: unknown[];
  archiveSshKey: unknown[];
}

const makeStub = (): { client: ControlPlaneClient; calls: StubCalls } => {
  const calls: StubCalls = {
    getSetupState: 0,
    createSshKey: [],
    listSshKeys: [],
    archiveSshKey: [],
  };
  const system = {
    getSetupState: () => {
      calls.getSetupState += 1;
      return Effect.succeed(SETUP_STATE);
    },
  };
  const sshKeys = {
    createSshKey: (request: unknown) => {
      calls.createSshKey.push(request);
      return Effect.succeed(KEY);
    },
    listSshKeys: (request: unknown) => {
      calls.listSshKeys.push(request);
      return Effect.succeed({ items: [KEY] });
    },
    archiveSshKey: (request: unknown) => {
      calls.archiveSshKey.push(request);
      return Effect.succeed(KEY);
    },
  };
  // The derived `ControlPlaneClient` surface is far wider; the narrowing cast is test-only.
  const client = { system, sshKeys } as unknown as ControlPlaneClient;
  return { client, calls };
};

const run = <A, E>(client: ControlPlaneClient, effect: Effect.Effect<A, E, SealantApiClient>) =>
  Effect.runPromise(Effect.provideService(effect, SealantApiClient, client));

describe("workspace-ssh ops", () => {
  it("reads setup state and maps the gateway coordinates", async () => {
    const { client, calls } = makeStub();
    const wire = await run(client, getSetupStateOp());
    expect(calls.getSetupState).toBe(1);
    expect(mapWorkspaceSshInfo(wire)).toEqual({
      host: "10.0.0.214",
      port: 2222,
      usernamePrefix: "ws",
    });
  });

  it("maps a missing gateway to null", () => {
    expect(mapWorkspaceSshInfo({ needsSetup: true, sshGateway: null })).toBeNull();
  });

  it("sends ssh-key requests with the owner threaded where each endpoint expects it", async () => {
    const { client, calls } = makeStub();
    await run(
      client,
      createSshKeyOp({ ownerUserId: "usr_local", publicKey: "ssh-ed25519 AAAA mac" }),
    );
    await run(client, listSshKeysOp("usr_local"));
    await run(client, archiveSshKeyOp("sshk_1", "usr_local"));
    expect(calls.createSshKey).toEqual([
      { payload: { ownerUserId: "usr_local", publicKey: "ssh-ed25519 AAAA mac" } },
    ]);
    expect(calls.listSshKeys).toEqual([{ query: { ownerUserId: "usr_local" } }]);
    expect(calls.archiveSshKey).toEqual([
      { params: { sshKeyId: "sshk_1" }, query: { ownerUserId: "usr_local" } },
    ]);
  });

  it("maps the wire key without inventing fields", () => {
    expect(mapSshKey(KEY)).toEqual({
      sshKeyId: "sshk_1",
      ownerUserId: "usr_local",
      name: "macbook",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEF0",
      createdAt: "2026-08-29T00:00:00.000Z",
    });
  });
});
