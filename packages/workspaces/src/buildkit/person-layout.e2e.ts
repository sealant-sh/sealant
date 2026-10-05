/**
 * The person layout in real managed images (Mend's ADR 0016, delivery 9), in containers started
 * from the built image, the way an executor runs it:
 *
 * - **Two people.** Prepare is done the way Mend and sealantd will do it: the group's default ACL on
 *   the image's shared directories, then `useradd` from `/etc/skel` with a uid from the reserved
 *   range and a 0700 home. Alice installs; Bob uses, extends and removes what she installed, with
 *   umask 0002: `npm i -g` without and with `sudo`, `pnpm add` against the shared store, `mise`,
 *   uv's Pythons, rustup and `cargo build`, Playwright's browsers, and git in one worktree.
 * - **No credential crosses.** Alice's `~/.npmrc` and cargo `credentials.toml` stay in her home:
 *   Bob cannot read them, and no shared directory holds them after her installs.
 * - **One person, as today.** Root, with no users made, still runs `npm i -g` and `cargo install`.
 *
 * Needs Docker and the network (npm, crates.io, GitHub releases, Playwright's CDN). Families come
 * from `SEALANT_PERSON_LAYOUT_E2E_FAMILIES` (default `arch,ubuntu,fedora`). Run with:
 *   pnpm --filter @sealant/workspaces test:e2e src/buildkit/person-layout.e2e.ts
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

import { parseWorkspaceBlueprint } from "@sealant/validators";
import type { WorkspaceImageProbe } from "@sealant/validators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileWorkspaceBuildSpec } from "./buildkit-builder.js";
import { imagePersonLayoutSupport } from "./person-layout.js";

const families = (process.env["SEALANT_PERSON_LAYOUT_E2E_FAMILIES"] ?? "arch,ubuntu,fedora")
  .split(",")
  .filter((family) => family.length > 0);

/** `docker <args>` with `input` on stdin; resolves with stdout and stderr whatever the exit. */
const docker = (
  args: readonly string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });

/** What a person runs, through `sudo`, to get a C linker for cargo: no image carries one. */
const INSTALL_CC: Readonly<Record<string, string>> = {
  arch: "pacman -S --noconfirm --needed gcc",
  ubuntu:
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gcc libc6-dev",
  fedora: "dnf -y -q install gcc",
};

const runScript = (image: string, family: string, script: string) =>
  docker(
    [
      "run",
      "--rm",
      "-i",
      "-e",
      `INSTALL_CC=${INSTALL_CC[family] ?? "false"}`,
      "--entrypoint",
      "/bin/bash",
      image,
      "-s",
    ],
    script,
  );

/** Prints `OK <name>` or `FAIL <name>` per check; the test asserts the whole list. */
const SCRIPT_PRELUDE = String.raw`
set -u
check() { local name=$1; shift; if "$@" >/tmp/check.log 2>&1; then echo "OK $name"; else echo "FAIL $name"; sed 's/^/    /' /tmp/check.log | tail -15; fi; }
`;

const TWO_PEOPLE = String.raw`
IFS=: read -ra dirs <<< "$SEALANT_PERSON_SHARED_DIRS"
setfacl -m g:mend:rwX -d -m g:mend:rwX "${"${dirs[@]}"}"
mkdir -p /workspace && chown root:mend /workspace && chmod 2775 /workspace
for spec in alice:40001 bob:40002; do
  useradd -u "${"${spec##*:}"}" -g mend -m -s /bin/bash "${"${spec%%:*}"}"
  chmod 0700 "/home/${"${spec%%:*}"}"
done
as() { local user=$1; shift; setpriv --reuid="$user" --regid=mend --init-groups -- env HOME="/home/$user" USER="$user" LOGNAME="$user" bash -c "umask 0002; cd ~; $*"; }

check skel-links test -L /home/alice/.cargo/registry -a -L /home/alice/.cargo/bin -a -d /home/alice/.cargo/registry/
check sudo-passwordless as alice 'sudo -n true'
check sudo-umask as alice '[ "$(sudo -n sh -c umask)" = 0002 ]'
check sudo-keeps-toolchain-env as alice 'sudo -n env | grep -qx npm_config_prefix=/opt/npm-global'

check npm-global-alice as alice 'npm i -g --silent cowsay@1.6.0 && [ -x /opt/npm-global/bin/cowsay ]'
check npm-global-bob-runs as bob 'cowsay hi'
check npm-global-bob-installs as bob 'npm i -g --silent is-odd@3.0.1'
check npm-global-bob-removes-alices as bob 'npm rm -g --silent cowsay && [ ! -e /opt/npm-global/bin/cowsay ]'
check npm-global-sudo as alice 'sudo -n npm i -g --silent is-number@7.0.0'
check npm-global-sudo-group-writable bash -c '[ -d /opt/npm-global/lib/node_modules/is-number ] && [ -z "$(find /opt/npm-global/lib/node_modules/is-number ! -perm -g+w)" ]'
check npm-global-bob-removes-sudos as bob 'npm rm -g --silent is-number'

check pnpm-alice as alice 'mkdir -p /workspace/a && cd /workspace/a && echo {} > package.json && pnpm add --silent is-number@7.0.0'
check pnpm-store-shared as bob 'pnpm store path | grep -q ^/var/cache/pnpm/'
check pnpm-bob-reuses as bob 'mkdir -p /workspace/b && cd /workspace/b && echo {} > package.json && out=$(pnpm add is-number@7.0.0 2>&1); echo "$out"; grep -q "downloaded 0" <<<"$out"'
check pnpm-bob-in-alices-project as bob 'cd /workspace/a && pnpm add --silent is-odd@3.0.1'

check mise-alice as alice 'mise use -g -y jq@1.7.1 && jq --version'
check mise-bob-reuses as bob 'mise use -g -y jq@1.7.1 && jq --version && [ "$(stat -c %U /opt/mise/installs/jq/1.7.1)" = alice ]'

check uv-python-alice as alice 'uv python install --quiet 3.12'
check uv-python-bob-reuses as bob 'uv run --no-project --python 3.12 python -c "import sys; assert sys.base_prefix.startswith(\"/opt/uv/python/\"), sys.base_prefix"'

check cc-through-sudo as alice 'sudo -n sh -c "$INSTALL_CC" && command -v cc'
check rustup-alice as alice 'curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --no-modify-path && [ -x /opt/rust/cargo/bin/cargo ] && [ -d /opt/rust/rustup/toolchains ]'
check cargo-build-bob as bob 'cargo new -q hello && cd hello && cargo add -q itoa@1 && cargo build -q && [ -n "$(ls /var/cache/cargo/registry/cache)" ]'
check cargo-build-alice-reuses-registry as alice 'cargo new -q hello && cd hello && cargo add -q --offline itoa@1 && cargo build -q --offline'

check playwright-alice as alice 'cd /workspace/a && npx -y playwright@1.63.0 install chromium-headless-shell >/dev/null && [ -n "$(ls /opt/ms-playwright)" ]'
check playwright-bob-reuses as bob 'cd /workspace/b && out=$(npx -y playwright@1.63.0 install chromium-headless-shell 2>&1); echo "$out"; ! grep -q Downloading <<<"$out" && [ -z "$(find /opt/ms-playwright -mindepth 1 -maxdepth 1 -user bob)" ]'

check git-two-people as alice 'git init -q /workspace/repo && cd /workspace/repo && git -c user.email=a@example.invalid -c user.name=a commit -q --allow-empty -m one'
check git-bob-in-alices-worktree as bob 'cd /workspace/repo && git status --short && git -c user.email=b@example.invalid -c user.name=b commit -q --allow-empty -m two'

as alice 'echo "//registry.npmjs.org/:_authToken=canary-alice-npm" > ~/.npmrc && printf "[registry]\ntoken = \"canary-alice-cargo\"\n" > ~/.cargo/credentials.toml && npm i -g --silent is-even@1.0.0 && cd ~/hello && cargo build -q --offline'
check credentials-private-npmrc as bob '! cat /home/alice/.npmrc'
check credentials-private-cargo as bob '! cat /home/alice/.cargo/credentials.toml'
check credentials-not-in-shared-dirs bash -c '! grep -rlI canary-alice /opt /var/cache'
`;

