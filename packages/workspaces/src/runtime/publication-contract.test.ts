import {
  microvmPublicationSchema,
  ociPublicationSchema,
  parseLegacyWorkspacePublication,
  type NativePublication,
  type MicrovmPublication,
  type OciPublication,
} from "@sealant/validators";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { BoatNativeCatalogService } from "../images/boat/catalog.js";
import type { RegisteredRuntime } from "./registered-runtime.js";
import type { RuntimeAdapter, RuntimeLaunch } from "./runtime-adapter.js";

const hash = "a".repeat(64);
const legacy = {
  publicationId: "legacy-job",
  evidence: { planHash: hash },
  image: {
    repository: "example",
    tag: "test",
    reference: "example:test",
    digestReference: `example@sha256:${hash}`,
    digest: `sha256:${hash}`,
  },
};

describe("publication contracts", () => {
  it("correlates launch and registration with the publication kind", () => {
    expectTypeOf<RuntimeLaunch<NativePublication>>().not.toExtend<
      Parameters<RuntimeAdapter["launch"]>[0]
    >();
    expectTypeOf<RuntimeLaunch<OciPublication>>().not.toExtend<
      Parameters<RuntimeAdapter<NativePublication>["launch"]>[0]
    >();
    expectTypeOf<RuntimeLaunch<OciPublication>>().not.toExtend<
      Parameters<RuntimeAdapter<MicrovmPublication>["launch"]>[0]
    >();
    expectTypeOf<{
      kind: "boat-native";
      artifacts: BoatNativeCatalogService;
      adapter: RuntimeAdapter;
    }>().not.toExtend<RegisteredRuntime>();
  });

  it("reads a historical OCI record with actual registry coordinates", () => {
    expect(parseLegacyWorkspacePublication(legacy)).toMatchObject({
      kind: "oci",
      image: legacy.image,
    });
  });
  it("parses the existing MicroVM ARN/version projection into provider facts", () => {
    const imageArn = "arn:aws:lambda:eu-central-1:123456789012:microvm-image:test";
    const parsed = parseLegacyWorkspacePublication({
      ...legacy,
      image: { ...legacy.image, reference: `${imageArn}:1.0`, digestReference: `${imageArn}:1.0` },
    });
    expect(parsed).toMatchObject({
      kind: "microvm",
      image: { imageArn, imageVersion: "1.0", planHash: hash },
    });
    expect(microvmPublicationSchema.safeParse(parsed).success).toBe(true);
    expect(ociPublicationSchema.safeParse({ ...parsed, kind: "oci" }).success).toBe(false);
  });
  it.each([hash, "native-snapshot", "00000000-0000-4000-8000-000000000001", "boat:snapshot"])(
    "rejects native identity %s as an OCI digest",
    (digest) => {
      expect(
        ociPublicationSchema.safeParse({
          ...legacy,
          kind: "oci",
          image: { ...legacy.image, digest, digestReference: digest },
        }).success,
      ).toBe(false);
    },
  );
});
