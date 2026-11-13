# Native Boat build failure, 2026-11-08

The single authorized live reproduction failed during project package installation because sealant's
native Ubuntu root enabled only `main`. The shared Ubuntu catalog needs `universe`. This is
sealant's native bootstrap configuration, before sealantd launches a workspace. Enabling
`main,universe` in the emitted debootstrap command fixes package resolution. No daemon or project
configuration change is involved.

## Live result

The builder ran from commit `9b1ef4d6d9f1ab5628d61223c0b01c567f3c838d`, based on main
`0b327e4c22b58cf1b7a15dba491eab0639a6d377`. It used the supplied Ubuntu request with all 22 package
IDs and the pinned `sealantd-next:0.21.0-next.180` runtime. Launch-only credential refs, user
environment values and the actual capture endpoint were omitted. Package IDs had no version or
manager overrides, matching the failed request.

The `install-recipe` command returned a normal transport response after **167,057 ms** with exit
code **100** and `timedOut: false`. The complete builder call, including cleanup, took 183,555 ms.
The fresh guest passed its shipped-code guard with three stable observations before the project
installer failed. This reproduction gives no evidence of a long-command transport timeout.

The relevant redacted stderr was:

```text
E: Unable to locate package nodejs
E: Unable to locate package npm
E: Unable to locate package gh
E: Unable to locate package bat
E: Unable to locate package ripgrep
E: Unable to locate package fd-find
E: Unable to locate package fzf
E: Unable to locate package zsh-autosuggestions
E: Unable to locate package zsh-syntax-highlighting
E: Unable to locate package direnv
E: Unable to locate package redis-tools
native recipe line 65 exited 100
```

The native debootstrap command had no `--components` option. Its generated sources contained only
`noble main`; the installer output records `noble/main`, followed by the package lookup failures.
The correction specifies `--components=main,universe`. It does not alter the outer systemd hold,
base-image hash policy or guest guards.

## Diagnostics

Failed guest commands now carry a fixed step label, nullable exit code, timeout flag and separate
stdout/stderr tails, each capped at 4,096 UTF-8 bytes. The builder persists the same diagnostic
before cleanup and keeps it through `NativeBuildError`, catalog translation and the worker's logged
error. Existing version-1 journals without the optional diagnostic remain readable.

Control characters, authentication values, URLs, private keys, secret assignments and supplied
environment values of at least eight characters are redacted before truncation. Command text is
never included. The native recipe also reports the failing shell line and exit code without printing
the command.

## Dotfiles discrepancy

With no dotfiles source or archive, toggling `applyDotfiles` produces identical native installation
shell and project-install bytes. No dotfiles are cloned or bootstrapped. The flag still contributes
to the request and static boot configuration. The difference from the project's setting is a
separate Mend mapping detail, not the cause of this package-install failure.

## Verification and limits

The diagnostics regression first failed in both nonzero-exit and timeout HTTP controls, then passed
with bounded safe output in the error and completed journal. A real PostgreSQL build-job test also
verifies catalog/worker propagation and exact fixture deletion. The complete focused run passed 28
unit/database tests and eight builder HTTP lifecycle tests. Forced typecheck and lint passed all 20
tasks each. All five workflow runner controls passed.

The local Docker regression executes the actual emitted debootstrap command, then resolves the
shared Ubuntu apt package selection in that root with apt's install simulation. It uses the 22
package requests, Codex and zsh. The original command reproduced the missing-package failure. The
fixed command resolved the whole apt selection, including nodejs, npm, gh and redis-tools, in 141.43
seconds. CI and Next run this regression without a skip condition. An initial local test revision
left an extracted subshell unclosed. That test-only failure was retained and corrected before
relying on the positive result.

This verifies apt package resolution, not downloads from the later release/npm installers or a
complete successful native build. The one authorized Boat build was used for the reproduction; there
was no second provider build after the fix. Full launch acceptance remains pending the
orchestrator's next session proof. A new Mend preview with the fixed sealant worker is required.

## Exact cleanup

- Owned scratch VM: `bx_8btvuy3q`.
- Build journal: `b4578885-fc43-4ff3-9526-5861d0d97b31`.
- Positive deletion receipt: `bdop_d54b14d758794c16b5d567dd0b933175`.
- Journal phase: `complete`; allocation: `deleted`; save: `none`.
- Same-journal cleanup returned success after the builder's cleanup.
- Complete final Boat inventory: `sandboxes: []`, `snapshots: []`, `pages: 1`.

All provider resources used `sealant-dev=boat-stream`. No snapshot was created. No VM 131 access or
writes occurred. The credential was read only by the production file loader in a mapped-root user
namespace. Only its permission metadata was temporarily tightened to 0400 and restored to 0600
afterwards; its bytes were never copied to a file, environment variable or argument.

All three local Docker regression containers and the disposable Postgres container were removed. The
owned runtime-bundle copy was removed; the original bundle remains intact.

The safe operations log and original completed journal remain locally under
`.audit/boat-native-build-diagnostics-20261108/live-1/`.
