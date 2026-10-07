/**
 * The script that writes a person's logins into a home, run for real by `sh` against temporary
 * directories. The test's own uid and gid stand in for the home's owner, so `chown` needs no root;
 * the marker and lock live in a scratch state directory instead of `/run/sealant-homes`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHomeCredentialScript,
  HOME_SCRIPT_EXIT,
  homePathProblem,
  homeScriptStdin,
  homeStateKey,
  type HomeCredentialProvider,
  type HomeCredentialScriptInput,
} from "./home-credentials.js";

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "sealant-home-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Writes = readonly { readonly provider: HomeCredentialProvider; readonly content: string }[];
type RunInput = Omit<HomeCredentialScriptInput, "writes" | "stateDir" | "token"> & {
  readonly writes: Writes;
  /** Defaults to the next token of this world: every exec issued later than the last. */
  readonly token?: string;
};

/** One scratch world: homes under `root`, markers and locks under `state`. */
const world = () => {
  const root = scratch();
  const state = join(root, "state");
  let issued = 0;
  const nextToken = () => {
    issued += 1;
    return String(issued);
  };
  const scriptOf = (input: RunInput) =>
    buildHomeCredentialScript({
      ...input,
      token: input.token ?? nextToken(),
      stateDir: state,
      parentOwnerUid: input.parentOwnerUid ?? uid,
      // Images keep node on the fixed system PATH; this machine's may be elsewhere.
      ownerPath: `${SYSTEM_PATH}:${dirname(process.execPath)}`,
      writes: input.writes.map(({ provider }) => provider),
    });
  const run = (input: RunInput) =>
    spawnSync("sh", ["-c", scriptOf(input)], {
      input: homeScriptStdin(input.writes.map(({ content }) => content)),
      encoding: "utf8",
    });
  const markerPath = (home: string) => join(state, `${homeStateKey(home)}.generation`);
  const marker = (home: string) =>
    existsSync(markerPath(home)) ? readFileSync(markerPath(home), "utf8") : undefined;
  const home = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  return { root, state, scriptOf, run, marker, markerPath, home, nextToken };
};

const GEN_A = "generation-alice-1";
const GEN_B = "generation-bob-01";

const mode = (path: string) => lstatSync(path).mode & 0o7777;
const read = (path: string) => readFileSync(path, "utf8");

describe("homePathProblem", () => {
  it("takes an absolute, normalised path outside /workspace", () => {
    expect(homePathProblem("/home/m4fkq2x7a")).toBeUndefined();
    expect(homePathProblem("/run/mend/conv/ses_1")).toBeUndefined();
    expect(homePathProblem("/root")).toBeUndefined();
  });

  it("refuses relative, unnormalised, odd and /workspace paths", () => {
    for (const home of [
      "home/x",
      "/",
      "/home/x/",
      "/home//x",
      "/home/./x",
      "/home/../etc",
      "/home/x y",
      "/home/$HOME",
      "/workspace",
      "/workspace/harness-home/people/acc_1",
    ]) {
      expect(homePathProblem(home), home).toBeDefined();
    }
  });
});

