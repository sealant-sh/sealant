import { describe, expect, it } from "vitest";

import {
  isolatedNetworkCreateArgv,
  probeIsolatedGatewaySupport,
} from "./docker-isolated-network.js";
import type { DockerCommandRunner } from "./docker-runtime-adapter.js";

describe("isolatedNetworkCreateArgv", () => {
  it("makes an internal bridge whose gateway has no host address, IPv6 isolated too when set", () => {
    expect(
      isolatedNetworkCreateArgv({
        name: "sealant-run-egress",
        subnet: "10.233.0.0/29",
        labels: { "sealant.workspace": "sealant-run" },
      }),
    ).toEqual([
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--opt",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "--subnet",
      "10.233.0.0/29",
      "--label",
      "sealant.workspace=sealant-run",
      "sealant-run-egress",
    ]);
    const dual = isolatedNetworkCreateArgv({
      name: "n",
      subnet: "10.233.0.0/29",
      ipv6Subnet: "fd00:5ea1::/64",
    });
    expect(dual.slice(dual.indexOf("--ipv6"), -1)).toEqual([
      "--ipv6",
      "--subnet",
      "fd00:5ea1::/64",
      "--opt",
      "com.docker.network.bridge.gateway_mode_ipv6=isolated",
    ]);
  });
});

/** A Docker that answers the probe's three steps as told, recording what it was asked. */
const probeDocker = (answers: {
  readonly version?: string;
  readonly create?: "refused";
  readonly bridgeAddresses?: string;
}) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: DockerCommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "version") return { stdout: `${answers.version ?? "29.1.0"}\n`, stderr: "" };
    if (args[0] === "network" && args[1] === "create") {
      if (answers.create === "refused") {
        throw Object.assign(new Error("exit 1"), {
          stderr: "failed to parse com.docker.network.bridge.gateway_mode_ipv4 value: isolated",
        });
      }
      return {
        stdout: "9ff7134250bb5416ddce7d55dc87b8951f4dbe10de50b782da2bd4779f68fb83\n",
        stderr: "",
      };
    }
    if (args[0] === "run") return { stdout: answers.bridgeAddresses ?? "", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
};

describe("probeIsolatedGatewaySupport", () => {
  it("proves support by the bridge having no host address, and removes its network", async () => {
    const docker = probeDocker({});
    await expect(
      probeIsolatedGatewaySupport({ run: docker.run, image: "busybox" }),
    ).resolves.toEqual({
      supported: true,
      engineVersion: "29.1.0",
    });
    const inspect = docker.calls.find((args) => args[0] === "run") ?? [];
    expect(inspect.slice(-2)).toEqual(["dev", "br-9ff7134250bb"]);
    expect(inspect).toContain("host");
    expect(docker.calls.at(-1)).toEqual([
      "network",
      "rm",
      "9ff7134250bb5416ddce7d55dc87b8951f4dbe10de50b782da2bd4779f68fb83",
    ]);
  });

  it("answers unsupported, with the reason, for an old, refusing or ignoring engine", async () => {
    const old = await probeIsolatedGatewaySupport({
      run: probeDocker({ version: "27.5.1" }).run,
      image: "busybox",
    });
    expect(old).toEqual({ supported: false, reason: expect.stringContaining("27.5.1") });

    const refusing = await probeIsolatedGatewaySupport({
      run: probeDocker({ create: "refused" }).run,
      image: "busybox",
    });
    expect(refusing).toEqual({
      supported: false,
      reason: expect.stringContaining("failed to parse"),
    });

    const ignoring = probeDocker({
      bridgeAddresses: "5554: br-9ff7134250bb    inet 192.168.80.1/20 scope global br-9ff7134250bb",
    });
    const result = await probeIsolatedGatewaySupport({ run: ignoring.run, image: "busybox" });
    expect(result).toEqual({ supported: false, reason: expect.stringContaining("host address") });
    expect(ignoring.calls.at(-1)?.slice(0, 2)).toEqual(["network", "rm"]);
  });
});
