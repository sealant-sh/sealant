import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { boatTunnelConfigDigests } from "./boat-tunnel.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

it("recognises a gateway by the label either release gave it, and makes only the relayed one", () => {
  const identity = {
    binding: "b".repeat(64),
    publicKey: Buffer.alloc(32, 5).toString("base64"),
    peerKey: Buffer.alloc(32, 6).toString("base64"),
    listenPort: 40007,
    gatewayImage: `sha256:${"a".repeat(64)}`,
  };
  const digests = boatTunnelConfigDigests(identity, "127.0.0.1");
  // As the release before this one labelled a gateway, spelled out key by key: with the relay
  // host when it carried every tunnel, without it when VMs dialled the gateway (its port was then
  // published on every interface). A changed formula would orphan every live session's gateway.
  expect(digests.relayed).toBe(
    sha256(
      `{"binding":"${identity.binding}","publicKey":"${identity.publicKey}","peerKey":"${identity.peerKey}","listenPort":40007,"gatewayImage":"${identity.gatewayImage}","publishHost":"127.0.0.1"}`,
    ),
  );
  expect(digests.dialled).toBe(
    sha256(
      `{"binding":"${identity.binding}","publicKey":"${identity.publicKey}","peerKey":"${identity.peerKey}","listenPort":40007,"gatewayImage":"${identity.gatewayImage}"}`,
    ),
  );
  expect(digests.relayed).not.toBe(digests.dialled);
  // The label follows the relay host: a gateway is never mistaken for one published elsewhere.
  expect(boatTunnelConfigDigests(identity, "172.17.0.1").relayed).not.toBe(digests.relayed);
  expect(boatTunnelConfigDigests(identity, "172.17.0.1").dialled).toBe(digests.dialled);
  // Whatever order a caller builds the identity in, the label is the same.
  const { gatewayImage, listenPort, ...rest } = identity;
  expect(boatTunnelConfigDigests({ gatewayImage, ...rest, listenPort }, "127.0.0.1")).toEqual(
    digests,
  );
});
