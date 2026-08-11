import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readManifest = async (url: URL): Promise<unknown> => {
  return JSON.parse(await readFile(url, "utf8"));
};

describe("published Effect dependency contract", () => {
  it("lets the consumer provide one compatible Effect instance for both public packages", async () => {
    const sdkManifest = await readManifest(new URL("../package.json", import.meta.url));
    const contractsManifest = await readManifest(
      new URL("../../api-contracts/package.json", import.meta.url),
    );

    for (const manifest of [sdkManifest, contractsManifest]) {
      expect(manifest).toMatchObject({
        peerDependencies: { effect: ">=4.0.0-beta.85 <5" },
        devDependencies: { effect: "catalog:" },
      });
      expect(manifest).not.toMatchObject({
        dependencies: { effect: expect.anything() },
      });
    }
  });
});