const ONE_PERSON = String.raw`
check root-npm-global bash -c 'npm i -g --silent cowsay@1.6.0 && cowsay hi'
check root-cargo-install bash -c 'sh -c "$INSTALL_CC" && curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --no-modify-path && . "$HOME/.cargo/env" && cargo new -q /tmp/hello && cargo install -q --path /tmp/hello && /root/.cargo/bin/hello'
`;

const TWO_PEOPLE_CHECKS = [
  ...TWO_PEOPLE.matchAll(/^check (\S+)/gm),
  ...ONE_PERSON.matchAll(/^check (\S+)/gm),
].map((match) => match[1]);

const blueprintFor = (family: string) =>
  parseWorkspaceBlueprint({
    sources: { workspace: { url: "https://example.invalid/repo.git", ref: "main" } },
    harness: { id: "claude-code" },
    target: { os: { family } },
    tooling: {
      packages: ["mise", "pnpm", "uv", "curl", "python"].map((id) => ({ id })),
      services: { docker: { enabled: true } },
    },
  });

for (const family of families) {
  describe(`the person layout in the ${family} image`, () => {
    let imageReference: string | undefined;
    let contextDirectory: string | undefined;
    let probe: WorkspaceImageProbe | undefined;

    beforeAll(async () => {
      const result = await compileWorkspaceBuildSpec({
        blueprint: blueprintFor(family),
        options: { emitTarball: false },
      });
      imageReference = result.buildkit.spec.imageReference;
      contextDirectory = result.buildkit.spec.contextDirectory;
      probe = result.metadata?.imageProbe;
    }, 1_200_000);

    afterAll(async () => {
      if (contextDirectory !== undefined)
        await rm(contextDirectory, { recursive: true, force: true });
    });

    it("records a probe that lacks only what its sealantd cannot report yet", () => {
      expect(probe).toBeDefined();
      if (probe === undefined) return;
      const support = imagePersonLayoutSupport(probe);
      expect(support.missing.filter((code) => !code.startsWith("sealantd:"))).toEqual([]);
    });

    it("lets two people share every toolchain and keeps each one's credentials", async () => {
      const outcome = await runScript(
        imageReference ?? "missing",
        family,
        SCRIPT_PRELUDE + TWO_PEOPLE,
      );
      const passed = outcome.stdout.match(/^OK \S+/gm) ?? [];
      expect(outcome.stdout).not.toMatch(/^FAIL /m);
      expect(passed.map((line) => line.slice(3))).toEqual(
        TWO_PEOPLE_CHECKS.filter((name) => !name?.startsWith("root-")),
      );
    }, 1_800_000);

    it("still serves one person as root, as today", async () => {
      const outcome = await runScript(
        imageReference ?? "missing",
        family,
        SCRIPT_PRELUDE + ONE_PERSON,
      );
      expect(outcome.stdout).not.toMatch(/^FAIL /m);
      expect(outcome.stdout).toContain("OK root-npm-global");
      expect(outcome.stdout).toContain("OK root-cargo-install");
    }, 900_000);
  });
}
