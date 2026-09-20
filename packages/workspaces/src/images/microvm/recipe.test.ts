import { describe, expect, it } from "vitest";

import { planWorkspaceImageBuild } from "../../buildkit/index.js";
import { cases } from "../../runtime/docker-runtime-adapter.golden-fixture.js";
import {
  ARCHLINUXARM_KEY_FINGERPRINT,
  microvmImageName,
  microvmRecipe,
  mirroredBaseImage,
} from "./recipe.js";

const settings = {
  agentPort: 8080,
  memoryMiB: 4096,
  dockerService: false,
  contextDigest: "a".repeat(64),
};

const plannedFor = (family: "fedora" | "arch" | "ubuntu") =>
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

  it("builds Arch from the signed Arch Linux ARM rootfs, since Docker Hub's archlinux is x86_64 only", () => {
    const { containerfile } = microvmRecipe(plannedFor("arch"), settings);
    expect(containerfile).toMatch(
      /^FROM public\.ecr\.aws\/docker\/library\/fedora:41 AS archlinuxarm$/m,
    );
    expect(containerfile).toContain("COPY archlinuxarm-builder.asc /tmp/archlinuxarm-builder.asc");
    expect(containerfile).toContain(ARCHLINUXARM_KEY_FINGERPRINT);
    expect(containerfile).toContain(
      "gpg --batch --verify /tmp/rootfs.tar.gz.sig /tmp/rootfs.tar.gz",
    );
    expect(containerfile).toMatch(/^FROM scratch$/m);
    expect(containerfile).toContain("pacman-key --populate archlinuxarm");
    expect(containerfile).not.toContain("FROM public.ecr.aws/docker/library/archlinux");
    // The rest of the planned recipe, the family's own packages and the agent, follows unchanged.
    expect(containerfile).toContain("pacman -S");
    expect(containerfile).toContain('ENTRYPOINT ["node", "/opt/sealant/agent.mjs"]');
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
    expect(microvmRecipe(plannedFor("ubuntu"), settings).containerfile).toMatch(
      /^FROM public\.ecr\.aws\/docker\/library\/ubuntu:/m,
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

  it("installs what guest-local Docker needs on every managed family, and refuses a custom base", () => {
    for (const family of ["fedora", "arch", "ubuntu", "nix"] as const) {
      const { containerfile } = microvmRecipe(
        { ...plannedFor("fedora"), osFamily: family },
        { ...settings, dockerService: true },
      );
      expect(containerfile).toContain("download-docker.sh");
      expect(containerfile).toMatch(/iproute2?\b/);
    }
    // A custom base image brings its own package manager, which the recipe cannot drive.
    expect(() =>
      microvmRecipe(
        { ...plannedFor("fedora"), osFamily: "custom" },
        { ...settings, dockerService: true },
      ),
    ).toThrow(
      /needs one of the fedora, arch, ubuntu, nix OS families; this blueprint resolves to custom/,
    );
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