describe("buildHomeCredentialScript", () => {
  it("writes each login 0600, owned by the home's owner, and keeps the marker outside the home", () => {
    const w = world();
    const home = w.home("alice");
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [
        { provider: "claude", content: '{"claudeAiOauth":{"accessToken":"at-alice"}}' },
        { provider: "github", content: 'github.com:\n    oauth_token: "gho_alice"\n' },
      ],
      removes: [],
    });
    expect(result.status, result.stderr).toBe(0);
    const claude = join(home, ".claude/.credentials.json");
    expect(read(claude)).toBe('{"claudeAiOauth":{"accessToken":"at-alice"}}');
    expect(mode(claude)).toBe(0o600);
    expect(lstatSync(claude).uid).toBe(uid);
    expect(mode(join(home, ".claude"))).toBe(0o700);
    expect(read(join(home, ".config/gh/hosts.yml"))).toContain("gho_alice");
    expect(w.marker(home)).toBe(GEN_A);
    expect(mode(w.state)).toBe(0o700);
  });

  it("decides a write whose stdin arrives late only once it has it, under the lock: a late write from an earlier hold lands nowhere", async () => {
    const w = world();
    const home = w.home("conv");
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "alice-v1" }],
        removes: [],
      }).status,
    ).toBe(0);

    // Alice's refresh push starts, and its stdin is held back (a stalled exec).
    const late = spawn(
      "sh",
      [
        "-c",
        w.scriptOf({
          home,
          fence: { kind: "held", generation: GEN_A },
          writes: [{ provider: "claude", content: "alice-v2" }],
          removes: [],
        }),
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const exited = new Promise<number | null>((resolve) => late.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Meanwhile the hand-over: the home is released and Bob takes it.
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
        .status,
    ).toBe(0);
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "bob-v1" }],
        removes: [],
      }).status,
    ).toBe(0);

    // Alice's push finally gets its stdin.
    late.stdin.end(homeScriptStdin(["alice-v2"]));
    expect(await exited).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(read(join(home, ".claude/.credentials.json"))).toBe("bob-v1");
    expect(w.marker(home)).toBe(GEN_B);
  });

  it("refuses every exec issued before a later one ran: two late execs cannot cross people", () => {
    const w = world();
    const home = w.home("conv");
    // An orphan marker of Alice's (an unconfirmed take landed after its own cleanup).
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "alice-v1" }],
        removes: [],
      }).status,
    ).toBe(0);
    // Issued now, both stall: Alice's retried take, and Mend's release of the unrecorded home.
    const lateTake = { token: w.nextToken() };
    const lateRelease = { token: w.nextToken() };
    // The release Mend retried runs, and Bob takes the home.
    expect(w.run({ home, fence: { kind: "release" }, writes: [], removes: [] }).status).toBe(0);
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "bob-v1" }],
        removes: [],
      }).status,
    ).toBe(0);
    // Now the two stalled execs run, release first.
    expect(
      w.run({ home, fence: { kind: "release" }, writes: [], removes: [], ...lateRelease }).status,
    ).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "alice-v2" }],
        removes: [],
        ...lateTake,
      }).status,
    ).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(read(join(home, ".claude/.credentials.json"))).toBe("bob-v1");
    expect(w.marker(home)).toBe(GEN_B);
  });

  it("refuses every token while the mark is not a number", () => {
    const w = world();
    const home = w.home("hal");
    mkdirSync(w.state, { recursive: true });
    writeFileSync(join(w.state, `${homeStateKey(home)}.hw`), "");
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "x" }],
        removes: [],
        token: "999",
      }).status,
    ).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("refuses a home in a parent its owner could rename it in", () => {
    const w = world();
    const parent = join(w.root, "shared");
    mkdirSync(parent, { mode: 0o775 });
    spawnSync("chmod", ["0775", parent]);
    const home = join(parent, "ivy");
    mkdirSync(home, { mode: 0o700 });
    const take = (parentOwnerUid?: number) =>
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "x" }],
        removes: [],
        ...(parentOwnerUid === undefined ? {} : { parentOwnerUid }),
      }).status;
    // Group-writable without the sticky bit.
    expect(take()).toBe(HOME_SCRIPT_EXIT.untrusted);
    // Belonging to someone else.
    spawnSync("chmod", ["0755", parent]);
    expect(take(uid + 1)).toBe(HOME_SCRIPT_EXIT.untrusted);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(take()).toBe(0);
  });

  it("counts a take its own hold already made as done, even after later writes", () => {
    const w = world();
    const home = w.home("jo");
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "launch" }],
        removes: [],
        token: "0",
      }).status,
    ).toBe(0);
    expect(
      w.run({
        home,
        fence: { kind: "held", generation: GEN_A },
        writes: [{ provider: "claude", content: "refreshed" }],
        removes: [],
      }).status,
    ).toBe(0);
    // The launch delivered again: nothing is rewritten, nothing fails.
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "claude", content: "launch" }],
        removes: [],
        token: "0",
      }).status,
    ).toBe(0);
    expect(read(join(home, ".claude/.credentials.json"))).toBe("refreshed");
  });

  it("fences takes, writes and releases by the marker", () => {
    const w = world();
    const home = w.home("conv");
    const take = (generation: string, content: string) =>
      w.run({
        home,
        fence: { kind: "take", generation },
        writes: [{ provider: "claude", content }],
        removes: [],
      }).status;
    expect(take(GEN_B, "bob")).toBe(0);
    // Another hold's take, write and release are refused, and change nothing.
    expect(take(GEN_A, "alice")).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(
      w.run({
        home,
        fence: { kind: "held", generation: GEN_A },
        writes: [{ provider: "claude", content: "alice" }],
        removes: [],
      }).status,
    ).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
        .status,
    ).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(read(join(home, ".claude/.credentials.json"))).toBe("bob");
    // The same hold's take again (a launch delivered twice) is accepted.
    expect(take(GEN_B, "bob-again")).toBe(0);
    expect(read(join(home, ".claude/.credentials.json"))).toBe("bob-again");
    // Bob's release removes everything; an unfenced release removes whatever is there.
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_B }, writes: [], removes: [] })
        .status,
    ).toBe(0);
    expect(existsSync(join(home, ".claude/.credentials.json"))).toBe(false);
    expect(w.marker(home)).toBeUndefined();
    expect(take(GEN_A, "alice")).toBe(0);
    expect(w.run({ home, fence: { kind: "release" }, writes: [], removes: [] }).status).toBe(0);
    expect(w.marker(home)).toBeUndefined();
  });

  it("waits for the home's lock, and gives up after its wait", () => {
    const w = world();
    const home = w.home("dan");
    mkdirSync(w.state, { recursive: true });
    const holder = spawn("flock", [join(w.state, `${homeStateKey(home)}.lock`), "sleep", "3"]);
    const started = Date.now();
    while (Date.now() - started < 300) {
      // Let the holder take the lock.
    }
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "claude", content: "x" }],
      removes: [],
      lockWaitSeconds: 1,
    });
    holder.kill();
    expect(result.status).toBe(HOME_SCRIPT_EXIT.busy);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("replaces a link at the file's name instead of writing through it", () => {
    const w = world();
    const home = w.home("bob");
    mkdirSync(join(home, ".codex"));
    const elsewhere = join(w.root, "elsewhere.json");
    writeFileSync(elsewhere, "untouched");
    symlinkSync(elsewhere, join(home, ".codex/auth.json"));
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "codex", content: '{"tokens":{}}' }],
      removes: [],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(read(elsewhere)).toBe("untouched");
    expect(lstatSync(join(home, ".codex/auth.json")).isSymbolicLink()).toBe(false);
  });

  it.skipIf(uid === 0)(
    "follows a login directory linked inside the home (dotfiles), refuses one linked outside it, in writes and releases",
    () => {
      const w = world();
      const home = w.home("erin");
      mkdirSync(join(home, "dotfiles/claude"), { recursive: true });
      symlinkSync(join(home, "dotfiles/claude"), join(home, ".claude"));
      expect(
        w.run({
          home,
          fence: { kind: "take", generation: GEN_A },
          writes: [{ provider: "claude", content: "erin" }],
          removes: [],
        }).status,
      ).toBe(0);
      expect(read(join(home, "dotfiles/claude/.credentials.json"))).toBe("erin");
      expect(lstatSync(join(home, ".claude")).isSymbolicLink()).toBe(true);

      const other = join(w.root, "someone-else");
      mkdirSync(other);
      writeFileSync(join(other, "auth.json"), "theirs");
      symlinkSync(other, join(home, ".codex"));
      expect(
        w.run({
          home,
          fence: { kind: "held", generation: GEN_A },
          writes: [{ provider: "codex", content: "x" }],
          removes: [],
        }).status,
      ).toBe(HOME_SCRIPT_EXIT.linkOnTheWay);
      expect(
        w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
          .status,
      ).toBe(HOME_SCRIPT_EXIT.linkOnTheWay);
      expect(read(join(other, "auth.json"))).toBe("theirs");
    },
  );

  it("refuses a home reached through a symbolic link, writing nothing", () => {
    const w = world();
    mkdirSync(join(w.root, "real"));
    symlinkSync(join(w.root, "real"), join(w.root, "linked"));
    const result = w.run({
      home: join(w.root, "linked"),
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "claude", content: "{}" }],
      removes: [],
    });
    expect(result.status).toBe(HOME_SCRIPT_EXIT.linkOnTheWay);
    expect(existsSync(join(w.root, "real/.claude"))).toBe(false);
  });

  it("refuses a home that does not exist, unless told whose to make", () => {
    const w = world();
    const home = join(w.root, "missing/frank");
    const take = (createWithOwner?: { uid: number; gid: number }) =>
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        ...(createWithOwner === undefined ? {} : { createWithOwner }),
        writes: [{ provider: "claude", content: "{}" }],
        removes: [],
      });
    expect(take().status).toBe(HOME_SCRIPT_EXIT.missing);
    const made = take({ uid, gid });
    expect(made.status, made.stderr).toBe(0);
    expect(mode(home)).toBe(0o700);
    expect(lstatSync(home).uid).toBe(uid);
    // A parent it had to make stays reachable.
    expect(mode(join(home, ".."))).toBe(0o755);
  });

  it("seeds a home it makes from the skeleton, and keeps the home 0700", () => {
    const w = world();
    const skel = join(w.root, "skel");
    mkdirSync(skel, { mode: 0o755 });
    writeFileSync(join(skel, ".profile"), "# skel");
    const home = join(w.root, "gina");
    const made = w.run({
      home,
      skel,
      fence: { kind: "take", generation: GEN_A },
      createWithOwner: { uid, gid },
      writes: [{ provider: "claude", content: "{}" }],
      removes: [],
    });
    expect(made.status, made.stderr).toBe(0);
    expect(read(join(home, ".profile"))).toBe("# skel");
    expect(mode(home)).toBe(0o700);
  });

  it("never puts a payload in the script itself", () => {
    const script = buildHomeCredentialScript({
      home: "/home/m1",
      fence: { kind: "take", generation: GEN_A },
      token: "1",
      writes: ["claude"],
      removes: [],
    });
    expect(script).not.toContain("secret-access-token");
    expect(homeScriptStdin(["secret-access-token"])).toBe(
      `${Buffer.from("secret-access-token").toString("base64")}\n`,
    );
  });

  it("refuses to build a script for a path that is not a home", () => {
    expect(() =>
      buildHomeCredentialScript({
        home: "/workspace/repo",
        fence: { kind: "release" },
        token: "1",
        writes: [],
        removes: [],
      }),
    ).toThrow(/never under \/workspace/);
  });
});

