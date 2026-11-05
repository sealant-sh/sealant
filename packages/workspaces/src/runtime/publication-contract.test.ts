import {
  microvmPublicationSchema,
  ociPublicationSchema,
  parseLegacyWorkspacePublication,
  type NativePublication,
  type MicrovmPublication,
  type OciPublication,
} from "@sealant/validators";
import { describe, expect, it } from "vitest";

import type { BoatNativeCatalogService } from "../images/boat/catalog.js";
import type { RegisteredRuntime } from "./registered-runtime.js";
import type { RuntimeAdapter, RuntimeLaunch } from "./runtime-adapter.js";

const correlation = (
  oci: RuntimeAdapter<OciPublication>,
  native: RuntimeAdapter<NativePublication>,
  microvm: RuntimeAdapter<MicrovmPublication>,
  nativeInput: RuntimeLaunch<NativePublication>,
  ociInput: RuntimeLaunch<OciPublication>,
  artifacts: BoatNativeCatalogService,
) => {
  // @ts-expect-error OCI launch cannot accept a native snapshot.
  void oci.launch(nativeInput);
  // @ts-expect-error Native launch cannot accept OCI coordinates.
  void native.launch(ociInput);
  // @ts-expect-error MicroVM launch cannot accept OCI coordinates.
  void microvm.launch(ociInput);
  // @ts-expect-error Registration cannot pair the native catalog with an OCI adapter.
  const wrong: RegisteredRuntime = { kind: "boat-native", artifacts, adapter: oci };
  return wrong;
};
void correlation;

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
