# Native Boat guest startup, 2026-11-06

This layer packages the native guest and its private dependency bundle in the worker. Boat remains unregistered and ordinary session admission is unavailable. The guest starts held, checks compatibility and requires a fresh binding for each VM and kernel boot. Authenticated production binding delivery, end-to-end admission, complete cold positive acceptance and the parking executor remain later layers.

## Decisions

Yiannis chose the guard scope on 2026-11-06. Hash-gate shipped guest code, units and binaries. During reads, retain SHA-256, device/inode, owner, mode, size and link-count checks, and ignore timestamp drift. Restrict mapping checks to our guest processes and their children, and to files in the shipped bundle. Exclude base-image processes and base-image hash profiles. A deleted owned mapping still refuses; a durably fenced bounded restart and recheck is required. Keep the 60-second deadline, two-second interval and three stable observations.

The checks detect a broken or mismatched guest, rather than a determined attacker. Timestamp drift grants nothing while the retained identity and content fields match. PID 1 belongs to the base image and routinely retains replaced libraries.

`binding_for` rejects an instance.json from another boot. A cold clone therefore starts unbound. The diagnostic supplies a fresh clone/current-boot binding. This does not implement authenticated production binding delivery or enable admission.

The durability investigation is closed. Created, edited, renamed and Git files survived the bare-image cycles with and without sync. Changed base-image files under /etc and /usr/share/doc also survived after sync. Boat restores its own /usr/lib/systemd/systemd executable; two upgraded libraries and dpkg metadata had survived, causing a mixed package family. Parking keeps a plain sync before stop as hygiene, not as a fix for user-file durability. The draft Boat question remains unsent.

The base .bashrc changed to different bytes of the same length on clone. Only hashes and sizes were retained, so the exact sandbox-ID or hostname substitution cannot be established offline. This remains the known Boat clone rewrite. No additional VM was allocated for it.

## Base-matching systemd

Option 2 was used. The mapped launcher requires systemd-nspawn, copied by build_guest.py into the private bundle, so systemd-container cannot be removed. The current 8.18 package requires libsystemd-shared 8.18 exactly. The recipe instead installs systemd-container 255.4-1ubuntu8.16 from the Ubuntu snapshot at 20260731T000000Z. It verifies the compressed Packages index SHA-256, the exact version/path/hash entry in that index, and the downloaded .deb SHA-256.

Index SHA-256: f5272e19da9bf902d3e6ccb9878261086bad3cfbb4937f060984cfdc33b71b22.
Package SHA-256: 7ab146ac98bf9c6095935b37a906d589795105c301626f2fd5db6d0e77bd9472.

Every installed package from the systemd source is held, including systemd, systemd-sysv, libsystemd0, libsystemd-shared, libudev1 and related installed packages. The matching systemd-container is held after installation. Exact versions are checked before installation, after installation and after the complete recipe. A provider base with different versions refuses rather than silently upgrading or downgrading.

Ubuntu and Nix share this outer bootstrap and hold policy. Nix's own bootstrap runs in the mapped root and does not upgrade the base image's systemd. The mapped root's packages are separate from the provider's PID 1 and libraries.

## Verification

Forced root typecheck and lint each passed all 20 tasks with zero cached tasks. All 37 guest tests passed. Native/provider tests passed 104 cases; 12 unrelated Postgres catalog cases were skipped without a configured database. All six exact-bundle HTTP builder tests passed, including current approval acceptance and old approval refusal before save. The standalone packaged worker checker verified both Ubuntu and Nix recipes. The emitted bootstrap passed with real apt/dpkg in an owned Ubuntu container and kept all required packages held at 8.16. Snapshot-verifier controls accepted exact bytes and refused corrupt indexes, wrong versions and changed package bytes. Compressed cold staging and null-staging refusal controls passed. Isolated pnpm format:fix preserved historical evidence.

The first guest-test invocation under the host user failed because private records require root ownership. The supported mapped-root invocation passed. The local apt fixture first lacked CA certificates, then refused baseline setup downgrades; both failures and cleanup were retained. These were local fixture setup issues. The final fixture used matching baseline packages, and the production script contains no downgrade or held-package override.

## Live result

The held-8.16 cold proof has not passed. The first source completed real Nix recipe construction in 344.213 seconds and passed source semantics, but its observer export lacked the required fsync receipt and refused before stop. The bounded export sampling fix passed a local delayed-fsync regression. The replacement source then returned an unknown construction outcome after 30.216 seconds, with no HTTP status or guest result retained by that transport. Neither attempt stopped, saved or created a clone. A gateway timeout is possible but is not established by the recorded evidence. Both sources were deleted and complete final inventories are empty. A newly authorized run will record construction transport details and attach its result in a PR comment. This PR claims no held-8.16 restored-startup proof or cold acceptance.

First source `bx_pr3q4dkn` was deleted by completed operation `bdop_370c62589f2842a3bedac5dc070a6f4b`. Replacement `bx_y8j3h2sq` was deleted by completed operation `bdop_9e1a544d1a0e4b8d83b05738ec217a5b`. Both complete inventories reported no sandboxes, no saved snapshots, no further pages and no remaining owned obligations. No box was accessed. No Boat question was sent.

The raw immutable ledger, input pins and historical failed evidence remain in the local audit checkout and backup history. The shipping PR contains application changes and this report; it does not publish the accumulated diagnostic archives.
