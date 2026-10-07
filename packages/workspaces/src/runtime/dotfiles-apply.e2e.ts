/**
 * A person's dotfiles applied as their user into their home, through Core's staging and a real
 * daemon, on a per-person image (Mend's ADR 0016 decision 11; sealantd#147):
 *
 * 1. The stage script, over the live channel, reads the daemon's `dotfiles.user` capability, checks
 *    the user and their passwd home, and stages the archives root-only under `/run/sealant-dotfiles`.
 * 2. `dotfiles.apply` as that user answers once the files are applied: every file is theirs, in
 *    their home only, and the bootstrap (`./install.sh`) then runs as them (its uid and `HOME` are
 *    the person's), its events stamped with the execution.
 * 3. The cleanup removes the staged archives; nothing reached another person's home or root's.
 * 4. A link the person planted into another person's home: the apply fails and that home is not
 *    written (sealantd#149, 0.20.0-next.152).
 * 5. Refusals: an unknown user, a home that is not the user's, and root (the daemon's own refusal).
 *
 * The image must be a managed per-person image whose sealantd reports `dotfiles.user` (the pinned
 * 0.20.0-next.150 or later): `SEALANT_DOTFILES_APPLY_E2E_IMAGE`, default
 * `sealant-workspace-fedora:latest`. Run with:
 *   pnpm --filter @sealant/workspaces test:e2e src/runtime/dotfiles-apply.e2e.ts
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { StreamKind } from "@sealant/runtime-client";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Result, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertImageRequirement, docker, isImagePresent } from "../sealantd/boot.js";
import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantSession,
} from "../sealantd/runtime.js";
import { sealantTargetForDockerContainer } from "../sealantd/target.js";
import {
  buildDotfilesCleanupScript,
  buildDotfilesStageScript,
  DOTFILES_STAGE_EXIT,
  dotfilesStagePath,
  dotfilesStageStdin,
  liveDotfilesStageChannel,
} from "./dotfiles-apply.js";
import { DockerRuntimeAdapter, parseRuntimeAdapterLaunchInput } from "./index.js";

const IMAGE_REF =
  process.env["SEALANT_DOTFILES_APPLY_E2E_IMAGE"] ?? "sealant-workspace-fedora:latest";
const PERSON = { name: "m4lice000", uid: 40001, home: "/home/m4lice000" };
const OTHER = { name: "m8ob0000", uid: 40002, home: "/home/m8ob0000" };

const execFileAsync = promisify(execFile);

const imageAvailable = await isImagePresent(IMAGE_REF);
assertImageRequirement(imageAvailable);

/** What the image's sealantd says it supports, without booting it. */
const imageSupports = async (): Promise<readonly string[]> => {
  const out = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "sealantd",
    IMAGE_REF,
    "capabilities",
    "--json",
  ]).catch(() => undefined);
  if (out === undefined) return [];
  const parsed: unknown = JSON.parse(out);
  return typeof parsed === "object" &&
    parsed !== null &&
    "supports" in parsed &&
    Array.isArray(parsed.supports)
    ? parsed.supports.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const appliesAsUser = imageAvailable && (await imageSupports()).includes("dotfiles.user");
if (imageAvailable && !appliesAsUser && process.env["SEALANT_E2E_REQUIRE_IMAGE"] === "1") {
  throw new Error(
    `SEALANT_E2E_REQUIRE_IMAGE=1 but ${IMAGE_REF}'s sealantd does not report dotfiles.user: build a managed image with the pinned sealantd.`,
  );
}

const withDaemon = <A, E>(
  containerId: string,
  use: (session: SealantSession) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(sealantTargetForDockerContainer(containerId));
        return yield* use(session);
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

/** A `.tar.gz` of `files` (relative path to content; `install.sh` executable), base64. */
const tarball = async (root: string, files: Readonly<Record<string, string>>) => {
  const dir = join(root, `tree-${randomUUID()}`);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
    if (path.endsWith(".sh")) await chmod(full, 0o755);
  }
  const archive = `${dir}.tar.gz`;
  await execFileAsync("tar", ["-czf", archive, "-C", dir, "."]);
  return (await readFile(archive)).toString("base64");
};

const sh = (containerId: string, script: string) =>
  docker(["exec", containerId, "sh", "-c", script]);

const temporaryDirectories = new Set<string>();
let containerId = "";

