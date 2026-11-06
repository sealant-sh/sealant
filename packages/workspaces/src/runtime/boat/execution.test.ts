import { generateKeyPairSync, randomUUID } from "node:crypto";

import { boatExecutionTargetSchema } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import type { BoatSandbox } from "./api.js";
import { boatSandboxIdSchema } from "./config.js";
import { createBoatGuestTransport } from "./execution.js";

const target = boatExecutionTargetSchema.parse({
  deploymentId: "deployment",
  workspaceId: "workspace",
  runId: "run",
  runtimeInstanceId: "run",
  launchAttemptId: "attempt",
  sourceId: "source",
  sandboxId: "bx_23456789",
  diskLineage: "disk",
  bootId: "2ead21c0-5a0f-4db0-87bf-fcc992c781b6",
  manifestDigest: "b".repeat(64),
});
const labels = {
  "sealant-runtime": "boat",
  "sealant-deployment": target.deploymentId,
  "sealant-workspace": target.workspaceId,
  "sealant-run": target.runId,
  "sealant-instance": target.runtimeInstanceId,
  "sealant-attempt": target.launchAttemptId,
  "sealant-source": target.sourceId,
};
const unavailable = async (): Promise<never> => {
  throw new Error("must not call");
};
describe("Boat worker public bootstrap transport", () => {
  it("checks every provider target label before issuing a command", async () => {
    for (const key of Object.keys(labels)) {
      const actual: BoatSandbox = {
        id: boatSandboxIdSchema.parse(target.sandboxId),
        state: "running",
        labels: { ...labels, [key]: "foreign" },
        autoStop: { kind: "disabled" },
      };
      const transport = createBoatGuestTransport({
        get: async () => ({ ok: true, value: actual }),
        execute: unavailable,
        hostControl: unavailable,
      });
      await expect(transport.bind(target, {})).rejects.toThrow("target-mismatch");
      await expect(transport.host(target)).rejects.toThrow("target-mismatch");
    }
  });
  it("sends only the public fixed-helper command and refuses unknown command outcomes", async () => {
    let count = 0;
    const transport = createBoatGuestTransport({
      get: async () => ({
        ok: true,
        value: {
          id: boatSandboxIdSchema.parse(target.sandboxId),
          state: "running",
          labels,
          autoStop: { kind: "disabled" },
        },
      }),
      execute: async (id, command) => {
        count++;
        expect(id).toBe(target.sandboxId);
        expect(command).toContain(
          "/bundle/usr/bin/python3 -I -S -B /var/lib/sealant/guest/guest_boot.py bind '",
        );
        expect(command).toContain("public_key");
        return {
          ok: true,
          value: {
            exitCode: null,
            timedOut: true,
            stdout: "untrusted-output",
            stderr: "untrusted-output",
          },
        };
      },
      hostControl: unavailable,
    });
    const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
    await expect(
      transport.bind(target, {
        format: "sealant-bootstrap-v1",
        identity: {
          deployment_id: target.deploymentId,
          instance_id: target.sandboxId,
          disk_lineage: target.diskLineage,
        },
        boot_id: target.bootId,
        manifest_digest: target.manifestDigest,
        operation_id: randomUUID(),
        public_key: key.publicKey.export({ type: "spki", format: "pem" }),
      }),
    ).rejects.toThrow("transport-unavailable");
    expect(count).toBe(1);
  });
});
