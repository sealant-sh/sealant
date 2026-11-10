/**
 * Automatic parking and resume of a Boat session with the workspace's own Docker
 * (capture-preservation.md):
 *
 * 1. a ready session builds an image as the owner's person and leaves an edit Mend cannot take
 *    (the capture channel refuses uploads), so its Stop keeps the VM: retained;
 * 2. after the parking delay the worker parks it: the agent's park, a saved snapshot of the whole
 *    VM, the receipt read back from it, the VM deleted, its UDP slot released;
 * 3. Mend's lease advances the epoch and the owner asks to recover: a child VM from the snapshot,
 *    bound on its new boot, the daemon launched on the kept disk;
 * 4. on the child, the image is still there (`docker image ls`, same id, it runs) and the edit is
 *    byte for byte the same;
 * 5. a final Stop with uploads working ends the lineage: stopped, nothing left, snapshot retired.
 *
 * The worker runs with `SEALANT_BOAT_AUTOMATIC_PARKING=true` and the shortest delay Core accepts
 * (300 s) for this scenario only.
 *
 * `BOAT_HARNESS_SIMULATE_RETENTION=1` writes the `retained_at` Core's Boat stop does not record
 * (defect P1), so the steps after it can be proved before P1 is fixed. Never set in CI.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { Transcript, asPerson, evidenceDir, preparePerson } from "./docker-scenario.js";
import {
  assertReleased,
  assertSettled,
  awaitOutcome,
  guestEvidence,
  launch,
  runtimeView,
  sqlText,
  until,
  type Launch,
  type Project,
} from "./scenario.js";
import type { HarnessStack } from "./stack.js";

export const PARKING_DELAY_SECONDS = 300;

type Step = <T>(name: string, body: () => Promise<T>) => Promise<T>;

const preservationSchema = z.looseObject({
  status: z.string(),
  runtime: z.looseObject({ resourceId: z.string().nullable().optional() }).nullable().optional(),
  captureDrain: z
    .looseObject({
      preservation: z
        .looseObject({ state: z.string(), desired: z.string().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
type WorkspaceRead = z.infer<typeof preservationSchema>;

/** The workspace as Mend reads it, with the preservation block the SDK facade drops. */
const readWorkspace = async (stack: HarnessStack, run: Launch): Promise<WorkspaceRead> => {
  const response = await fetch(
    `${stack.apiUrl}/v1/workspaces/${run.workspace.id}?ownerUserId=${encodeURIComponent(stack.ownerId)}`,
    { headers: { Authorization: `Bearer ${stack.serviceKey}` } },
  );
  if (!response.ok) throw new Error(`workspace read: ${response.status} ${await response.text()}`);
  return preservationSchema.parse(await response.json());
};

const preservationState = (read: WorkspaceRead) => read.captureDrain?.preservation?.state;

const custody = async (stack: HarnessStack, run: Launch) =>
  z
    .object({
      retained_at: z.string().nullable(),
      retained_reason: z.string().nullable(),
      custody_contract: z.number().nullable(),
    })
    .optional()
    .parse(
      (
        await stack.query(
          `select retained_at, retained_reason, custody_contract from workspace_capture_drains where run_id = '${sqlText(run.runId)}'`,
        )
      )[0],
    );

const IMAGE = "harness-park-probe:1";

