import { describe, expect, it } from "vitest";

import {
  dockerdRegistryMirrorArgs,
  parseDockerRegistryMirrors,
  registryMirrorHostNames,
} from "./docker-registry-mirrors.js";

describe("parseDockerRegistryMirrors", () => {
  it("reads comma-separated origins in order, trimmed and without duplicates", () => {
    expect(
      parseDockerRegistryMirrors(
        " http://docker-mirror:5000 , https://mirror.gcr.io/,http://docker-mirror:5000",
      ),
    ).toEqual(["http://docker-mirror:5000", "https://mirror.gcr.io"]);
  });

  it.each([
    ["a non-URL", "docker-mirror:5000/"],
    ["another scheme", "ftp://docker-mirror"],
    ["credentials", "http://user:token@docker-mirror:5000"],
    ["a path", "http://docker-mirror:5000/v2"],
    ["a query", "http://docker-mirror:5000/?x=1"],
    ["a quote in the host", "http://docker'mirror:5000"],
    ["an IPv6 literal", "http://[::1]:5000"],
  ])("refuses %s", (_label, entry) => {
    expect(() => parseDockerRegistryMirrors(entry)).toThrow(/SEALANT_DOCKER_REGISTRY_MIRRORS/);
  });

  it("refuses a value that names no mirror", () => {
    expect(() => parseDockerRegistryMirrors(" , ")).toThrow(/names no mirror/);
  });
});

describe("dockerdRegistryMirrorArgs", () => {
  it("names a plain-http mirror insecure as well, so BuildKit reaches it over http", () => {
    expect(
      dockerdRegistryMirrorArgs(["http://docker-mirror:5000", "https://mirror.gcr.io"]),
    ).toEqual([
      "--registry-mirror=http://docker-mirror:5000",
      "--insecure-registry=docker-mirror:5000",
      "--registry-mirror=https://mirror.gcr.io",
    ]);
  });

  it("adds nothing without mirrors", () => {
    expect(dockerdRegistryMirrorArgs([])).toEqual([]);
  });
});

describe("registryMirrorHostNames", () => {
  it("names each host once, without its port", () => {
    expect(
      registryMirrorHostNames(["http://docker-mirror:5000", "https://docker-mirror:5443"]),
    ).toEqual(["docker-mirror"]);
  });
});
