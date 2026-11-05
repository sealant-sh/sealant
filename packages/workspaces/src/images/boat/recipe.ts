import { readFile } from "node:fs/promises";

import type { WorkspaceBlueprint } from "@sealant/validators";
import { z } from "zod";

import { nativeWorkspaceInstallation } from "../../buildkit/buildkit-builder.js";
import { nixDaemonStartCommands, NIX_PROFILE } from "../../buildkit/person-layout.js";
import {
  NativeBuildError,
  sha256,
  type NativeResult,
  type NativeRuntimeIdentity,
  type VerifiedRuntimeBundle,
} from "./runtime-bundle.js";

/** Immutable native bootstrap inputs. Nix runs on Boat's Ubuntu base, never NixOS. */
export const NATIVE_SUBSTRATE = {
  ubuntu: "24.04",
  nix: "2.31.2",
  nixArchive: "https://releases.nixos.org/nix/nix-2.31.2/nix-2.31.2-x86_64-linux.tar.xz",
  nixSha256: "d1f67c86eed016214864ba08bfb9529c307aea7e8fafb74853f96fcc3bfd8a60",
  nixpkgs: "1d060086d60cb76a40cf37109f979d88a5bd6396",
} as const;

/** Installed files carry their own bytes and checksum; no execution depends on an untracked file. */
export interface NativeRecipeFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: "0600" | "0644" | "0755";
  readonly sha256: string;
}

