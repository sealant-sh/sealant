import { describe, expect, it } from "vitest";

import { planWorkspaceImageBuild } from "../../buildkit/index.js";
import { cases } from "../../runtime/docker-runtime-adapter.golden-fixture.js";
import { microvmImageName, microvmRecipe, mirroredBaseImage } from "./recipe.js";

const settings = {
  agentPort: 8080,
  memoryMiB: 4096,
  dockerService: false,
  contextDigest: "a".repeat(64),
};

const plannedFor = (family: "fedora" | "arch") =>
  planWorkspaceImageBuild({
    blueprint: {
      ...cases.gitSource.blueprint,
      target: { ...cases.gitSource.blueprint.target, os: { family, mode: "require" } },
    },
  });

describe("mirroredBaseImage", () => {
  it("pulls official Docker Hub images from their public ECR mirror", () => {
    expect(mirroredBaseImage("fedora:41")).toBe("public.ecr.aws/docker/library/fedora:41");
    expect(mirroredBaseImage("archlinux:latest")).toBe(
      "public.ecr.aws/docker/library/archlinux:latest",
    );
    expect(mirroredBaseImage("ubuntu@sha256:abc")).toBe(
      "public.ecr.aws/docker/library/ubuntu@sha256:abc",
    );
  });

  it("leaves a project's own base image exactly as written", () => {
    for (const reference of [
      "ghcr.io/acme/base:1",
      "acme/base:1",
      "registry.example.com:5000/base",
      "public.ecr.aws/docker/library/fedora:41",
      "localhost/base",
    ]) {
      expect(mirroredBaseImage(reference)).toBe(reference);
    }
  });
});

describe("microvmRecipe", () => {
  it("keeps the planned recipe and ends in the agent instead of the daemon", () => {
    const planned = plannedFor("fedora");
    const { containerfile } = microvmRecipe(planned, settings);

    // Built and booted by the managed image build on 2026-09-20 exactly as generated here.
    expect(containerfile).toMatch(/^FROM public\.ecr\.aws\/docker\/library\/fedora:/m);
    expect(containerfile).toContain("COPY --from=ghcr.io/sealant-sh/sealantd:");
    expect(containerfile).toContain("RUN node --version");
    expect(containerfile).toContain("COPY agent.mjs docker-service.mjs /opt/sealant/");
    expect(containerfile).toContain("ENV SEALANT_MICROVM_AGENT_PORT=8080");
    expect(containerfile.trimEnd().endsWith('ENTRYPOINT ["node", "/opt/sealant/agent.mjs"]')).toBe(
      true,
    );
    expect(containerfile).not.toContain('"sealantd", "boot"');
    // Everything the container recipe does is still there.
    for (const line of planned.containerfile.split("\n")) {
      if (line.startsWith("FROM ") || line.startsWith("ENTRYPOINT ")) continue;
      expect(containerfile).toContain(line);
    }
  });

  it("takes sealantctl from the same released daemon image as sealantd, for the hooks' capture flush", () => {
    const planned = plannedFor("fedora");
    const daemonImage = /--from=(\S+) \/usr\/local\/bin\/sealantd /.exec(
      planned.containerfile,
    )?.[1];
    expect(daemonImage).toMatch(/sealantd/);

    const { containerfile } = microvmRecipe(planned, settings);

    expect(containerfile).toContain(
      `COPY --chmod=755 --from=${String(daemonImage)} /usr/local/bin/sealantctl /usr/local/bin/sealantctl`,
    );
    expect(() =>
      microvmRecipe(
        {
          ...planned,
          containerfile: 'FROM fedora:41\nENTRYPOINT ["/usr/local/bin/sealantd", "boot"]\n',
        },
        settings,
      ),
    ).toThrow(/sealantctl/);
  });

  it("follows the blueprint's OS family", () => {
    expect(microvmRecipe(plannedFor("arch"), settings).containerfile).toMatch(
      /^FROM public\.ecr\.aws\/docker\/library\/archlinux:/m,
    );
  });

  it("hashes the recipe and the image settings, apart from the container plan's own hash", () => {
    const planned = plannedFor("fedora");
    const base = microvmRecipe(planned, settings).planHash;

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).not.toBe(planned.planHash);
    expect(microvmRecipe(planned, settings).planHash).toBe(base);
    expect(microvmRecipe(planned, { ...settings, memoryMiB: 8192 }).planHash).not.toBe(base);
    expect(microvmRecipe(planned, { ...settings, agentPort: 9090 }).planHash).not.toBe(base);
    expect(microvmRecipe(plannedFor("arch"), settings).planHash).not.toBe(base);
  });

  it("adds guest-local Docker only when asked, with the distro's own package manager", () => {
    const plain = microvmRecipe(plannedFor("fedora"), settings);
    expect(plain.containerfile).not.toContain("download-docker.sh");

    const fedora = microvmRecipe(plannedFor("fedora"), { ...settings, dockerService: true });
    expect(fedora.containerfile).toContain("RUN dnf -y install iproute iptables-nft kmod");
    expect(fedora.containerfile).toContain("RUN /opt/sealant/download-docker.sh");
    expect(fedora.containerfile).toContain("ENV SEALANT_MICROVM_DOCKER_CAPABLE=1");
    // A different image, so a workspace without Docker never boots the elevated one.
    expect(fedora.planHash).not.toBe(plain.planHash);

    expect(
      microvmRecipe(plannedFor("arch"), { ...settings, dockerService: true }).containerfile,
    ).toContain("RUN pacman -Sy --noconfirm --needed iproute2");
  });

  it("refuses guest-local Docker on a family it cannot install it for, naming the ones it can", () => {
    expect(() =>
      microvmRecipe(
        { ...plannedFor("fedora"), osFamily: "nix" },
        { ...settings, dockerService: true },
      ),
    ).toThrow(/needs one of the fedora, arch, ubuntu OS families; this blueprint resolves to nix/);
  });

  it("refuses a Containerfile it cannot build on", () => {
    expect(() =>
      microvmRecipe({ ...plannedFor("fedora"), containerfile: "FROM fedora:41\n" }, settings),
    ).toThrow(/no FROM or ENTRYPOINT/);
  });

  it("names the image within the platform's grammar", () => {
    const name = microvmImageName(microvmRecipe(plannedFor("fedora"), settings).planHash);
    expect(name).toMatch(/^sealant-ws-[0-9a-f]{24}$/);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