beforeAll(async () => {
  if (!appliesAsUser) return;
  const storeRoot = await mkdtemp(join(tmpdir(), "sealant-dotfiles-apply-e2e-"));
  temporaryDirectories.add(storeRoot);
  const worktree = join(storeRoot, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "README.md"), "dotfiles apply e2e\n");
  const adapter = new DockerRuntimeAdapter({
    autoRemove: false,
    containerNamePrefix: "sealant-dotfiles-apply-e2e",
    runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
    mountAllowedStoreRoots: storeRoot,
  });
  const launched = await adapter.launch(
    parseRuntimeAdapterLaunchInput({
      blueprint: {
        version: "1",
        sources: { workspace: { kind: "mount", hostPath: worktree }, inputs: [], mounts: [] },
        harness: { id: "opencode" },
        lifecycle: { setup: [], startup: { steps: [], foreground: { kind: "harness" } } },
        runtime: {
          env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity" },
          network: { outbound: true },
        },
        target: { os: { family: "fedora" }, runtime: { family: "docker" } },
      },
      publishedImage: {
        repository: "sealant-workspace-fedora",
        tag: "latest",
        reference: IMAGE_REF,
        digestReference: IMAGE_REF,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      runId: `dotfiles-apply-e2e-${randomUUID()}`,
    }),
  );
  containerId = launched.resourceId;
  // Users are made at prepare, as root (Mend does it through the platform's exec).
  for (const person of [PERSON, OTHER]) {
    await sh(
      containerId,
      `useradd -u ${String(person.uid)} -g mend -m -d ${person.home} -s /bin/sh ${person.name}`,
    );
  }
}, 240_000);

