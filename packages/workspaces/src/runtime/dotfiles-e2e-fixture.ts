/**
 * The dotfiles a live e2e launches with, and what it expects to find inside the workspace
 * afterwards. Shared by the Docker (`dotfiles.e2e.ts`) and MicroVM (`built-image.e2e.ts`) specs so
 * both hold the runtime to the same facts.
 *
 * The `auto` archive is shaped like a real repository Mend applied on its hosted instance: dot
 * entries at the top (`.config/`, `.gitconfig`, `.tmux.conf`, `.zshenv`) beside plain directories
 * that are not stow packages (`bin/`, `legacy/`, `Library/`) and a plain file (`Brewfile`). The
 * dot entries must land in /root, and nothing inside the plain directories may be stowed into
 * /root. A second archive with `manager: copy` is applied after it. The login shell is zsh, and
 * processes the daemon starts (the foreground command, and an exec) see `HOME=/root`.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { NewWorkspace } from "@sealant/validators";

const execFileAsync = promisify(execFile);

/** Relative path → file content. Paths with a `bin/` prefix are made executable. */
export type DotfilesTree = Readonly<Record<string, string>>;

export const AUTO_DOTFILES_TREE: DotfilesTree = {
  ".config/zsh/.zshrc": "# sealant dotfiles e2e\nexport SEALANT_DOTFILES_E2E=zshrc\n",
  ".zshenv": 'export ZDOTDIR="$HOME/.config/zsh"\n',
  ".gitconfig": "[user]\n\tname = Sealant Dotfiles E2E\n",
  ".tmux.conf": "set -g mouse on\n",
  "bin/sealant-dotfiles-e2e-tool": "#!/bin/sh\necho tool\n",
  Brewfile: 'brew "ripgrep"\n',
  "legacy/.legacyrc": "# a file stow would link to /root/.legacyrc\n",
  "Library/Preferences/sealant-e2e.plist": "plist\n",
};

export const COPY_DOTFILES_TREE: DotfilesTree = {
  ".copy-marker": "copied\n",
};

/** Where the foreground command records the HOME it was started with. */
export const FOREGROUND_HOME_FILE = "/tmp/sealant-dotfiles-e2e-foreground-home";

/** A foreground that records its HOME and then stays up, standing in for the harness. */
export const DOTFILES_E2E_FOREGROUND = {
  kind: "command",
  run: `printf '%s' "$HOME" > ${FOREGROUND_HOME_FILE}; exec sleep 900`,
  shell: "bash",
} as const;

/** Pack a tree as `git archive` would: a gzipped tar of its top-level entries, no `./` prefix. */
export const packDotfilesArchive = async (tree: DotfilesTree): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "sealant-dotfiles-e2e-"));
  try {
    const source = path.join(root, "tree");
    for (const [relative, content] of Object.entries(tree)) {
      const file = path.join(source, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, { mode: relative.startsWith("bin/") ? 0o755 : 0o644 });
    }
    const topLevel = [
      ...new Set(Object.keys(tree).map((relative) => relative.split("/")[0] ?? relative)),
    ];
    const archive = path.join(root, "archive.tar.gz");
    await execFileAsync("tar", ["-czf", archive, "-C", source, ...topLevel.toSorted()]);
    return (await readFile(archive)).toString("base64");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** The two archives, auto first, as `runtime.dotfilesArchives`. */
export const dotfilesE2eArchives = async (): Promise<
  NewWorkspace["runtime"]["dotfilesArchives"]
> => [
  { data: await packDotfilesArchive(AUTO_DOTFILES_TREE), manager: "auto", bootstrap: false },
  { data: await packDotfilesArchive(COPY_DOTFILES_TREE), manager: "copy", bootstrap: false },
];

/** Paths that must exist under /root once both archives are applied. */
export const EXPECTED_PRESENT = [
  "/root/.config/zsh/.zshrc",
  "/root/.zshenv",
  "/root/.gitconfig",
  "/root/.tmux.conf",
  "/root/.copy-marker",
] as const;

/** What stowing the plain directories into /root would have left there. None may exist. */
export const EXPECTED_ABSENT = [
  "/root/.legacyrc",
  "/root/sealant-dotfiles-e2e-tool",
  "/root/Preferences",
] as const;

/**
 * A POSIX sh script that prints one `key=value` line per fact. Run it in the workspace through
 * the daemon (an exec), so `exec-home` is the HOME the daemon gives the processes it starts.
 */
export const DOTFILES_PROBE_SCRIPT = [
  // The foreground may start a moment after the daemon answers; give it ten seconds.
  `i=0; while [ ! -s ${FOREGROUND_HOME_FILE} ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done`,
  "for p in " + [...EXPECTED_PRESENT, ...EXPECTED_ABSENT].join(" ") + "; do",
  '  if [ -e "$p" ] || [ -L "$p" ]; then printf "path %s=present\\n" "$p"; else printf "path %s=missing\\n" "$p"; fi',
  "done",
  "printf 'zshrc=%s\\n' \"$(grep -c 'SEALANT_DOTFILES_E2E=zshrc' /root/.config/zsh/.zshrc 2>/dev/null)\"",
  "printf 'gitconfig=%s\\n' \"$(grep -c 'Sealant Dotfiles E2E' /root/.gitconfig 2>/dev/null)\"",
  "printf 'login-shell=%s\\n' \"$(getent passwd root | cut -d: -f7)\"",
  "printf 'exec-home=%s\\n' \"$HOME\"",
  `printf 'foreground-home=%s\\n' "$(cat ${FOREGROUND_HOME_FILE} 2>/dev/null)"`,
].join("\n");

/**
 * What the probe's output says went wrong, one line per fact that does not hold; empty when the
 * dotfiles landed as expected. Pure, so the e2e can print every finding at once.
 */
export const dotfilesProbeFindings = (stdout: string): readonly string[] => {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const findings: string[] = [];
  for (const target of EXPECTED_PRESENT) {
    if (values.get(`path ${target}`) !== "present") findings.push(`${target} is missing`);
  }
  for (const target of EXPECTED_ABSENT) {
    if (values.get(`path ${target}`) !== "missing") {
      findings.push(`${target} exists: a plain directory was stowed into /root`);
    }
  }
  if (values.get("zshrc") !== "1") findings.push("/root/.config/zsh/.zshrc is not the archive's");
  if (values.get("gitconfig") !== "1") findings.push("/root/.gitconfig is not the archive's");
  const shell = values.get("login-shell") ?? "";
  if (!shell.endsWith("/zsh")) findings.push(`root's login shell is '${shell}', not zsh`);
  for (const key of ["exec-home", "foreground-home"]) {
    const home = values.get(key) ?? "";
    if (home !== "/root") findings.push(`${key} is '${home}', not /root`);
  }
  return findings;
};
