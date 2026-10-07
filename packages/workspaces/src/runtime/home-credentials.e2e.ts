/**
 * pi's and opencode's ChatGPT logins written into a person's home by the home script, over the live
 * control channel, on a per-person image (Mend's ADR 0016 decisions 5 and 8a):
 *
 * 1. Into Mend's person layout: opencode's data directory lives in the person's saved directory
 *    under `/workspace`, and its `auth.json` there is a link back to `~/.mend/opencode/auth.json`.
 *    The login lands at the end of the links, in the home, as the person, 0600; the link in saved
 *    state stays a link. pi's entry is merged beside a login the person already had.
 * 2. A release removes only Core's copies; the person's own logins stay.
 * 3. Where the file really is inside `/workspace` (a plain file in the saved directory), the put is
 *    refused and nothing is written there.
 * 4. While every login is put, again and again, root watching every process's argv and environment
 *    never sees one; a whole-file login with another hard link is refused, its other name untouched.
 *
 * Image: `SEALANT_HOME_CREDENTIALS_E2E_IMAGE`, default `sealant-workspace-fedora:latest`. Run with:
 *   pnpm --filter @sealant/workspaces test:e2e src/runtime/home-credentials.e2e.ts
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertImageRequirement, docker, isImagePresent } from "../sealantd/boot.js";
import { sealantTargetForDockerContainer } from "../sealantd/target.js";
import {
  buildHomeCredentialScript,
  HOME_SCRIPT_EXIT,
  homeScriptStdin,
  liveHomeCredentialChannel,
  type HomeCredentialProvider,
  type HomeWriteFence,
} from "./home-credentials.js";
import { DockerRuntimeAdapter, parseRuntimeAdapterLaunchInput } from "./index.js";

const IMAGE_REF =
  process.env["SEALANT_HOME_CREDENTIALS_E2E_IMAGE"] ?? "sealant-workspace-fedora:latest";
const PERSON = { name: "m4lice000", uid: 40001, home: "/home/m4lice000" };
const SAVED = "/workspace/harness-home/people/acct_a";
const COPY = "sealant-copy-cannot-refresh";

const imageAvailable = await isImagePresent(IMAGE_REF);
assertImageRequirement(imageAvailable);

const temporaryDirectories = new Set<string>();
let containerId = "";
let token = 0;

const sh = (script: string) => docker(["exec", containerId, "sh", "-c", script]);

const entry = (access: string) =>
  JSON.stringify({ type: "oauth", access, refresh: COPY, expires: 1, accountId: "acct_1" });

/** A grep pattern for `needle` that does not match itself (in the watcher's own argv). */
const bracketed = (needle: string) => `${needle.slice(0, -1)}[${needle.slice(-1)}]`;

const runHomeScript = (input: {
  readonly fence: HomeWriteFence;
  readonly writes: ReadonlyArray<{
    readonly provider: HomeCredentialProvider;
    readonly content: string;
  }>;
}) => {
  token += 1;
  return Effect.runPromise(
    liveHomeCredentialChannel.run(
      sealantTargetForDockerContainer(containerId),
      buildHomeCredentialScript({
        home: PERSON.home,
        fence: input.fence,
        token: String(token),
        writes: input.writes.map(({ provider }) => provider),
        removes: [],
      }),
      homeScriptStdin(input.writes.map(({ content }) => content)),
    ),
  );
};

beforeAll(async () => {
  if (!imageAvailable) return;
  const storeRoot = await mkdtemp(join(tmpdir(), "sealant-home-credentials-e2e-"));
  temporaryDirectories.add(storeRoot);
  const worktree = join(storeRoot, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "README.md"), "home credentials e2e\n");
  const adapter = new DockerRuntimeAdapter({
    autoRemove: false,
    containerNamePrefix: "sealant-home-credentials-e2e",
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
      runId: `home-credentials-e2e-${randomUUID()}`,
    }),
  );
  containerId = launched.resourceId;
  const u = `${String(PERSON.uid)}:40000`;
  // Mend's person layout, as its prepare makes it: the person, their saved directory holding
  // opencode's data directory, the home's link to it, and auth.json there linking back home.
  await sh(
    [
      `useradd -u ${String(PERSON.uid)} -g mend -m -d ${PERSON.home} -s /bin/sh ${PERSON.name}`,
      `mkdir -p ${SAVED}/.local/share/opencode ${PERSON.home}/.local/share ${PERSON.home}/.mend/opencode ${PERSON.home}/.pi/agent`,
      `ln -s ${SAVED}/.local/share/opencode ${PERSON.home}/.local/share/opencode`,
      `ln -s ${PERSON.home}/.mend/opencode/auth.json ${SAVED}/.local/share/opencode/auth.json`,
      `printf '%s' '{"anthropic":{"type":"api","key":"sk-own"}}' > ${PERSON.home}/.pi/agent/auth.json`,
      `chown -hR ${u} ${SAVED} ${PERSON.home}`,
    ].join(" && "),
  );
}, 240_000);

