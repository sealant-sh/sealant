/**
 * Who a process may be started as (Mend ADR 0016 decision 1): the name's own refusals (root, a
 * malformed user, a uid outside 40001–49999) before the executor is asked; the check script, run by
 * `sh` against a fake `getent` on the PATH, answering only with its exit code; what each answer
 * means; and the per-workspace report from the image's probe and the runtime.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceImageProbe } from "@sealant/validators";
import { afterEach, describe, expect, it } from "vitest";

import { processUserCapability, runtimeRunsProcessesAsUser } from "../api/person-layout.js";
import {
  buildProcessUserCheckScript,
  PROCESS_USER_CHECK_EXIT,
  processUserCheckOutcome,
  processUserProblem,
} from "./process-user.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the check script for `user` with a `getent` that knows `entries` (name → passwd line). */
const check = (user: string, entries: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "sealant-process-user-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const table = Object.entries(entries)
    .map(([key, line]) => `  ${key}) echo '${line}' ;;`)
    .join("\n");
  writeFileSync(
    join(bin, "getent"),
    `#!/bin/sh\n[ "$1" = passwd ] || exit 2\ncase "$2" in\n${table}\n  *) exit 2 ;;\nesac\n`,
  );
  chmodSync(join(bin, "getent"), 0o755);
  // The script sets its own PATH; the fake getent comes first, then this machine's own tools.
  const result = spawnSync(
    "sh",
    [
      "-c",
      buildProcessUserCheckScript(user, {
        prependPath: [bin, ...(process.env["PATH"] ?? "").split(":")]
          .filter((dir) => /^\/[A-Za-z0-9._/-]+$/.test(dir))
          .join(":"),
      }),
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout };
};

const entry = (name: string, uid: number, gid: number) =>
  `${name}:x:${String(uid)}:${String(gid)}::/home/${name}:/bin/sh`;

describe("processUserProblem", () => {
  it("refuses root, a malformed user and a uid outside the range, before the executor is asked", () => {
    for (const user of ["root", "0", "000", "1000", "40000", "50000", "65534", "4294967295"]) {
      expect(processUserProblem(user)).toMatchObject({ reason: "not-in-range" });
    }
    for (const user of ["Alice", "a b", "../etc", "", "-x", "a".repeat(33)]) {
      expect(processUserProblem(user)).toMatchObject({ reason: "not-in-range" });
    }
    expect(processUserProblem("1000")?.detail).toBe("uid 1000 is outside 40001–49999");
    expect(processUserProblem("root")?.detail).toBe("it is root");
  });

  it("leaves a login name, and a uid inside the range, to the executor", () => {
    for (const user of ["m4lice000", "_svc", "40001", "49999"]) {
      expect(processUserProblem(user)).toBeUndefined();
    }
  });
});

describe("the check script", () => {
  const people = {
    m4lice000: entry("m4lice000", 40001, 40000),
    "40001": entry("m4lice000", 40001, 40000),
    m8ob0000: entry("m8ob0000", 49999, 40000),
    builder: entry("builder", 1000, 1000),
    m0ut0000: entry("m0ut0000", 40002, 1000),
    msneak00: entry("msneak00", 0, 40000),
  };

  it("passes a person in the range whose primary group is mend, by name or uid", () => {
    expect(check("m4lice000", people).status).toBe(0);
    expect(check("40001", people).status).toBe(0);
    expect(check("m8ob0000", people).status).toBe(0);
    expect(check("m4lice000", people).stdout).toBe("");
  });

  it("answers why it refuses: unknown, uid out of range (root included), group not mend", () => {
    expect(check("nobody0", people).status).toBe(PROCESS_USER_CHECK_EXIT.unknownUser);
    expect(check("builder", people).status).toBe(PROCESS_USER_CHECK_EXIT.uidOutOfRange);
    // A name whose passwd entry is uid 0 is root, whatever it is called.
    expect(check("msneak00", people).status).toBe(PROCESS_USER_CHECK_EXIT.uidOutOfRange);
    expect(check("m0ut0000", people).status).toBe(PROCESS_USER_CHECK_EXIT.groupNotMend);
  });

  it("says so, rather than calling the user unknown, on an image without getent", () => {
    const root = mkdtempSync(join(tmpdir(), "sealant-process-user-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const script = buildProcessUserCheckScript("m4lice000");
    // The script looks only in the fixed system PATH: no `getent` where it looks, as in an image
    // without it, is simulated by pointing those directories at an empty one.
    expect(script).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    const withoutGetent = script.replace(/^PATH=.*$/m, `PATH=${bin}`);
    const result = spawnSync("/bin/sh", ["-c", withoutGetent], { encoding: "utf8" });
    expect(result.status).toBe(PROCESS_USER_CHECK_EXIT.noGetent);
    expect(
      processUserCheckOutcome({ supported: true, exitCode: PROCESS_USER_CHECK_EXIT.noGetent }),
    ).toEqual({
      reason: "check-unavailable",
      detail: "its image has no getent, so Core cannot read the user's passwd entry",
    });
  });

  it("is never built for a name refused up front, nor with an unsafe PATH", () => {
    expect(() => buildProcessUserCheckScript("m4lice000", { prependPath: "relative" })).toThrow();
    expect(() => buildProcessUserCheckScript("m4lice000", { prependPath: "/x;rm" })).toThrow();
    expect(() => buildProcessUserCheckScript("root")).toThrow(/root/);
    expect(() => buildProcessUserCheckScript("1000")).toThrow(/outside/);
    expect(() => buildProcessUserCheckScript("a'; rm -rf /")).toThrow();
  });
});

describe("processUserCheckOutcome", () => {
  it("reads the executor's answer", () => {
    expect(processUserCheckOutcome({ supported: true, exitCode: 0 })).toBe("ok");
    expect(processUserCheckOutcome({ supported: false, exitCode: undefined })).toEqual({
      reason: "sealantd-unsupported",
      detail: "its sealantd does not report exec.user",
    });
    expect(
      processUserCheckOutcome({ supported: true, exitCode: PROCESS_USER_CHECK_EXIT.unknownUser }),
    ).toMatchObject({ reason: "unknown-user" });
    expect(
      processUserCheckOutcome({ supported: true, exitCode: PROCESS_USER_CHECK_EXIT.uidOutOfRange }),
    ).toMatchObject({ reason: "not-in-range", detail: "its uid is outside 40001–49999" });
    expect(
      processUserCheckOutcome({ supported: true, exitCode: PROCESS_USER_CHECK_EXIT.groupNotMend }),
    ).toMatchObject({ reason: "not-in-range", detail: "its primary group is not mend (40000)" });
    expect(processUserCheckOutcome({ supported: true, exitCode: undefined })).toBe("unanswered");
    expect(processUserCheckOutcome({ supported: true, exitCode: 1 })).toBe("unanswered");
  });
});

const probe = (sealantd: WorkspaceImageProbe["sealantd"]): WorkspaceImageProbe => ({
  version: 1,
  tools: {
    sudo: true,
    sudoSetuid: true,
    useradd: true,
    groupadd: true,
    setfacl: true,
    getfacl: true,
    setpriv: true,
    flock: true,
  },
  sudoersMend: true,
  sudoersIncludesDir: true,
  noNewPrivileges: false,
  passwdWritable: true,
  mendGroup: "present",
  reservedIdsInUse: [],
  personEnv: true,
  sharedDirs: [],
  sealantd,
});

describe("processUserCapability (the workspace read)", () => {
  it("follows the image's sealantd on every runtime Core reaches it on", () => {
    const yes = probe({ supports: ["dotfiles.user", "exec.user", "restore.owner_map"] });
    for (const runtime of ["docker", "microvm", "k8s", "k3s"] as const) {
      expect(processUserCapability(yes, runtime)).toBe("supported");
      expect(runtimeRunsProcessesAsUser(runtime)).toBe(true);
    }
    expect(processUserCapability(probe({ supports: ["restore.owner_map"] }), "docker")).toBe(
      "unsupported",
    );
    // A sealantd without the `capabilities` command.
    expect(processUserCapability(probe(null), "docker")).toBe("unsupported");
  });

  it("is unknown when nothing says, and unsupported on Cloudflare", () => {
    expect(processUserCapability(undefined, "docker")).toBe("unknown");
    expect(processUserCapability(probe("unreadable"), "docker")).toBe("unknown");
    expect(processUserCapability(probe({ supports: ["exec.user"] }), "cloudflare")).toBe(
      "unsupported",
    );
    expect(runtimeRunsProcessesAsUser("cloudflare")).toBe(false);
  });
});
