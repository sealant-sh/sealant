/**
 * An image's per-person capability as the API reports it: the verdict of the image's probe
 * (`metadata.imageProbe`) with the runtime's `no_new_privs` and the declared ACL support; supported
 * only when nothing is missing or unknown.
 */
import type { WorkspaceImageProbe } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import { personLayoutCapability } from "./person-layout.js";

const ready: WorkspaceImageProbe = {
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
  gitTrustsWorktree: true,
  sealantd: { supports: ["dotfiles.user", "exec.user", "restore.owner_map"] },
};

describe("personLayoutCapability", () => {
  it("is supported only with a ready probe and declared ACLs", () => {
    expect(personLayoutCapability(ready, { runtime: "docker", acl: "supported" })).toEqual({
      status: "supported",
      missing: [],
      unknown: [],
      runtime: "docker",
      acl: "supported",
    });
    expect(personLayoutCapability(ready, { runtime: "docker", acl: undefined })).toMatchObject({
      status: "unknown",
      unknown: ["acl"],
    });
    expect(
      personLayoutCapability(undefined, { runtime: "docker", acl: "supported" }),
    ).toMatchObject({ status: "unknown", unknown: ["probe"] });
  });

  it("names what the image or the runtime lacks", () => {
    expect(
      personLayoutCapability(
        { ...ready, tools: { ...ready.tools, setpriv: false } },
        { runtime: "docker", acl: "unsupported" },
      ),
    ).toMatchObject({ status: "unsupported", missing: ["setpriv", "acl"] });
    // Kubernetes workspaces run with no_new_privs, where sudo cannot raise a person.
    expect(personLayoutCapability(ready, { runtime: "k8s", acl: "supported" })).toMatchObject({
      status: "unsupported",
      missing: ["sudo-no-new-privileges"],
    });
  });
});