afterAll(async () => {
  if (containerId !== "") await docker(["rm", "-f", containerId]).catch(() => undefined);
  await Promise.all(
    Array.from(temporaryDirectories, (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!imageAvailable)(
  "pi's and opencode's logins in a person's home, on a per-person image",
  () => {
    it("merges both logins as the person, through Mend's links, and a release removes only the copies", async () => {
      const put = await runHomeScript({
        fence: { kind: "take", generation: "generation-alice" },
        writes: [
          { provider: "pi", content: entry("at-pi") },
          { provider: "opencode", content: entry("at-oc") },
        ],
      });
      expect(put.exitCode).toBe(0);
      const pi = JSON.parse(await sh(`cat ${PERSON.home}/.pi/agent/auth.json`));
      expect(pi).toEqual({
        anthropic: { type: "api", key: "sk-own" },
        "openai-codex": JSON.parse(entry("at-pi")),
      });
      // The login is at the end of the links, in the home, the person's, 0600.
      expect(await sh(`stat -c '%u %a' ${PERSON.home}/.mend/opencode/auth.json`)).toBe(
        `${String(PERSON.uid)} 600`,
      );
      expect(JSON.parse(await sh(`cat ${PERSON.home}/.mend/opencode/auth.json`))).toEqual({
        openai: JSON.parse(entry("at-oc")),
      });
      // Saved state holds a link, never a login.
      expect(
        await sh(`[ -L ${SAVED}/.local/share/opencode/auth.json ] && echo link || echo file`),
      ).toBe("link");

      const released = await runHomeScript({
        fence: { kind: "release", generation: "generation-alice" },
        writes: [],
      });
      expect(released.exitCode).toBe(0);
      expect(JSON.parse(await sh(`cat ${PERSON.home}/.pi/agent/auth.json`))).toEqual({
        anthropic: { type: "api", key: "sk-own" },
      });
      expect(JSON.parse(await sh(`cat ${PERSON.home}/.mend/opencode/auth.json`))).toEqual({});
    }, 60_000);

    it("never shows a login in any process's argv or environment, and refuses a hard-linked file", async () => {
      // Each payload carries a marker the watcher looks for, in plain and as its base64 line; the
      // watcher's own patterns are bracketed so it never finds itself.
      const logins = [
        { provider: "claude", content: '{"claudeAiOauth":{"accessToken":"SECRET-e2e-claude"}}' },
        // Larger than a pipe: bash writes such a here-document to a temporary file.
        {
          provider: "codex",
          content: `{"tokens":{"access_token":"SECRET-e2e-codex","pad":"${"x".repeat(100_000)}"}}`,
        },
        { provider: "github", content: 'github.com:\n    oauth_token: "SECRET-e2e-github"\n' },
        { provider: "pi", content: entry("SECRET-e2e-pi") },
        { provider: "opencode", content: entry("SECRET-e2e-oc") },
      ] as const;
      const base64Prefixes = logins.map(({ content }) =>
        Buffer.from(content, "utf8").toString("base64").slice(0, 20),
      );
      const patterns = ["SECRET-e2e-", ...base64Prefixes].map(bracketed);
      await sh(
        [
          ": > /tmp/seen",
          // One grep a sweep, over every process's argv and environment at once.
          `(while [ ! -e /tmp/stop ]; do grep -a -o -h -e '${patterns.join("' -e '")}' /proc/[0-9]*/cmdline /proc/[0-9]*/environ >> /tmp/seen; done) >/dev/null 2>&1 &`,
        ].join("\n"),
      );
      const generation = "generation-watched";
      for (let round = 0; round < 40; round += 1) {
        const put = await runHomeScript({
          fence: round === 0 ? { kind: "take", generation } : { kind: "held", generation },
          writes: logins,
        });
        expect(put.exitCode).toBe(0);
      }
      await sh("touch /tmp/stop; sleep 1");
      expect(await sh("sort -u /tmp/seen")).toBe("");
      expect(await sh(`cat ${PERSON.home}/.claude/.credentials.json`)).toContain(
        "SECRET-e2e-claude",
      );

      // A second name for Claude's login file, elsewhere: refused once opened, nothing written.
      await sh(
        [
          `printf other > /tmp/other-name`,
          `rm -f ${PERSON.home}/.claude/.credentials.json`,
          `ln /tmp/other-name ${PERSON.home}/.claude/.credentials.json`,
          `chown ${String(PERSON.uid)}:40000 /tmp/other-name`,
        ].join(" && "),
      );
      const linked = await runHomeScript({
        fence: { kind: "held", generation },
        writes: [{ provider: "claude", content: logins[0].content }],
      });
      expect(linked.exitCode).toBe(HOME_SCRIPT_EXIT.claudeLoginUnusable);
      expect(await sh("cat /tmp/other-name")).toBe("other");
      const released = await runHomeScript({ fence: { kind: "release", generation }, writes: [] });
      expect(released.exitCode).toBe(0);
    }, 120_000);

    it("refuses a login whose file really is in saved state, writing nothing there", async () => {
      // A capture brought a plain auth.json back into the saved directory.
      await sh(
        `rm ${SAVED}/.local/share/opencode/auth.json && printf '{}' > ${SAVED}/.local/share/opencode/auth.json && chown ${String(PERSON.uid)}:40000 ${SAVED}/.local/share/opencode/auth.json`,
      );
      const put = await runHomeScript({
        fence: { kind: "take", generation: "generation-alice-2" },
        writes: [{ provider: "opencode", content: entry("at-oc") }],
      });
      expect(put.exitCode).toBe(HOME_SCRIPT_EXIT.opencodeLoginOutside);
      expect(await sh(`cat ${SAVED}/.local/share/opencode/auth.json`)).toBe("{}");
    }, 60_000);
  },
);
