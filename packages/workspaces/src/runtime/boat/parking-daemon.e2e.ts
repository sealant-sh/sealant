import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import { z } from "zod";

import { docker } from "../../sealantd/boot.js";
import { SealantRuntime, SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { sealantTargetForDockerContainer } from "../../sealantd/target.js";
import { startCaptureChannel } from "../capture-channel.fixture.js";
import { parkingResumeLaunch } from "./parking-launch.js";

const logs = async (name: string) => {
  const result = await promisify(execFile)("docker", ["logs", name], { timeout: 5000 });
  return result.stdout + result.stderr;
};

it("the pinned daemon continues copied staging with a fresh epoch and unchanged user work, without replaying hooks", async () => {
  const bundle = process.env.SEALANT_BOAT_RUNTIME_BUNDLE;
  const pinned =
    process.env.SEALANTD_BIN ?? (bundle === undefined ? undefined : join(bundle, "sealantd"));
  if (pinned === undefined)
    throw new Error(
      "SEALANTD_BIN or SEALANT_BOAT_RUNTIME_BUNDLE must contain the exact pinned daemon",
    );
  const scratch = await mkdtemp(join(tmpdir(), "boat-parking-daemon-"));
  const containers = new Set<string>();
  const launchId = `parking-${randomUUID()}`;
  const worktreeId = `worktree-${randomUUID()}`;
  const token = "local-parking-proof-only";
  const channel = await startCaptureChannel({ token, worktreeId, executor: launchId });
  const binary = join(scratch, "sealantd");
  const source = join(scratch, "source");
  const restored = join(scratch, "restored");
  const env = {
    SEALANT_WORKSPACE_SOURCE: "capture",
    SEALANT_CAPTURE_ENDPOINT: channel.endpoint,
    SEALANT_SECRET_ENV_FILE: "/run/sealant-inputs/secret-env",
    SEALANT_CAPTURE_WORKTREE_ID: worktreeId,
    SEALANT_CAPTURE_LAUNCH_ID: launchId,
    SEALANT_CAPTURE_ALLOW_PLAINTEXT: "1",
    SEALANT_WORKSPACE_ROOT: "/workspace",
    SEALANT_WORKING_DIRECTORY: "/workspace/repo",
    SEALANT_CONTROL_SOCKET: "/run/sealant/control.sock",
    SEALANT_OS_FAMILY: "ubuntu",
    SEALANT_LIFECYCLE_SETUP_JSON: JSON.stringify([
      { run: "printf setup >> /workspace/setup-count", shell: "sh" },
    ]),
    SEALANT_FOREGROUND_COMMAND: "printf harness >> /workspace/harness-count; sleep infinity",
  };

  const boot = async (
    directory: string,
    environment: Readonly<Record<string, string>>,
    secrets: Uint8Array,
  ) => {
    const name = `boat-parking-daemon-${randomUUID()}`;
    containers.add(name);
    const secretFile = join(scratch, name + ".json");
    await writeFile(secretFile, secrets, { mode: 0o600 });
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "sealant-proof=boat-automatic-parking-20261108",
      "--network",
      "host",
      "--mount",
      `type=bind,src=${binary},dst=/usr/local/bin/sealantd,readonly`,
      "--mount",
      `type=bind,src=${secretFile},dst=/run/sealant-inputs/secret-env,readonly`,
      "--mount",
      `type=bind,src=${directory},dst=/workspace`,
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "--entrypoint",
      "/usr/local/bin/sealantd",
      "sealant-workspace-ubuntu:latest",
      "boot",
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const running = await docker(["inspect", "--format", "{{.State.Running}}", name]);
      if (running !== "true")
        throw new Error(
          `Pinned parking daemon boot failed: ${await docker(["inspect", "--format", "{{json .State}}", name])}; ${await logs(name)}`,
        );
      try {
        await docker(["exec", name, "test", "-S", "/run/sealant/control.sock"]);
        return name;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`Pinned parking daemon readiness timed out: ${await logs(name)}`);
  };
  try {
    await copyFile(pinned, binary);
    await chmod(binary, 0o700);
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe("cea5952d9e2b0fa45443adf925c8aaebaa6c2a50eb51cb02ffc2f9ef4083e969");
    await mkdir(source);
    const first = await boot(
      source,
      env,
      Buffer.from(JSON.stringify({ SEALANT_CAPTURE_TOKEN: token })),
    );
    await docker(["exec", first, "sh", "-c", "printf staged > /workspace/repo/work"]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(sealantTargetForDockerContainer(first));
          yield* session.captureFlush();
        }),
      ).pipe(Effect.provide(SealantRuntimeControlLive)),
    );
    expect(channel.state.head).toBeDefined();
    await docker([
      "exec",
      first,
      "sh",
      "-c",
      "printf unsent-user-edit > /workspace/repo/work; printf private > /workspace/repo/never-uploaded",
    ]);
    // The outside closure/capsule proof covers live namespace exclusion; this proof starts after it.
    await docker(["kill", "--signal", "KILL", first]);
    await docker(["rm", first]);
    containers.delete(first);
    await mkdir(restored);
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=bind,src=${source},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${restored},dst=/restored`,
      "ubuntu:24.04",
      "cp",
      "-a",
      "/source/.",
      "/restored/",
    ]);
    channel.state.epoch = 2;
    const wire = await Effect.runPromise(
      parkingResumeLaunch(
        Redacted.make(
          Buffer.from(JSON.stringify({ format: "sealant-daemon-launch-v1", boot_env: env })),
        ),
        Redacted.make({ endpoint: channel.endpoint, token, worktreeId, launchId }),
      ),
    );
    const value: unknown = JSON.parse(Buffer.from(Redacted.value(wire).launch).toString("utf8"));
    const parsed = z.object({ boot_env: z.record(z.string(), z.string()) }).parse(value);
    const second = await boot(restored, parsed.boot_env, Redacted.value(wire).secretEnv);
    expect(await docker(["exec", second, "cat", "/workspace/repo/work"])).toBe("unsent-user-edit");
    expect(await docker(["exec", second, "cat", "/workspace/repo/never-uploaded"])).toBe("private");
    expect(await docker(["exec", second, "cat", "/workspace/setup-count"])).toBe("setup");
    expect(await docker(["exec", second, "cat", "/workspace/harness-count"])).toBe("harness");
    expect(await logs(second)).toContain("capture resumed on this disk");
    expect(channel.state.errors).toEqual([]);
  } finally {
    for (const name of containers) {
      await docker(["rm", "-f", name]);
      expect(await docker(["ps", "-aq", "--filter", `name=^/${name}$`])).toBe("");
    }
    await channel.close();
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=bind,src=${scratch},dst=/owned`,
      "ubuntu:24.04",
      "chown",
      "-R",
      "--no-dereference",
      `${process.getuid?.()}:${process.getgid?.()}`,
      "/owned",
    ]);
    console.log({ ownedScratch: scratch, entries: await readdir(scratch) });
    await rm(scratch, { recursive: true });
  }
}, 60_000);
