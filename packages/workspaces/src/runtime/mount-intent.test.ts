/**
 * `collectMountIntents` is the runtime-neutral description the Kubernetes lowering consumes. These
 * tests pin its shape AND prove it agrees, pair for pair, with the `-v` arguments the Docker adapter
 * emits — so the two lowerings can never describe different mounts for the same launch.
 */
import { describe, expect, it, vi } from "vitest";

import { cases } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import {
  bindRootMountPath,
  bindableMountsEnv,
  bindsEnv,
  collectMountIntents,
  dockerBindArgsForIntent,
  STANDBY_ROOT_MOUNT_PATH,
} from "./mount-intent.js";
import type { RuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const blueprint = () => cases.mendMount;

describe("collectMountIntents", () => {
  it("describes launch material, the workspace and every extra mount, in adapter order", () => {
    const input = blueprint();
    expect(collectMountIntents(input)).toEqual([
      {
        sourcePath: "/run/sealant/sockets/_dotfiles/sealant-dotfiles-run-golden-2",
        mountPath: "/run/sealant/dotfiles",
        readOnly: true,
        purpose: "launch-material",
      },
      {
        sourcePath: "/run/sealant/sockets/_dotfiles/sealant-secret-env-run-golden-2",
        mountPath: "/run/sealant/secrets",
        readOnly: true,
        purpose: "launch-material",
      },
      {
        sourcePath: "/var/lib/mend/store/acme/worktrees/session-1",
        mountPath: "/workspace/repo",
        readOnly: false,
        purpose: "workspace",
      },
      {
        sourcePath: "/var/lib/mend/store/acme/repo.git",
        mountPath: "/var/lib/mend/store/acme/repo.git",
        readOnly: false,
        purpose: "git-common",
      },
      {
        sourcePath: "/var/lib/mend/store/_references/lib",
        mountPath: "/workspace/ref/lib",
        readOnly: true,
        purpose: "extra-mount",
      },
      {
        sourcePath: "/var/lib/mend/store/_run/sessions/1",
        mountPath: "/run/mend",
        readOnly: true,
        purpose: "extra-mount",
      },
    ]);
  });

  it("mounts a standby root hidden and a bindable mount's root at its own hidden path", () => {
    const base = blueprint();
    const input: RuntimeAdapterLaunchInput = {
      ...base,
      blueprint: {
        ...base.blueprint,
        sources: {
          ...base.blueprint.sources,
          workspace: { kind: "standby", rootPath: "/var/lib/mend/store/acme/worktrees" },
          mounts: [
            {
              hostPath: "/var/lib/mend/store/api/worktrees",
              mountPath: "/workspace/repos/api",
              readOnly: false,
              bindable: true,
            },
            {
              hostPath: "/var/lib/mend/store/_references/lib",
              mountPath: "/workspace/ref/lib",
              readOnly: true,
              bindable: false,
            },
          ],
        },
      },
    };
    const intents = collectMountIntents(input).filter((i) => i.purpose !== "launch-material");
    expect(intents).toEqual([
      {
        sourcePath: "/var/lib/mend/store/acme/worktrees",
        mountPath: STANDBY_ROOT_MOUNT_PATH,
        readOnly: false,
        purpose: "workspace-root",
      },
      {
        sourcePath: "/var/lib/mend/store/api/worktrees",
        mountPath: "/workspace/.roots/workspace__repos__api",
        readOnly: false,
        purpose: "extra-mount-root",
      },
      {
        sourcePath: "/var/lib/mend/store/_references/lib",
        mountPath: "/workspace/ref/lib",
        readOnly: true,
        purpose: "extra-mount",
      },
    ]);
    // Nothing is mounted at the working directory itself: the daemon binds it later.
    expect(intents.some((i) => i.mountPath === "/workspace/repo")).toBe(false);
    expect(bindRootMountPath("/workspace/repos/api")).toBe(
      "/workspace/.roots/workspace__repos__api",
    );
    expect(bindableMountsEnv(input.blueprint)).toBe(
      JSON.stringify([
        {
          mountPath: "/workspace/repos/api",
          rootMountPath: "/workspace/.roots/workspace__repos__api",
          hostRootPath: "/var/lib/mend/store/api/worktrees",
        },
      ]),
    );
    expect(bindableMountsEnv(base.blueprint)).toBeUndefined();
    expect(bindsEnv([{ mountPath: "/workspace/repo", subpath: "wt-1" }])).toBe(
      JSON.stringify([{ mountPath: "/workspace/repo", subpath: "wt-1" }]),
    );
    expect(bindsEnv([])).toBeUndefined();
  });

  it("emits nothing for a git-sourced workspace without extra mounts or launch material", () => {
    const input: RuntimeAdapterLaunchInput = cases.gitSource;
    expect(collectMountIntents(input)).toEqual([]);
  });

  it("agrees pair-for-pair with the Docker adapter's -v arguments", async () => {
    const input = blueprint();
    const commandRunner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "run") {
        return { stdout: "container-id\n", stderr: "" };
      }
      return {
        stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
        stderr: "",
      };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner,
      runtimeCatalogLoader: async () => ({
        defaultRuntime: "runc",
        runtimes: new Set(["runc", "runsc"]),
      }),
      mountAllowedStoreRoots: "/var/lib/mend/store",
    });
    await adapter.launch(input);

    const runArgs = commandRunner.mock.calls.find(([, args]) => args[0] === "run")?.[1] ?? [];
    const dockerBinds: string[] = [];
    for (let index = 0; index < runArgs.length; index += 1) {
      if (runArgs[index] === "-v") {
        dockerBinds.push(runArgs[index + 1] ?? "");
      }
    }
    const intentBinds = collectMountIntents(input).map(
      (intent) => dockerBindArgsForIntent(intent)[1],
    );
    expect(dockerBinds).toEqual(intentBinds);
  });
});
