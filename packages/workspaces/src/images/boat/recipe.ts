import type { WorkspaceBlueprint } from "@sealant/validators";
import { z } from "zod";

import { nativeWorkspaceInstallation } from "../../buildkit/buildkit-builder.js";
import { nixDaemonStartCommands, NIX_PROFILE } from "../../buildkit/person-layout.js";
import { BOAT_AGENT_FILES, BOAT_AGENT_MANIFEST_FILE } from "../../runtime/boat/agent-contract.js";
import { readNativeAssets, type NativeAssetDirectory } from "./assets.js";
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
  node: {
    version: "24.22.2",
    archive: "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz",
    sha256: "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75",
  },
  /** Boat restores its base systemd executable; the image keeps its libraries at that version. */
  systemd: { version: "255.4-1ubuntu8.16" },
} as const;

/** Where the agent and its Node live on the VM; the agent unit runs `node agent.mjs` from here. */
export const BOAT_AGENT_DIRECTORY = "/opt/sealant";
export const BOAT_AGENT_UNIT_PATH = "/etc/systemd/system/sealant-agent.service";
/** The drop-in that turns the agent's Docker service on, for a blueprint that asks for Docker. */
export const BOAT_AGENT_DOCKER_DROPIN_PATH =
  "/etc/systemd/system/sealant-agent.service.d/docker.conf";

/**
 * The `PATH` a native image declares: the one its project install runs with, the Nix profile
 * first on a Nix image (Nix runs on Boat's Ubuntu base, whose own `PATH` does not name it). A Nix
 * container gets the same from its image `PATH`.
 */
export const nativeImagePath = (family: "ubuntu" | "nix"): string =>
  `/usr/local/bin:${family === "nix" ? `${NIX_PROFILE}/bin:` : ""}/usr/sbin:/usr/bin:/sbin:/bin`;

/**
 * The boot environment a launch pushes to the agent, which starts sealantd with it over its own
 * environment: the shared installation's entries and, on a Nix image, the image's `PATH`. The
 * agent unit's `PATH` is Ubuntu's, so without it sealantd and every session it starts would not
 * find the profile's tools, and a session whose argv is a bare `zsh` (Mend's interactive shell)
 * could not start. An Ubuntu launch keeps the unit's `PATH`, as it always has.
 */
export const nativeLaunchBootEntries = (
  spec: WorkspaceBlueprint,
): ReadonlyArray<readonly [string, string]> => {
  const shared = nativeWorkspaceInstallation(spec);
  return shared.family === "nix"
    ? [...shared.bootEntries, ["PATH", nativeImagePath("nix")]]
    : shared.bootEntries;
};

/** Installed files carry their own bytes and checksum; no execution depends on an untracked file. */
export interface NativeRecipeFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: "0600" | "0644" | "0755";
  readonly sha256: string;
}