/** A native install plan, independent of Containerfile and generic OCI builder contracts. */
export interface NativeRecipe {
  readonly format: "sealant-native-recipe-v1";
  readonly family: "ubuntu" | "nix";
  readonly platform: "linux/amd64";
  readonly installScript: string;
  readonly files: readonly NativeRecipeFile[];
  readonly bootEntries: ReadonlyArray<readonly [string, string]>;
  readonly substrate: typeof NATIVE_SUBSTRATE;
  readonly runtime: NativeRuntimeIdentity;
  readonly assetsHash: string;
  readonly hash: string;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const NATIVE_NIX_DAEMON_READY_SECONDS = 90;
const NATIVE_NIX_PROBE_SECONDS = 15;
const file = (
  path: string,
  bytes: Uint8Array | string,
  mode: NativeRecipeFile["mode"],
): NativeRecipeFile => {
  const content = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return { path, bytes: content, mode, sha256: sha256(content) };
};

const nixBootstrap = [
  'test ! -e /nix || { echo "native-nix-existing-installation" >&2; exit 1; }',
  "d=$(mktemp -d -t sealant-nix-install.XXXXXX)",
  `curl -fsSL --retry 3 ${quote(NATIVE_SUBSTRATE.nixArchive)} -o "$d/nix.tar.xz"`,
  `echo '${NATIVE_SUBSTRATE.nixSha256}  '"$d/nix.tar.xz" | sha256sum -c -`,
  'tar -xJf "$d/nix.tar.xz" -C "$d"',
  `"$d/nix-${NATIVE_SUBSTRATE.nix}-x86_64-linux/install" --daemon --yes --no-channel-add`,
  "systemctl disable --now nix-daemon.socket nix-daemon.service",
  "systemctl mask nix-daemon.socket nix-daemon.service",
  "! pgrep -x nix-daemon",
  'ls -d "$d"',
  'rm -rf "$d"',
  `export PATH=/usr/local/bin:${NIX_PROFILE}/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  `nix --extra-experimental-features 'nix-command flakes' registry add nixpkgs github:NixOS/nixpkgs/${NATIVE_SUBSTRATE.nixpkgs}`,
];

/** Read the owned launcher assets and hash every command, generated file, and immutable input. */
export const createNativeRecipe = async (
  spec: WorkspaceBlueprint,
  bundle: Pick<VerifiedRuntimeBundle, "identity" | "files">,
): Promise<NativeResult<NativeRecipe>> => {
  try {
    const shared = nativeWorkspaceInstallation(spec);
    const path = `/usr/local/bin:${shared.family === "nix" ? `${NIX_PROFILE}/bin:` : ""}/usr/sbin:/usr/bin:/sbin:/bin`;
    const bootEntries = [...shared.bootEntries, ["PATH", path] as const];
    const [launcher, unit] = await Promise.all([
      readFile(new URL("../../../boat-image/workspace-launch.py", import.meta.url)),
      readFile(new URL("../../../boat-image/workspace.service", import.meta.url)),
    ]);
    const files = [
      ...bundle.files().map((f) => file(f.path, f.bytes, "0755")),
      file("/usr/local/lib/sealant/workspace-launch.py", launcher, "0755"),
      file("/etc/systemd/system/sealant-workspace.service", unit, "0644"),
      file(
        "/etc/sealant/native-boot.json",
        JSON.stringify(Object.fromEntries(bootEntries)) + "\n",
        "0600",
      ),
      file(
        "/usr/local/lib/sealant/native-nix-start",
        [
          "#!/bin/sh",
          "set -eu",
          ...nixDaemonStartCommands(NATIVE_NIX_DAEMON_READY_SECONDS, NATIVE_NIX_PROBE_SECONDS),
          `if ! NIX_REMOTE=daemon timeout -k 1 ${NATIVE_NIX_PROBE_SECONDS} nix --extra-experimental-features nix-command store info; then`,
          '  printf "nix=%s\\nnix-daemon=%s\\n" "$(command -v nix)" "$(command -v nix-daemon)" >&2',
          '  ps -o pid,ppid,stat,comm -p "$daemon" >&2 || true',
          '  readlink -f "/proc/$daemon/exe" >&2 || true',
          '  cat "/proc/$daemon/cgroup" >&2 || true',
          '  tail -n 60 "$log" >&2 || true',
          '  state=$(ps -o stat= -p "$daemon" || true)',
          '  case "$state" in ""|Z*) status=0; wait "$daemon" || status=$?; echo "nix-daemon exit=$status" >&2 ;; esac',
          "  exit 1",
          "fi",
        ].join("\n") + "\n",
        "0755",
      ),
    ];
    const installScript =
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "umask 022",
        "export HOME=/root",
        // Package upgrades must not restart Boat's outer services during preparation.
        "export NEEDRESTART_MODE=l",
        'test "$(uname -m)" = x86_64',
        '. /etc/os-release; test "$ID" = ubuntu; test "$VERSION_ID" = 24.04',
        "export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 util-linux curl xz-utils ca-certificates",
        ...(shared.family === "nix" ? nixBootstrap : []),
        `export PATH=${quote(path)}`,
        shared.shell,
        "install -d -m0700 /var/lib/sealant/control",
        "systemctl daemon-reload",
        "test ! -e /var/lib/sealant/control/launch.json",
        "test ! -e /var/lib/sealant/control/control.sock",
        "test ! -e /run/sealant/control.sock",
        "! systemctl is-active --quiet sealant-workspace.service",
        'case "$(systemctl is-enabled sealant-workspace.service || true)" in static|disabled) ;; *) exit 1 ;; esac',
        ...(shared.family === "nix"
          ? [
              "! systemctl is-active --quiet nix-daemon.service",
              'test "$(systemctl is-enabled nix-daemon.socket)" = masked',
              "! pgrep -x nix-daemon",
            ]
          : []),
      ].join("\n") + "\n";
    const content = {
      format: "sealant-native-recipe-v1" as const,
      family: shared.family,
      platform: "linux/amd64" as const,
      installScript,
      bootEntries,
      substrate: NATIVE_SUBSTRATE,
      runtime: bundle.identity,
      files: files.map((entry) => ({ path: entry.path, mode: entry.mode, sha256: entry.sha256 })),
    };
    return {
      ok: true,
      value: {
        ...content,
        files,
        assetsHash: sha256(JSON.stringify(content.files)),
        hash: sha256(JSON.stringify(content)),
      },
    };
  } catch (error) {
    const code = z.object({ code: z.string().regex(/^native-[a-z-]+$/) }).safeParse(error);
    return {
      ok: false,
      error: new NativeBuildError(code.success ? code.data.code : "native-invalid-recipe"),
    };
  }
};
