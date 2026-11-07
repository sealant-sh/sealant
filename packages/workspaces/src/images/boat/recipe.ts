import type { WorkspaceBlueprint } from "@sealant/validators";
import { z } from "zod";

import { nativeWorkspaceInstallation } from "../../buildkit/buildkit-builder.js";
import { nixDaemonStartCommands, NIX_PROFILE } from "../../buildkit/person-layout.js";
import { readNativeAssets } from "./assets.js";
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
  systemd: {
    version: "255.4-1ubuntu8.16",
    snapshot: "https://snapshot.ubuntu.com/ubuntu/20260731T000000Z/",
    index: "dists/noble-updates/main/binary-amd64/Packages.gz",
    indexSha256: "f5272e19da9bf902d3e6ccb9878261086bad3cfbb4937f060984cfdc33b71b22",
    package: "pool/main/s/systemd/systemd-container_255.4-1ubuntu8.16_amd64.deb",
    sha256: "7ab146ac98bf9c6095935b37a906d589795105c301626f2fd5db6d0e77bd9472",
  },
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
  readonly mappedRoot: "/var/lib/sealant/workspace-root";
  readonly guestRoot: "/var/lib/sealant/guest";
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Boat restores its base systemd executable. Keep its outer libraries at the same version.
const systemdSnapshotDownload = `import gzip,hashlib,json,pathlib,sys,urllib.request
pin=json.loads(sys.argv[1])
def fetch(path, expected):
    with urllib.request.urlopen(pin['snapshot']+path,timeout=60) as response:
        raw=response.read(20_000_001)
    if len(raw)>20_000_000 or hashlib.sha256(raw).hexdigest()!=expected:
        raise ValueError('native-systemd-snapshot-digest-mismatch')
    return raw
index=gzip.decompress(fetch(pin['index'],pin['indexSha256'])).decode()
entries=[dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' ')) for block in index.split('\\n\\n') if block.startswith('Package: systemd-container\\n')]
if len(entries)!=1 or any(entries[0].get(key)!=value for key,value in {'Version':pin['version'],'Filename':pin['package'],'SHA256':pin['sha256']}.items()):
    raise ValueError('native-systemd-snapshot-package-mismatch')
pathlib.Path(sys.argv[2]).write_bytes(fetch(pin['package'],entries[0]['SHA256']))
`;
const nativeNodeDownload = `import hashlib,json,pathlib,sys,urllib.request
pin=json.loads(sys.argv[1])
with urllib.request.urlopen(pin['archive'],timeout=60) as response:
    data=response.read(100_000_001)
if len(data)>100_000_000 or hashlib.sha256(data).hexdigest()!=pin['sha256']:
    raise ValueError('native-node-archive-digest-mismatch')
pathlib.Path(sys.argv[2]).write_bytes(data)
`;
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
  "snapshot_directory=$(mktemp -d -t sealant-systemd.XXXXXX)",
  'trap \'ls -la "$snapshot_directory"; rm -rf "$snapshot_directory"\' EXIT',
  `python3 -I -S -B -c ${quote(systemdSnapshotDownload)} ${quote(JSON.stringify(NATIVE_SUBSTRATE.systemd))} "$snapshot_directory/systemd-container.deb"`,
  "apt-get update",
  'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends debootstrap python3 xz-utils libstdc++6 uidmap iproute2 nftables wireguard-tools procps util-linux "$snapshot_directory/systemd-container.deb"',
  `test "$(dpkg-query -W -f='\${Version}' systemd-container)" = ${quote(NATIVE_SUBSTRATE.systemd.version)}`,
  "apt-mark hold systemd-container",
  'test "$systemd_versions" = "$(dpkg-query -W -f=\'${binary:Package}=${Version}\\n\' "${systemd_packages[@]}")"',
];
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
  "install -d /etc/systemd/system",
  "ln -sfn /dev/null /etc/systemd/system/nix-daemon.socket",
  "ln -sfn /dev/null /etc/systemd/system/nix-daemon.service",
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
  options: { readonly assetsDirectory?: string } = {},
): Promise<NativeResult<NativeRecipe>> => {
  try {
    const shared = nativeWorkspaceInstallation(spec);
    const path = `/usr/local/bin:${shared.family === "nix" ? `${NIX_PROFILE}/bin:` : ""}/usr/sbin:/usr/bin:/sbin:/bin`;
    const bootEntries = [...shared.bootEntries, ["PATH", path] as const];
    const loaded = await readNativeAssets(options.assetsDirectory);
    if (!loaded.ok) return loaded;
    const asset = (name: string): Uint8Array => {
      const bytes = loaded.value.get(name);
      if (bytes === undefined) throw new NativeBuildError("native-packaged-asset-missing");
      return bytes;
    };
    const guestRoot = "/var/lib/sealant/guest" as const;
    const mappedRoot = "/var/lib/sealant/workspace-root" as const;
    const guestCommand = `${guestRoot}/bundle/lib64/ld-linux-x86-64.so.2 --inhibit-cache --library-path ${guestRoot}/bundle/lib/x86_64-linux-gnu:${guestRoot}/bundle/usr/lib/x86_64-linux-gnu:${guestRoot}/bundle/usr/lib/x86_64-linux-gnu/systemd ${guestRoot}/bundle/usr/bin/python3 -I -S -B`;
    const projectScript =
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "umask 022",
        "export HOME=/root",
        "export NEEDRESTART_MODE=l",
        "export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "apt-get update",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl xz-utils ca-certificates procps",
        ...(shared.family === "nix" ? nixBootstrap : []),
        `export PATH=${quote(path)}`,
        shared.shell,
      ].join("\n") + "\n";
    const files = [
      ...bundle
        .files()
        .map((entry) =>
          file(
            entry.path.endsWith("control-relay.cjs") ? entry.path : mappedRoot + entry.path,
            entry.bytes,
            "0755",
          ),
        ),
      ...bundle
        .files()
        .filter((entry) => entry.path === "/usr/local/bin/sealantd")
        .map((entry) => file(`${guestRoot}/sealantd`, entry.bytes, "0755")),
      ...[
        "guest_boot.py",
        "guest_contract.py",
        "guest_receiver.py",
        "guest_invocation.py",
        "guest_network.py",
        "guest_readiness.py",
        "guest_control.py",
        "guest_recovery.py",
        "bootstrap-crypto.mjs",
        "build_guest.py",
        "workspace-launch.py",
        "boot-policy.json",
      ].map((name) =>
        file(`${guestRoot}/${name}`, asset(name), name === "workspace-launch.py" ? "0644" : "0600"),
      ),
      file("/etc/systemd/system/sealant-bootstrap.service", asset("bootstrap.service"), "0644"),
      file("/etc/systemd/system/sealant-control-relay.service", asset("relay.service"), "0644"),
      file("/etc/systemd/system/sealant-workspace.service", asset("workspace.service"), "0644"),
      file("/etc/systemd/system/sealant-recovery.service", asset("recovery.service"), "0644"),
      file("/etc/systemd/system/sealant-workspace.slice", asset("workspace.slice"), "0644"),
      file("/etc/systemd/system/sealant-held.service", asset("held.service"), "0644"),
      file("/etc/systemd/system/sealant-held-watchdog.service", asset("watchdog.service"), "0644"),
      file("/etc/systemd/system/sealant-held-watchdog.timer", asset("watchdog.timer"), "0644"),
      file(`${guestRoot}/project-install.sh`, projectScript, "0644"),
      file(
        `${mappedRoot}/etc/sealant/native-boot.json`,
        JSON.stringify(Object.fromEntries(bootEntries)) + "\n",
        "0600",
      ),
      file(
        `${mappedRoot}/usr/local/lib/sealant/native-nix-start`,
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
        `${guestRoot}/native-inputs.json`,
        JSON.stringify({
          assets: sha256(
            JSON.stringify(
              files.map((entry) => ({ path: entry.path, mode: entry.mode, sha256: entry.sha256 })),
            ),
          ),
          project: sha256(projectScript),
          runtime: sha256(JSON.stringify(bundle.identity)),
          policy: sha256(asset("boot-policy.json")),
        }) + "\n",
        "0600",
      ),
    );
    const installScript =
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "umask 022",
        "export HOME=/root",
        "export NEEDRESTART_MODE=l",
        "export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        'test "$(uname -m)" = x86_64',
        '. /etc/os-release; test "$ID" = ubuntu; test "$VERSION_ID" = 24.04',
        ...systemdBaseSetup,
        `install -d -m0700 ${guestRoot}`,
        "(",
        "node_directory=$(mktemp -d -t sealant-native-node.XXXXXX)",
        'trap \'ls -la "$node_directory"; rm -rf "$node_directory"\' EXIT',
        `python3 -I -S -B -c ${quote(nativeNodeDownload)} ${quote(JSON.stringify(NATIVE_SUBSTRATE.node))} "$node_directory/node.tar.xz"`,
        `tar -xJf "$node_directory/node.tar.xz" --to-stdout node-v${NATIVE_SUBSTRATE.node.version}-linux-x64/bin/node > ${guestRoot}/native-node`,
        `chmod 0755 ${guestRoot}/native-node`,
        ")",
        `install -d -m0755 ${mappedRoot}`,
        `test ! -e ${mappedRoot}/etc/os-release`,
        `debootstrap --variant=minbase --include=systemd,sudo,python3,util-linux,procps,iproute2,ca-certificates,git,libcap2-bin noble ${mappedRoot} http://archive.ubuntu.com/ubuntu`,
        "systemctl daemon-reload",
        `python3 -I -S -B ${guestRoot}/build_guest.py bundle`,
        `${guestCommand} ${guestRoot}/build_guest.py approve-source`,
        `${guestCommand} ${guestRoot}/guest_boot.py boot`,
        `python3 -I -S -B -c ${quote(`import json,pathlib; r=pathlib.Path('${guestRoot}'); b=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(); (r/'build-operation.json').write_text(json.dumps({'mode':'build','boot_id':b,'script':str(r/'project-install.sh'),'sha256':'${sha256(projectScript)}'}))`)}`,
        `chmod 0600 ${guestRoot}/build-operation.json`,
        `${guestCommand} ${guestRoot}/guest_boot.py build ${guestRoot}/build-operation.json`,
        `test -f ${mappedRoot}/etc/sealant/image-probe.json`,
        `test ! -e ${mappedRoot}/var/lib/sealant/control/launch.json`,
        "! systemctl is-active --quiet sealant-workspace.service",
        `test ! -e ${guestRoot}/receiver.json`,
        `test ! -e ${guestRoot}/invocation.json`,
        "test ! -e /run/sealant-bootstrap",
        'test "$(systemctl is-enabled sealant-bootstrap.service 2>/dev/null || true)" = static',
        'test "$(systemctl is-enabled sealant-control-relay.service 2>/dev/null || true)" = static',
        "systemctl enable sealant-held.service sealant-held-watchdog.timer",
        'test "$systemd_versions" = "$(dpkg-query -W -f=\'${binary:Package}=${Version}\\n\' "${systemd_packages[@]}")"',
      ].join("\n") + "\n";
    const content = {
      format: "sealant-native-recipe-v1" as const,
      family: shared.family,
      platform: "linux/amd64" as const,
      installScript,
      mappedRoot,
      guestRoot,
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