export const parkAndResume = async (stack: HarnessStack, project: Project, step: Step) => {
  const transcript = new Transcript(join(evidenceDir(stack), "parking-scenario.md"));
  await step("worker with automatic parking", () =>
    stack.restartWorker({
      SEALANT_BOAT_AUTOMATIC_PARKING: "true",
      SEALANT_BOAT_PARKING_DELAY_SECONDS: String(PARKING_DELAY_SECONDS),
    }),
  );
  try {
    const run = await step("launch (docker, person)", () =>
      launch(stack, project, { docker: true, person: true }),
    );
    const outcome = await step("ready", () => awaitOutcome(stack, run, 40 * 60_000));
    if (outcome.status !== "ready")
      throw new Error(
        `step ready: launch ended ${outcome.status} with ${JSON.stringify(outcome.view)}; guest: ${await guestEvidence(stack, run.runId)}`,
      );
    const source = (await runtimeView(stack, run.runId)).sandbox;
    await transcript.note(
      `# Park and resume: run ${run.runId}, workspace ${run.workspace.id}, VM ${source}`,
    );

    const imageId = await step("build an image", async () => {
      await preparePerson(run, transcript);
      await asPerson(
        run,
        transcript,
        "build",
        `d=$(mktemp -d) && printf 'FROM busybox:1.36\\nRUN echo parked-and-resumed > /proof\\n' > "$d/Dockerfile" && docker build -q -t ${IMAGE} "$d"`,
      );
      return (
        await asPerson(run, transcript, "image id", `docker image inspect -f '{{.Id}}' ${IMAGE}`)
      ).trim();
    });

    const marker = `boat-harness parked ${randomBytes(16).toString("hex")}`;
    await step("an edit Mend cannot take yet", async () => {
      await run.capture.failUploads(true);
      await asPerson(
        run,
        transcript,
        "edit",
        `printf '%s\\n' '${marker}' > park-proof.txt && sync`,
      );
    });

    await step("Stop keeps the VM", async () => {
      await run.workspace.stop();
      // The FINAL cannot drain (uploads refused, or its deadline passes first), so Mend must read
      // the session as kept. Whether the daemon got as far as asking to upload is only evidence.
      let seen = "";
      await until(
        "the Stop to keep the session (retained)",
        async () => {
          seen = await run.workspace.status();
          return seen === "retained" ? true : undefined;
        },
        3 * 60_000,
        2000,
      ).catch(async (error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; last status ${seen}; capture ${JSON.stringify(await run.capture.state())}`,
        );
      });
      const channel = await run.capture.state();
      await transcript.note(
        `kept: public status retained; capture head ${JSON.stringify(channel.head)}, uploads refused ${String(channel.refusedUploads)}`,
      );
    });

    await step("retention", async () => {
      // Three sweeps for the stop path to record retention and the parking sweep to enroll it.
      await new Promise((done) => setTimeout(done, 90_000));
      const row = await custody(stack, run);
      if (row?.retained_at !== null && row?.retained_at !== undefined) return;
      if (process.env.BOAT_HARNESS_SIMULATE_RETENTION === "1") {
        await stack.write(
          `update workspace_capture_drains set retained_at = now(), retained_reason = 'boat-harness: simulated retention (P1)', next_recovery_at = now() where run_id = '${sqlText(run.runId)}' and retained_at is null and custody_contract is null`,
        );
        await transcript.note("retention simulated (BOAT_HARNESS_SIMULATE_RETENTION=1, defect P1)");
        return;
      }
      throw new Error(
        `parking never starts: the Stop kept the session, but 90 s later workspace_capture_drains has retained_at ${JSON.stringify(row?.retained_at ?? null)}, custody_contract ${JSON.stringify(row?.custody_contract ?? null)}; nothing enrolls it for parking`,
      );
    });

    await step("parked", async () => {
      await until(
        "the worker to park the session (agent park, saved snapshot, VM deleted)",
        async () => {
          const read = await readWorkspace(stack, run);
          return preservationState(read) === "parked" ? true : undefined;
        },
        (PARKING_DELAY_SECONDS + 15 * 60) * 1000,
        5000,
      ).catch(async (error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; read ${JSON.stringify(await readWorkspace(stack, run))}; custody ${JSON.stringify(await custody(stack, run))}`,
        );
      });
      expect(stack.boat.liveSandboxes().some((vm) => vm.id === source)).toBe(false);
      const saved = [...stack.boat.snapshots.values()].filter(
        (entry) => entry.sourceSandboxId === source,
      );
      expect(saved.map((entry) => entry.status)).toEqual(["ready"]);
      await transcript.note(`parked: snapshot ${saved[0]?.name ?? "?"}, VM ${source} deleted`);
    });

    await step("recover", async () => {
      await run.capture.failUploads(false);
      // Mend's lease service advances the epoch before another executor may take the session.
      await run.capture.setEpoch((await run.capture.state()).epoch + 1);
      const response = await fetch(`${stack.apiUrl}/v1/workspaces/${run.workspace.id}/recover`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stack.serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerUserId: stack.ownerId }),
      });
      const body = await response.text();
      if (response.status !== 202) throw new Error(`recover answered ${response.status}: ${body}`);
      await until(
        "the resumed child to be ready",
        async () => {
          const read = await readWorkspace(stack, run);
          return read.status === "ready" && preservationState(read) === "active" ? read : undefined;
        },
        15 * 60_000,
        5000,
      ).catch(async (error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; read ${JSON.stringify(await readWorkspace(stack, run))}`,
        );
      });
    });

    await step("the image survived", async () => {
      const read = await readWorkspace(stack, run);
      const child = read.runtime?.resourceId ?? null;
      expect(child).not.toBeNull();
      expect(child).not.toBe(source);
      await asPerson(run, transcript, "docker image ls", "docker image ls");
      expect(
        (
          await asPerson(run, transcript, "image id", `docker image inspect -f '{{.Id}}' ${IMAGE}`)
        ).trim(),
      ).toBe(imageId);
      expect(
        (await asPerson(run, transcript, "run it", `docker run --rm ${IMAGE} cat /proof`)).trim(),
      ).toBe("parked-and-resumed");
      expect((await asPerson(run, transcript, "the edit", "cat park-proof.txt")).trim()).toBe(
        marker,
      );
    });

    const finalAt = Date.now();
    await step("final Stop", () => run.workspace.stop());
    await step("final release", async () => {
      await assertSettled(stack, run, finalAt, { terminal: ["stopped"] });
      await assertReleased(stack, run, { discard: false });
      await until(
        "the saved snapshot to be retired",
        async () =>
          [...stack.boat.snapshots.values()].some((entry) => entry.sourceSandboxId === source)
            ? undefined
            : true,
        3 * 60_000,
      );
    });
  } finally {
    await stack.restartWorker();
  }
};