afterAll(async () => {
  if (containerId !== "") await docker(["rm", "-f", containerId]).catch(() => undefined);
  await Promise.all(
    Array.from(temporaryDirectories, (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!appliesAsUser)(
  "a person's dotfiles applied as their user, on a per-person image",
  () => {
    it("stages, applies as the person into their home only, runs install.sh as them, cleans up", async () => {
      const root = [...temporaryDirectories][0] ?? tmpdir();
      const archives = [
        {
          data: await tarball(root, {
            ".dotfiles-marker": "alice's dotfiles\n",
            ".config/app/settings.toml": "theme = 'dark'\n",
            "install.sh":
              '#!/bin/sh\nprintf "%s %s %s" "$(id -u)" "$HOME" "$(id -gn)" > "$HOME/.install-ran"\necho installed-as-$(id -un)\n',
          }),
          manager: "copy" as const,
          bootstrap: true,
        },
      ];
      const stageId = `run_${randomUUID().replaceAll("-", "")}`;
      const target = sealantTargetForDockerContainer(containerId);
      const staged = await Effect.runPromise(
        liveDotfilesStageChannel.stage(
          target,
          buildDotfilesStageScript({
            user: PERSON.name,
            home: PERSON.home,
            stageId,
            archiveCount: archives.length,
          }),
          dotfilesStageStdin(archives),
        ),
      );
      expect(staged).toEqual({ supported: true, exitCode: 0 });
      expect(await sh(containerId, `stat -c '%u %a' ${dotfilesStagePath(stageId)}`)).toBe("0 700");

      const executionId = `e2e-${stageId}`;
      const { applied, events } = await withDaemon(containerId, (session) =>
        Effect.gen(function* () {
          const answer = yield* session.dotfilesApply({
            user: PERSON.name,
            archiveDir: dotfilesStagePath(stageId),
            executionId,
          });
          const bootstrap = answer.bootstrap;
          if (bootstrap === undefined) return { applied: answer, events: [] };
          const collected = yield* session.events.pipe(
            Stream.filter((event: EventEnvelope) => event.executionId === executionId),
            Stream.takeUntil(
              (event: EventEnvelope) =>
                event.payload.case === "processExited" && event.processId === bootstrap.processId,
            ),
            Stream.runCollect,
          );
          return { applied: answer, events: Array.from(collected) };
        }),
      );
      expect(applied.user).toBe(PERSON.name);
      expect(applied.home).toBe(PERSON.home);
      expect(applied.bootstrap).toBeDefined();
      let stdout = "";
      let exitCode: number | undefined;
      for (const event of events) {
        const payload = event.payload;
        if (
          payload.case === "ioChunk" &&
          payload.value.stream === StreamKind.STDOUT &&
          payload.value.content !== undefined
        ) {
          stdout += Buffer.from(payload.value.content).toString("utf8");
        } else if (payload.case === "processExited") {
          exitCode = payload.value.exitCode;
        }
      }
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`installed-as-${PERSON.name}`);

      // Every file is the person's, in their home; install.sh ran as them, with their HOME.
      expect(
        await sh(
          containerId,
          `stat -c '%u' ${PERSON.home}/.dotfiles-marker ${PERSON.home}/.config/app/settings.toml ${PERSON.home}/.install-ran`,
        ),
      ).toBe(`${String(PERSON.uid)}\n${String(PERSON.uid)}\n${String(PERSON.uid)}`);
      expect(await sh(containerId, `cat ${PERSON.home}/.install-ran`)).toBe(
        `${String(PERSON.uid)} ${PERSON.home} mend`,
      );
      // Nobody else's home, and not root's.
      expect(
        await sh(
          containerId,
          `ls -A ${OTHER.home} | grep -c dotfiles-marker || true; [ -e /root/.dotfiles-marker ] && echo root-touched || echo root-clean`,
        ),
      ).toBe("0\nroot-clean");

      // The cleanup removes the staged archives.
      await Effect.runPromise(
        liveDotfilesStageChannel.run(target, buildDotfilesCleanupScript(stageId)),
      );
      expect(
        await sh(containerId, `[ -e ${dotfilesStagePath(stageId)} ] && echo kept || echo gone`),
      ).toBe("gone");
    }, 180_000);

    it("follows a link the person planted only as them: another person's home is never written", async () => {
      // sealantd#149 (0.20.0-next.152): root unpacks outside every home and writes inside it as the
      // person, so a link into another person's 0700 home fails the apply instead of writing there.
      await sh(
        containerId,
        `mkdir -p ${OTHER.home}/.config && chown ${OTHER.name}:mend ${OTHER.home}/.config && chmod 700 ${OTHER.home} && rm -rf ${PERSON.home}/.config && ln -s ${OTHER.home}/.config ${PERSON.home}/.config && chown -h ${PERSON.name}:mend ${PERSON.home}/.config`,
      );
      const root = [...temporaryDirectories][0] ?? tmpdir();
      const archives = [
        {
          data: await tarball(root, { ".config/planted/settings.toml": "theme = 'light'\n" }),
          manager: "copy" as const,
          bootstrap: false,
        },
      ];
      const stageId = `run_${randomUUID().replaceAll("-", "")}`;
      const target = sealantTargetForDockerContainer(containerId);
      const staged = await Effect.runPromise(
        liveDotfilesStageChannel.stage(
          target,
          buildDotfilesStageScript({
            user: PERSON.name,
            home: PERSON.home,
            stageId,
            archiveCount: archives.length,
          }),
          dotfilesStageStdin(archives),
        ),
      );
      expect(staged).toEqual({ supported: true, exitCode: 0 });
      const applied = await withDaemon(containerId, (session) =>
        session
          .dotfilesApply({
            user: PERSON.name,
            archiveDir: dotfilesStagePath(stageId),
            executionId: `e2e-${stageId}`,
          })
          .pipe(Effect.result),
      );
      await Effect.runPromise(
        liveDotfilesStageChannel.run(target, buildDotfilesCleanupScript(stageId)),
      );
      expect(Result.isFailure(applied)).toBe(true);
      expect(
        await sh(
          containerId,
          `[ -e ${OTHER.home}/.config/planted ] && echo written || echo untouched`,
        ),
      ).toBe("untouched");
    }, 60_000);

    it("refuses an unknown user, another person's home, and root", async () => {
      const target = sealantTargetForDockerContainer(containerId);
      const stage = (user: string, home: string) =>
        Effect.runPromise(
          liveDotfilesStageChannel.stage(
            target,
            buildDotfilesStageScript({ user, home, archiveCount: 0 }),
            "",
          ),
        );
      expect(await stage("nobody-here", "/home/nobody-here")).toEqual({
        supported: true,
        exitCode: DOTFILES_STAGE_EXIT.unknownUser,
      });
      expect(await stage(PERSON.name, OTHER.home)).toEqual({
        supported: true,
        exitCode: DOTFILES_STAGE_EXIT.homeMismatch,
      });
      // A refusal exits before it reads the archives on stdin: the exit code is still the answer.
      const withArchives = await Effect.runPromise(
        liveDotfilesStageChannel.stage(
          target,
          buildDotfilesStageScript({
            user: "nobody-here",
            home: "/home/nobody-here",
            stageId: "run_refused",
            archiveCount: 1,
          }),
          dotfilesStageStdin([
            { data: Buffer.alloc(2 * 1024 * 1024, 7).toString("base64"), bootstrap: true },
          ]),
        ),
      );
      expect(withArchives).toEqual({ supported: true, exitCode: DOTFILES_STAGE_EXIT.unknownUser });
      expect(
        await sh(containerId, "[ -e /run/sealant-dotfiles/run_refused ] && echo kept || echo none"),
      ).toBe("none");
      // The builder refuses root before anything runs; the daemon refuses it on its own too.
      expect(() =>
        buildDotfilesStageScript({ user: "root", home: "/root", archiveCount: 0 }),
      ).toThrow(/never applied as root/);
      const asRoot = await withDaemon(containerId, (session) =>
        session
          .dotfilesApply({
            user: "root",
            repository: { url: "https://example.invalid/dots.git", bootstrap: false },
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(asRoot)).toBe(true);
      expect(
        await sh(containerId, "[ -e /root/.local/share/chezmoi ] && echo cloned || echo none"),
      ).toBe("none");
    }, 60_000);
  },
);