/** A native install plan, independent of Containerfile and generic OCI builder contracts. */
export interface NativeRecipe {
  readonly format: "sealant-native-recipe-v2";
  readonly family: "ubuntu" | "nix";
  readonly platform: "linux/amd64";
  readonly installScript: string;
  readonly files: readonly NativeRecipeFile[];
  readonly bootEntries: ReadonlyArray<readonly [string, string]>;
  readonly substrate: typeof NATIVE_SUBSTRATE;
  readonly runtime: NativeRuntimeIdentity;
  /** The blueprint asks for the workspace's own Docker: the image carries the engine. */
  readonly dockerService: boolean;
  /**
   * What the bind exchange must name (`manifest_digest`): the digest the image's
   * `/var/lib/sealant/agent/manifest.json` carries, over the agent files, the daemon and the unit.
   */
  readonly agentManifestDigest: string;
  readonly assetsHash: string;
  readonly hash: string;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const file = (
  path: string,
  bytes: Uint8Array | string,
  mode: NativeRecipeFile["mode"],
): NativeRecipeFile => {
  const content = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return { path, bytes: content, mode, sha256: sha256(content) };
};

/**
 * The one definition of the agent manifest digest: over the path, mode and bytes digest of every
 * file the agent is (its modules, the daemon it starts, the unit and drop-in that run it), in
 * path order. The image writes it to `manifest.json`; the builder's receipt carries the same
 * value; Core sends it in every bind request, and the bind CLI refuses any other.
 */
export const boatAgentManifestDigest = (
  files: ReadonlyArray<Pick<NativeRecipeFile, "path" | "mode" | "sha256">>,
): string =>
  sha256(
    JSON.stringify(
      files
        .map((entry) => ({ path: entry.path, mode: entry.mode, sha256: entry.sha256 }))
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );

const isAgentFile = (path: string) =>
  path.startsWith(`${BOAT_AGENT_DIRECTORY}/`) ||
  path === "/usr/local/bin/sealantd" ||
  path === BOAT_AGENT_UNIT_PATH ||
  path === BOAT_AGENT_DOCKER_DROPIN_PATH;

/**
 * `sealant-agent.service.d/docker.conf`: the agent's Docker service. Its bridge address and its
 * address pools are the one thing the image decides about the containers' network: ranges that
 * collide with neither the resource tunnel's addresses (`100.127.255.252/30`) nor the resource
 * subnets a tunnel routes (`SEALANT_RESOURCE_REACH_SUBNETS`, RFC 1918), so a container's traffic to
 * a linked resource is routed into the tunnel and not onto a Docker bridge. Nothing else is
 * programmed: what a container may reach on Boat's network is the deployment owner's own
 * infrastructure.
 */
const DOCKER_DROPIN = [
  "[Service]",
  "Environment=SEALANT_MICROVM_DOCKER_CAPABLE=1",
  "Environment=SEALANT_MICROVM_DOCKER_BIP=198.18.1.1/24",
  "Environment=SEALANT_MICROVM_DOCKER_ADDRESS_POOLS=base=198.19.0.0/16,size=24",
  "Environment=SEALANT_MICROVM_DOCKER_GROUP=docker",
  // The proved stop (container grace, Docker's own cgroups) is the Boat host mode's default.
  "",
].join("\n");

// The base systemd stays at the version Boat restores; every systemd binary package the base
// holds is checked and held before anything is installed, and checked again at the very end.
const systemdBaseSetup = [
  "mapfile -t systemd_packages < <(dpkg-query -W -f='${binary:Package} ${source:Package} ${db:Status-Status}\\n' | awk '$2 == \"systemd\" && $3 == \"installed\" {print $1}')",
  'test "${#systemd_packages[@]}" -gt 0',
  "systemd_versions=$(dpkg-query -W -f='${binary:Package}=${Version}\\n' \"${systemd_packages[@]}\")",
  `test "$(printf '%s\\n' "$systemd_versions" | cut -d= -f2 | sort -u)" = ${quote(NATIVE_SUBSTRATE.systemd.version)}`,
  ...["systemd", "systemd-sysv", "libsystemd0", "libsystemd-shared", "libudev1"].map(
    (name) =>
      `test "$(dpkg-query -W -f='\${Version}' ${name})" = ${quote(NATIVE_SUBSTRATE.systemd.version)}`,
  ),
  'apt-mark hold "${systemd_packages[@]}"',
  "apt-get update",
  // What the agent and the workspace's network need: WireGuard to the resource gateway, iptables
  // and kmod for dockerd's own NAT and bridges, `unshare` (util-linux) for the daemon's PID
  // namespace.
  "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl xz-utils ca-certificates procps util-linux iproute2 iptables kmod wireguard-tools",
  'test "$systemd_versions" = "$(dpkg-query -W -f=\'${binary:Package}=${Version}\\n\' "${systemd_packages[@]}")"',
];
const systemdUnchanged =
  'test "$systemd_versions" = "$(dpkg-query -W -f=\'${binary:Package}=${Version}\\n\' "${systemd_packages[@]}")"';
const NATIVE_NIX_DAEMON_READY_SECONDS = 90;
const NATIVE_NIX_PROBE_SECONDS = 15;

const nixBootstrap = [
  'test ! -e /nix || { echo "native-nix-existing-installation" >&2; exit 1; }',
  "d=$(mktemp -d -t sealant-nix-install.XXXXXX)",
  `curl -fsSL --retry 3 ${quote(NATIVE_SUBSTRATE.nixArchive)} -o "$d/nix.tar.xz"`,
  `echo '${NATIVE_SUBSTRATE.nixSha256}  '"$d/nix.tar.xz" | sha256sum -c -`,
  'tar -xJf "$d/nix.tar.xz" -C "$d"',
  `"$d/nix-${NATIVE_SUBSTRATE.nix}-x86_64-linux/install" --daemon --yes --no-channel-add`,
  "install -d /etc/systemd/system",
  "ln -sfn /dev/null /etc/systemd/system/nix-daemon.socket",
  "ln -sfn /dev/null /etc/systemd/system/nix-daemon.service",
  "! pgrep -x nix-daemon",
  'ls -d "$d"',
  'rm -rf "$d"',
  `export PATH=/usr/local/bin:${NIX_PROFILE}/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  `nix --extra-experimental-features 'nix-command flakes' registry add nixpkgs github:NixOS/nixpkgs/${NATIVE_SUBSTRATE.nixpkgs}`,
];

/** Read the shipped agent assets and hash every command, generated file, and immutable input. */
export const createNativeRecipe = async (
  spec: WorkspaceBlueprint,
  bundle: Pick<VerifiedRuntimeBundle, "identity" | "files">,
  options: { readonly assetsDirectory?: NativeAssetDirectory } = {},
): Promise<NativeResult<NativeRecipe>> => {
  try {
    const shared = nativeWorkspaceInstallation(spec);
    const dockerService = spec.tooling.services?.docker?.enabled === true;
    const path = nativeImagePath(shared.family);
    const bootEntries = [...shared.bootEntries, ["PATH", path] as const];
    const loaded = await readNativeAssets(options.assetsDirectory);
    if (!loaded.ok) return loaded;
    const asset = (name: string): Uint8Array => {
      const bytes = loaded.value.get(name);
      if (bytes === undefined) throw new NativeBuildError("native-packaged-asset-missing");
      return bytes;
    };
    // The project install runs on the VM's own root: there is no mapped root, the VM is the
    // workspace. Nix (when asked) is bootstrapped first, then the shared installation.
    const projectScript =
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "umask 022",
        "export HOME=/root",
        "export NEEDRESTART_MODE=l",
        "export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ...(shared.family === "nix" ? nixBootstrap : []),
        `export PATH=${quote(path)}`,
        shared.shell,
      ].join("\n") + "\n";
    const agentFiles = [
      ...bundle.files().map((entry) => file(entry.path, entry.bytes, "0755")),
      ...BOAT_AGENT_FILES.map((source) => {
        const name = source.slice(source.lastIndexOf("/") + 1);
        return file(`${BOAT_AGENT_DIRECTORY}/${name}`, asset(name), "0644");
      }),
      file(BOAT_AGENT_UNIT_PATH, asset("sealant-agent.service"), "0644"),
      ...(dockerService ? [file(BOAT_AGENT_DOCKER_DROPIN_PATH, DOCKER_DROPIN, "0644")] : []),
    ];
    const agentManifestDigest = boatAgentManifestDigest(
      agentFiles.filter((f) => isAgentFile(f.path)),
    );
    const files = [
      ...agentFiles,
      file(
        BOAT_AGENT_MANIFEST_FILE,
        JSON.stringify({ digest: agentManifestDigest }) + "\n",
        "0600",
      ),
      ...(dockerService
        ? [file(`${BOAT_AGENT_DIRECTORY}/download-docker.sh`, asset("download-docker.sh"), "0755")]
        : []),
      file(`${BOAT_AGENT_DIRECTORY}/project-install.sh`, projectScript, "0644"),
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
        ].join("\n") + "\n",
        "0755",
      ),
    ];
    files.push(
      file(
        "/etc/sealant/native-inputs.json",
        JSON.stringify({
          assets: sha256(
            JSON.stringify(
              files.map((entry) => ({ path: entry.path, mode: entry.mode, sha256: entry.sha256 })),
            ),
          ),
          project: sha256(projectScript),
          runtime: sha256(JSON.stringify(bundle.identity)),
          agent: agentManifestDigest,
        }) + "\n",
        "0600",
      ),
    );
    const installScript =
      [
        "#!/bin/bash",
        "set -Eeuo pipefail",
        `trap 'code=$?; printf "native recipe line %s exited %s\\n" "$LINENO" "$code" >&2' ERR`,
        "umask 022",
        "export HOME=/root",
        "export NEEDRESTART_MODE=l",
        "export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        'test "$(uname -m)" = x86_64',
        '. /etc/os-release; test "$ID" = ubuntu; test "$VERSION_ID" = 24.04',
        ...systemdBaseSetup,
        `install -d -m0755 ${BOAT_AGENT_DIRECTORY}`,
        // The pinned upstream Node runs the agent: Ubuntu's node loads externalized built-ins
        // from /usr/share and cannot be relied on, and the image must not depend on a distro
        // package the project install may later change.
        "(",
        "node_directory=$(mktemp -d -t sealant-native-node.XXXXXX)",
        'trap \'ls -la "$node_directory"; rm -rf "$node_directory"\' EXIT',
        `curl -fsSL --retry 3 ${quote(NATIVE_SUBSTRATE.node.archive)} -o "$node_directory/node.tar.xz"`,
        `echo '${NATIVE_SUBSTRATE.node.sha256}  '"$node_directory/node.tar.xz" | sha256sum -c - >/dev/null`,
        `tar -xJf "$node_directory/node.tar.xz" --to-stdout node-v${NATIVE_SUBSTRATE.node.version}-linux-x64/bin/node > ${BOAT_AGENT_DIRECTORY}/node`,
        `chmod 0755 ${BOAT_AGENT_DIRECTORY}/node`,
        `${BOAT_AGENT_DIRECTORY}/node --version`,
        ")",
        // The agent's data directory is private: the bind and launch records live there.
        "install -d -m0700 /var/lib/sealant/agent",
        "chmod 0700 /var/lib/sealant/agent",
        `test -f ${BOAT_AGENT_MANIFEST_FILE}`,
        ...(dockerService
          ? [
              `${BOAT_AGENT_DIRECTORY}/download-docker.sh`,
              "install -d -m0700 /var/lib/sealant/docker",
              "/usr/local/bin/dockerd --version",
            ]
          : []),
        `/bin/bash ${BOAT_AGENT_DIRECTORY}/project-install.sh`,
        "test -f /etc/sealant/image-probe.json",
        "systemctl daemon-reload",
        "systemctl enable sealant-agent.service",
        'test "$(systemctl is-enabled sealant-agent.service)" = enabled',
        // The agent runs on the snapshot's own boots, never on the build VM: nothing is bound or
        // launched when the image is saved.
        "! systemctl is-active --quiet sealant-agent.service",
        "test ! -e /var/lib/sealant/agent/bind.json",
        "test ! -e /var/lib/sealant/agent/launch.json",
        "test ! -e /var/lib/sealant/agent/network.json",
        systemdUnchanged,
      ].join("\n") + "\n";
    const content = {
      format: "sealant-native-recipe-v2" as const,
      family: shared.family,
      platform: "linux/amd64" as const,
      installScript,
      bootEntries,
      substrate: NATIVE_SUBSTRATE,
      runtime: bundle.identity,
      dockerService,
      agentManifestDigest,
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