/** Whether a container can be run here: the root-only race needs a real root and a real person. */
const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe.skipIf(!dockerAvailable)(
  "buildHomeCredentialScript as root, against its own home's owner",
  () => {
    it(
      "never writes outside the home while the person swaps links in it",
      { timeout: 240_000 },
      () => {
        const dir = scratch();
        const home = "/home/bob";
        const script = (fence: HomeCredentialScriptInput["fence"], token: string) =>
          buildHomeCredentialScript({
            home,
            fence,
            token,
            writes: ["claude", "codex"],
            removes: [],
            stateDir: "/run/sealant-homes",
          });
        writeFileSync(join(dir, "take.sh"), script({ kind: "take", generation: GEN_B }, "1"));
        writeFileSync(join(dir, "write.sh"), script({ kind: "held", generation: GEN_B }, "2"));
        writeFileSync(join(dir, "payload"), homeScriptStdin(["bob-claude", "bob-codex"]));
        writeFileSync(
          join(dir, "srv.sh"),
          buildHomeCredentialScript({
            home: "/srv/x",
            fence: { kind: "take", generation: GEN_A },
            token: "1",
            writes: ["claude", "codex"],
            removes: [],
            stateDir: "/run/sealant-homes",
          }),
        );
        writeFileSync(
          join(dir, "cy.sh"),
          buildHomeCredentialScript({
            home: "/home/cy",
            fence: { kind: "take", generation: GEN_A },
            token: "1",
            writes: ["claude", "codex"],
            removes: [],
            stateDir: "/run/sealant-homes",
          }),
        );
        // Root's files the person must never reach through root's writes, chmods or chowns.
        const driver = [
          "set -u",
          "useradd -m -u 1234 bob",
          "printf root-data > /victim; chmod 644 /victim; mkdir /rootdir",
          // Tokens in the exec's environment, where the person could read them through /proc.
          "export GITHUB_TOKEN=owner-github CLAUDE_CODE_OAUTH_TOKEN=owner-oauth SEALANT_SECRET=owner-secret",
          "touch /tmp/seen; chown bob /tmp/seen",
          "sh /t/take.sh < /t/payload",
          // The person swaps a link to /victim in at the file's name, and a link to /rootdir in at a
          // login directory, as fast as they can.
          `env -i PATH=/usr/bin:/bin setpriv --reuid=1234 --regid=1234 --clear-groups sh -c 'cd ${home}/.claude; while :; do ln -sf /victim .l; mv -fT .l .credentials.json 2>/dev/null; rm -f .credentials.json; done' >/dev/null 2>&1 & s1=$!`,
          `env -i PATH=/usr/bin:/bin setpriv --reuid=1234 --regid=1234 --clear-groups sh -c 'cd ${home}; while :; do ln -sfn /rootdir .x; mv -fT .x .codex 2>/dev/null; rm -f .codex; mkdir .codex 2>/dev/null; done' >/dev/null 2>&1 & s2=$!`,
          `env -i PATH=/usr/bin:/bin setpriv --reuid=1234 --regid=1234 --clear-groups sh -c 'while :; do for e in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$e" 2>/dev/null | grep "^[A-Z_]*=owner-" >> /tmp/seen; done; done' >/dev/null 2>&1 & s3=$!`,
          "i=0; while [ $i -lt 300 ]; do sh /t/write.sh < /t/payload >/dev/null 2>&1 || true; i=$((i+1)); done",
          'kill "$s1" "$s2" "$s3"; wait "$s1" "$s2" "$s3" 2>/dev/null || true',
          'echo "seen=$(sort -u /tmp/seen | tr "\n" ",")"',
          // A home root owns, other than /root, is not written into.
          "mkdir -p /srv/x; sh /t/srv.sh < /t/payload; echo \"srv=$? $(ls -A /srv/x | tr '\\n' ',')\"",
          // An executor that cannot drop to the owner: unusable, and no marker left behind.
          'useradd -m -u 1235 cy; setpriv --bounding-set=-setuid,-setgid sh /t/cy.sh < /t/payload; echo "cy=$? marker=$(ls /run/sealant-homes | grep -c generation || true)"',
          'echo "victim=$(cat /victim) owner=$(stat -c %U:%a /victim)"',
          'echo "rootdir=$(ls -A /rootdir | tr "\\n" ",")"',
        ].join("\n");
        writeFileSync(join(dir, "driver.sh"), driver);
        const result = spawnSync(
          "docker",
          ["run", "--rm", "-v", `${dir}:/t:ro`, "debian:bookworm-slim", "sh", "/t/driver.sh"],
          { encoding: "utf8", timeout: 200_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("victim=root-data owner=root:644");
        expect(result.stdout).toContain("rootdir=\n");
        // The owner's half never carries the exec's tokens.
        expect(result.stdout).toContain("seen=\n");
        expect(result.stdout).toContain(`srv=${HOME_SCRIPT_EXIT.untrusted} \n`);
        // Bob's marker only (from his take): cy's take left none.
        expect(result.stdout).toContain(`cy=${HOME_SCRIPT_EXIT.cannotDrop} marker=1`);
      },
    );
  },
);
describe("buildCredentialFileWriteScript for a launch's credentialsHome", () => {
  it("makes the home for its owner and writes every login in one exec, taking the home", async () => {
    const { buildCredentialFileWriteScript } = await import("./credential-files.js");
    const w = world();
    const home = join(w.root, "erin");
    const claude = '{"claudeAiOauth":{"accessToken":"at-erin"}}';
    const hostsYml = 'github.com:\n    oauth_token: "gho_erin"\n';
    const stdin = homeScriptStdin([claude, hostsYml]);
    const script = buildCredentialFileWriteScript(
      {
        path: home,
        contentBase64: stdin,
        mode: "600",
        home: { uid, gid, generation: GEN_A, providers: ["claude", "github"] },
      },
      { stateDir: w.state, parentOwnerUid: uid },
    );
    // The adapters pipe `contentBase64` as it is; a launch delivered again writes again.
    const deliveries = [1, 2].map(() =>
      spawnSync("sh", ["-c", script], { input: stdin, encoding: "utf8" }),
    );
    for (const result of deliveries) expect(result.status, result.stderr).toBe(0);
    expect(mode(home)).toBe(0o700);
    expect(read(join(home, ".claude/.credentials.json"))).toBe(claude);
    expect(read(join(home, ".config/gh/hosts.yml"))).toBe(hostsYml);
    expect(mode(join(home, ".claude/.credentials.json"))).toBe(0o600);
    expect(w.marker(home)).toBe(GEN_A);
  });

  it("refuses a home that is not one", async () => {
    const { buildCredentialFileWriteScript } = await import("./credential-files.js");
    expect(() =>
      buildCredentialFileWriteScript({
        path: "/workspace/harness-home",
        contentBase64: "eA==",
        mode: "600",
        home: { uid: 40001, gid: 40000, generation: GEN_A, providers: ["claude"] },
      }),
    ).toThrow(/never under \/workspace/);
  });
});

describe("pi's and opencode's ChatGPT logins", () => {
  const COPY = "sealant-copy-cannot-refresh";
  const entry = (access: string) =>
    JSON.stringify({ type: "oauth", access, refresh: COPY, expires: 1, accountId: "acc_1" });
  const json = (path: string): Record<string, unknown> => JSON.parse(read(path));

  it("merges the entry into each tool's auth.json, keeping every other login, 0600", () => {
    const w = world();
    const home = w.home("alice");
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi/agent/auth.json"),
      JSON.stringify({ anthropic: { type: "api", key: "sk-own" } }),
    );
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [
        { provider: "pi", content: entry("at-pi") },
        { provider: "opencode", content: entry("at-oc") },
      ],
      removes: [],
    });
    expect(result.status, result.stderr).toBe(0);
    const pi = join(home, ".pi/agent/auth.json");
    expect(json(pi)).toEqual({
      anthropic: { type: "api", key: "sk-own" },
      "openai-codex": JSON.parse(entry("at-pi")),
    });
    expect(mode(pi)).toBe(0o600);
    const opencode = join(home, ".local/share/opencode/auth.json");
    expect(json(opencode)).toEqual({ openai: JSON.parse(entry("at-oc")) });
    expect(lstatSync(opencode).uid).toBe(uid);
  });

  it("never replaces or removes a login the person made inside the tool (decision 8a)", () => {
    const w = world();
    const home = w.home("alice");
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    const own = { type: "oauth", access: "own", refresh: "own-refresh", expires: 2 };
    writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: own }));
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "opencode", content: entry("at-copy") }],
        removes: [],
      }).status,
    ).toBe(0);
    expect(json(join(home, ".local/share/opencode/auth.json"))).toEqual({ openai: own });
    // A release removes only Core's copies: the person's own login stays.
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
        .status,
    ).toBe(0);
    expect(json(join(home, ".local/share/opencode/auth.json"))).toEqual({ openai: own });
  });

  it("removes only the copy on a null or a release, keeping the file and its other entries", () => {
    const w = world();
    const home = w.home("alice");
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [
          { provider: "pi", content: entry("at-pi") },
          { provider: "opencode", content: entry("at-oc") },
        ],
        removes: [],
      }).status,
    ).toBe(0);
    const pi = join(home, ".pi/agent/auth.json");
    const withOther = { ...json(pi), google: { type: "api", key: "own" } };
    writeFileSync(pi, JSON.stringify(withOther));
    expect(
      w.run({
        home,
        fence: { kind: "held", generation: GEN_A },
        writes: [],
        removes: ["pi"],
      }).status,
    ).toBe(0);
    expect(json(pi)).toEqual({ google: { type: "api", key: "own" } });
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
        .status,
    ).toBe(0);
    expect(json(join(home, ".local/share/opencode/auth.json"))).toEqual({});
  });

  it("writes through Mend's links to where the file really is, inside the home", () => {
    const w = world();
    const home = w.home("alice");
    // Mend's person layout: the data directory lives in the saved directory, and its auth.json
    // is a link back into the home, whose target does not exist yet.
    const saved = join(w.root, "saved/.local/share/opencode");
    mkdirSync(saved, { recursive: true });
    mkdirSync(join(home, ".local/share"), { recursive: true });
    symlinkSync(saved, join(home, ".local/share/opencode"));
    mkdirSync(join(home, ".mend/opencode"), { recursive: true, mode: 0o700 });
    symlinkSync(join(home, ".mend/opencode/auth.json"), join(saved, "auth.json"));
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "opencode", content: entry("at-oc") }],
      removes: [],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(json(join(home, ".mend/opencode/auth.json"))).toEqual({
      openai: JSON.parse(entry("at-oc")),
    });
    // The link in the saved directory is still a link: no login in saved state.
    expect(lstatSync(join(saved, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("refuses a login whose file really is outside the home, writing nothing", () => {
    const w = world();
    const home = w.home("alice");
    const saved = join(w.root, "saved/.local/share/opencode");
    mkdirSync(saved, { recursive: true });
    mkdirSync(join(home, ".local/share"), { recursive: true });
    symlinkSync(saved, join(home, ".local/share/opencode"));
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "opencode", content: entry("at-oc") }],
      removes: [],
    });
    expect(result.status).toBe(HOME_SCRIPT_EXIT.opencodeLoginOutside);
    expect(existsSync(join(saved, "auth.json"))).toBe(false);
  });

  it("refuses a login file with another hard link, which could be saved state", () => {
    const w = world();
    const home = w.home("alice");
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    const elsewhere = join(w.root, "saved-auth.json");
    writeFileSync(elsewhere, "{}");
    linkSync(elsewhere, join(home, ".pi/agent/auth.json"));
    const result = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "pi", content: entry("at-pi") }],
      removes: [],
    });
    expect(result.status).toBe(HOME_SCRIPT_EXIT.piLoginOutside);
    expect(read(elsewhere)).toBe("{}");
  });

  it("answers a directory at auth.json as unusable, never as a link, and a release clears the take", () => {
    const w = world();
    const home = w.home("alice");
    mkdirSync(join(home, ".pi/agent/auth.json"), { recursive: true });
    const put = w.run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "pi", content: entry("at-pi") }],
      removes: [],
    });
    expect(put.status).toBe(HOME_SCRIPT_EXIT.piLoginUnusable);
    // The take's own release (what the API runs next) finds nothing of Core's there and clears
    // the marker, so the next take is not answered as another person's hold.
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
        .status,
    ).toBe(0);
    expect(w.marker(home)).toBeUndefined();
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "c" }],
        removes: [],
      }).status,
    ).toBe(0);
  });

  it("fails closed without node: a release or a take that would leave a pi or opencode copy is refused", () => {
    const w = world();
    const home = w.home("alice");
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "pi", content: entry("at-pi") }],
        removes: [],
      }).status,
    ).toBe(0);
    const pi = join(home, ".pi/agent/auth.json");
    const noNode = { nodeCommand: "sealant-no-such-node" };
    // A put naming pi needs node.
    expect(
      w.run({
        home,
        fence: { kind: "held", generation: GEN_A },
        writes: [{ provider: "pi", content: entry("at-pi-2") }],
        removes: [],
        ...noNode,
      }).status,
    ).toBe(HOME_SCRIPT_EXIT.noNode);
    // A release would leave Alice's copy for the next holder: refused, the home stays held.
    expect(
      w.run({
        home,
        fence: { kind: "release", generation: GEN_A },
        writes: [],
        removes: [],
        ...noNode,
      }).status,
    ).toBe(HOME_SCRIPT_EXIT.noNode);
    expect(json(pi)).toEqual({ "openai-codex": JSON.parse(entry("at-pi")) });
    expect(w.marker(home)).toBe(GEN_A);
    // With node, the release removes the copy.
    expect(
      w.run({ home, fence: { kind: "release", generation: GEN_A }, writes: [], removes: [] })
        .status,
    ).toBe(0);
    expect(json(pi)).toEqual({});

    // A first take that removes what it does not write is refused too when such a file exists,
    // before it makes its marker.
    const other = w.home("bob");
    mkdirSync(join(other, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(other, ".local/share/opencode/auth.json"), "{}");
    expect(
      w.run({
        home: other,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "c" }],
        removes: ["pi", "opencode"],
        ...noNode,
      }).status,
    ).toBe(HOME_SCRIPT_EXIT.noNode);
    expect(w.marker(other)).toBeUndefined();
    // Where there is no such file, nothing needs node.
    const empty = w.home("carol");
    expect(
      w.run({
        home: empty,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "c" }],
        removes: ["pi", "opencode"],
        ...noNode,
      }).status,
    ).toBe(0);
  });

  it("leaves a file that is not a JSON object as it is", () => {
    const w = world();
    const home = w.home("alice");
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(join(home, ".pi/agent/auth.json"), "not json");
    expect(
      w.run({
        home,
        fence: { kind: "take", generation: GEN_A },
        writes: [{ provider: "pi", content: entry("at-pi") }],
        removes: [],
      }).status,
    ).toBe(0);
    expect(read(join(home, ".pi/agent/auth.json"))).toBe("not json");
  });

  it("carries no single quote in the merge program, which the script quotes", () => {
    const script = buildHomeCredentialScript({
      home: "/home/m4lice000",
      fence: { kind: "take", generation: GEN_A },
      token: "1",
      writes: ["pi"],
      removes: [],
    });
    expect(script).toContain("openai-codex");
    expect(script).toContain(`exit ${String(HOME_SCRIPT_EXIT.noNode)}`);
  });
});
