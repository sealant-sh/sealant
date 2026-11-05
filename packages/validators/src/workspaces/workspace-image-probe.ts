import { z } from "zod";

/**
 * What the image probe found inside a built workspace image: whether it can run one Linux user per
 * person (Mend's ADR 0016). The image writes it to `/etc/sealant/image-probe.json` in its last
 * filesystem step; the builder that can read it back records it on the build. Facts only: the
 * verdict is derived from them (`imagePersonLayoutSupport` in `@sealant/workspaces`), and runtime
 * facts such as ACL support on `/workspace` are not in it.
 */
export const workspaceImageProbeSchema = z.object({
  version: z.literal(1),
  tools: z.object({
    sudo: z.boolean(),
    /** `sudo` carries its setuid bit (the nix store cannot hold one). */
    sudoSetuid: z.boolean(),
    useradd: z.boolean(),
    groupadd: z.boolean(),
    setfacl: z.boolean(),
    getfacl: z.boolean(),
    setpriv: z.boolean(),
    /** Absent from images probed before it was recorded: unknown. */
    flock: z.boolean().optional(),
  }),
  /** `/etc/sudoers.d/mend` exists: the `mend` group's passwordless rule. */
  sudoersMend: z.boolean(),
  /** `/etc/sudoers` reads `/etc/sudoers.d`, so a rule can be added there. */
  sudoersIncludesDir: z.boolean(),
  /**
   * The probe ran under `no_new_privs`, where `sudo` cannot raise a person's privileges. Always
   * false at build; a probe run at prepare sees the runtime's (Kubernetes pods set it).
   */
  noNewPrivileges: z.boolean(),
  /** `/etc/passwd` is a regular, writable file (on nix it links into the read-only store). */
  passwdWritable: z.boolean(),
  /** The `mend` group: gid 40000, missing, or the name or the gid taken by something else. */
  mendGroup: z.enum(["present", "absent", "conflict"]),
  /** Users and groups other than `mend` in the reserved id range 40000–49999, as `user:name:id`. */
  reservedIdsInUse: z.array(z.string()),
  /** `/etc/sealant/person-env` exists: the environment of a process run as a person. */
  personEnv: z.boolean(),
  /** The shared toolchain and cache directories the image names, for the default ACL at boot. */
  sharedDirs: z.array(z.string()),
  /**
   * git, as the probe's user, trusts `/workspace/repo` whoever owns it (`safe.directory` lists `*`
   * or that path). Absent from images probed before it was recorded: unknown.
   */
  gitTrustsWorktree: z.boolean().optional(),
  /**
   * What `sealantd capabilities --json` printed: null when that sealantd has no such command,
   * `"unreadable"` when it answered with something other than a JSON object.
   */
  sealantd: z.union([z.record(z.string(), z.unknown()), z.literal("unreadable")]).nullable(),
});
