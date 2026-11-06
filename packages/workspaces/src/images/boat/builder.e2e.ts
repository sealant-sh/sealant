import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { nativeBuilderFixture as fixture, nativeBuilderProbe } from "./builder.fixture.js";
const directory = process.env.SEALANT_BOAT_RUNTIME_BUNDLE;
describe.skipIf(!directory)(
  "native builder through HTTP and durable journals with the exact bundle",
  () => {
    for (const mode of ["normal", "lost-save"] as const)
      it(mode + " requires scratch deletion and exact reuse/removal", async () => {
        const f = await fixture(mode);
        expect(
          await f.builder.build({
            spec: {
              ...f.spec,
              target: { ...f.spec.target, os: { family: "arch", mode: "require" } },
            },
          }),
        ).toMatchObject({ ok: false, error: { code: "native-unsupported-os" } });
        expect(f.mutations).toEqual([]);
        expect(
          await f.builder.build({
            spec: {
              ...f.spec,
              sources: {
                ...f.spec.sources,
                inputs: [
                  {
                    id: "dotfiles",
                    purpose: "dotfiles",
                    kind: "git",
                    provider: "generic",
                    url: "https://user:secret@example.invalid/dots.git",
                  },
                ],
              },
            },
          }),
        ).toMatchObject({ ok: false, error: { code: "native-dotfiles-unsafe-url" } });
        expect(f.mutations).toEqual([]);
        const plan = await f.builder.plan(f.spec);
        if (!plan.ok) throw plan.error;
        const ownership = {
          publicationId: randomUUID(),
          buildId: randomUUID(),
          key: {
            ...plan.value,
            deploymentId: "local-stage2a",
            scope: { kind: "owner" as const, ownerUserId: "usr_stage2a" },
          },
        };
        const result = await f.builder.build({ spec: f.spec, ownership });
        if (!result.ok) throw result.error;
        expect(f.deleted()).toBe(true);
        expect(result.value.artifact.build).toBe(ownership.buildId);
        expect(result.value.evidence).toMatchObject({
          imageProbe: nativeBuilderProbe,
          daemonRecovery: "supported",
          executorRecovery: "unverified",
        });
        expect(await f.builder.reconcileBuild(ownership)).toMatchObject({
          ok: true,
          value: {
            kind: "published",
            artifact: result.value.artifact,
            evidence: result.value.evidence,
          },
        });
        expect(await f.builder.build({ spec: f.spec, ownership })).toMatchObject({
          ok: true,
          value: {
            outcome: "reused",
            artifact: result.value.artifact,
            evidence: result.value.evidence,
          },
        });
        expect(result.value.artifact.identity.snapshotId).toBe("exact-provider-id");
        expect(result.value.artifact.identity.name.length).toBeLessThanOrEqual(63);
        expect(result.value.artifact.identity.name).toMatch(/^sealant-dev-boat-stream-/);
        expect(f.posts()).toBe(1);
        const count = f.mutations.length;
        expect(
          await f.builder.build({ spec: f.spec, previous: result.value.artifact }),
        ).toMatchObject({ ok: true, value: { outcome: "reused" } });
        expect(f.mutations).toHaveLength(count);
        expect(
          await f.builder.remove({ ...result.value.artifact, receiptHash: "0".repeat(64) }),
        ).toMatchObject({ ok: false });
        expect(await f.builder.remove(result.value.artifact)).toEqual({
          ok: true,
          value: "deleted",
        });
        expect(await f.builder.remove(result.value.artifact)).toEqual({
          ok: true,
          value: "absent",
        });
      });
    it("cleans failed saves without returning ordinary success", async () => {
      const f = await fixture("failed-save");
      const plan = await f.builder.plan(f.spec);
      if (!plan.ok) throw plan.error;
      const ownership = {
        publicationId: randomUUID(),
        buildId: randomUUID(),
        key: {
          ...plan.value,
          deploymentId: "local-stage2a",
          scope: { kind: "owner" as const, ownerUserId: "usr_stage2a" },
        },
      };
      const result = await f.builder.build({ spec: f.spec, ownership });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "native-save-failed" },
      });
      if (result.ok || result.error.journalPath === undefined) throw new Error("missing journal");
      expect(JSON.parse(await readFile(result.error.journalPath, "utf8"))).toMatchObject({
        failureCode: "native-save-failed",
        phase: "complete",
      });
      expect(f.deleted()).toBe(true);
      expect(f.mutations.some((p) => p.startsWith("DELETE /api/v1/saved-snapshots/"))).toBe(true);
      const mutations = [...f.mutations];
      expect(await f.builder.build({ spec: f.spec, ownership })).toMatchObject({
        ok: false,
        error: { code: "native-build-abandoned" },
      });
      expect(f.mutations).toEqual(mutations);
    });
    it("refuses an old base-image approval before save and removes its scratch VM", async () => {
      const f = await fixture("legacy-guest-approval");
      expect(await f.builder.build({ spec: f.spec })).toMatchObject({ ok: false });
      expect(f.deleted()).toBe(true);
      expect(f.posts()).toBe(0);
    });
    it("cancels installation with an independent cleanup finalizer", async () => {
      const f = await fixture("cancel");
      expect(await f.builder.build({ spec: f.spec, signal: f.cancellation.signal })).toMatchObject({
        ok: false,
        error: { code: "native-interrupted" },
      });
      expect(f.deleted()).toBe(true);
      expect(f.posts()).toBe(0);
    });
    it("removes the saved artifact when cancelled during source deletion", async () => {
      const f = await fixture("cancel-cleaning");
      expect(await f.builder.build({ spec: f.spec, signal: f.cancellation.signal })).toMatchObject({
        ok: false,
        error: { code: "native-interrupted" },
      });
      expect(f.deleted()).toBe(true);
      expect(f.posts()).toBe(1);
      expect(f.mutations.some((p) => p.startsWith("DELETE /api/v1/saved-snapshots/"))).toBe(true);
    });
  },
);
