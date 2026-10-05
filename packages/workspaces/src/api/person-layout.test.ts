/**
 * An image's per-person capability: supported only when the probe found everything and the
 * operator declared ACLs; whatever is missing named; nothing known is never `supported`.
 */
import { describe, expect, it } from "vitest";

import { personLayoutCapability, type PersonLayoutProbe } from "./person-layout.js";

const capable: PersonLayoutProbe = {
  sealantd: { execUser: true, dotfilesUser: true, restoreOwnerMap: true },
  tools: { sudo: true, useradd: true, setfacl: true },
  reservedIdsFree: true,
  nix: false,
};

describe("personLayoutCapability", () => {
  it("is supported only with a full probe and declared ACLs", () => {
    expect(personLayoutCapability(capable, { runtime: "docker", acl: "supported" })).toEqual({
      status: "supported",
      missing: [],
      runtime: "docker",
      acl: "supported",
    });
    expect(personLayoutCapability(capable, { runtime: "docker", acl: undefined }).status).toBe(
      "unknown",
    );
    expect(personLayoutCapability(undefined, { runtime: "docker", acl: "supported" }).status).toBe(
      "unknown",
    );
  });

  it("names everything the image or the runtime lacks", () => {
    const answer = personLayoutCapability(
      {
        sealantd: { execUser: false, dotfilesUser: true, restoreOwnerMap: false },
        tools: { sudo: true, useradd: false, setfacl: true },
        reservedIdsFree: false,
        nix: true,
      },
      { runtime: "microvm", acl: "unsupported" },
    );
    expect(answer.status).toBe("unsupported");
    expect(answer.missing).toEqual([
      "sealantd exec.user",
      "sealantd restore.owner_map",
      "useradd",
      "a user or group in 40000–49999",
      "a nix image takes one person",
      "ACLs on /workspace",
    ]);
    expect(personLayoutCapability(undefined, { runtime: "k8s", acl: "unsupported" })).toMatchObject(
      { status: "unsupported", missing: ["ACLs on /workspace"] },
    );
  });
});
