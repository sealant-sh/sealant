import { z } from "zod";

import { parseMicrovmImageReference } from "./microvm-image-reference.js";
import { nativePublicationSchema } from "./native-publication.js";
import { workspaceImageProbeSchema } from "./workspace-image-probe.js";

/** Actual OCI store coordinates, including the store's content digest. */
export const publishedImageSchema = z.strictObject({
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  digestReference: z.string().trim().min(1),
  digest: z.string().trim().min(1),
});

/** Facts observed during an OCI or MicroVM build. Missing historical evidence stays unknown. */
export const imageEvidenceSchema = z.object({
  planHash: z.string().trim().min(1).optional(),
  imageProbe: workspaceImageProbeSchema.optional(),
});

/** OCI publications retain their real store identity. */
export const ociPublicationSchema = z
  .object({
    kind: z.literal("oci"),
    publicationId: z.string().trim().min(1),
    image: publishedImageSchema,
    evidence: imageEvidenceSchema,
  })
  .refine(
    (p) =>
      /^sha256:[A-Za-z0-9_+.-]+$/.test(p.image.digest) &&
      (p.image.digestReference === p.image.digest ||
        p.image.digestReference.endsWith(`@${p.image.digest}`)) &&
      !p.image.reference.startsWith("boat:") &&
      !p.image.digestReference.startsWith("boat:"),
  );

/** MicroVM provider identity is distinct from the compatibility OCI projection. */
export const microvmPublicationSchema = z.object({
  kind: z.literal("microvm"),
  publicationId: z.string().trim().min(1),
  image: z.object({
    imageArn: z
      .string()
      .regex(/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:microvm-image:[A-Za-z0-9_-]+$/),
    imageVersion: z
      .string()
      .min(1)
      .regex(/^[^:]+$/),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  evidence: imageEvidenceSchema,
});

/** One parsed representation crosses job, runtime and inspection boundaries. */
export const workspacePublicationSchema = z.discriminatedUnion("kind", [
  ociPublicationSchema,
  microvmPublicationSchema,
  nativePublicationSchema,
]);

/** Registry facts consumed only by OCI adapters. */
export type PublishedImage = z.infer<typeof publishedImageSchema>;
/** Publication accepted by container adapters. */
export type OciPublication = z.infer<typeof ociPublicationSchema>;
/** Publication accepted by the existing MicroVM adapter. */
export type MicrovmPublication = z.infer<typeof microvmPublicationSchema>;
/** Persisted publication retains the artifact kind and its factual evidence. */
export type WorkspacePublication = z.infer<typeof workspacePublicationSchema>;

/** Parse old rows only when they contain complete OCI or the existing MicroVM coordinates. */
export const parseLegacyWorkspacePublication = (input: {
  readonly publicationId: string;
  readonly image: PublishedImage;
  readonly evidence: z.infer<typeof imageEvidenceSchema>;
}): WorkspacePublication => {
  const microvm = parseMicrovmImageReference(input.image.digestReference);
  return microvm === undefined
    ? ociPublicationSchema.parse({ kind: "oci", ...input })
    : microvmPublicationSchema.parse({
        kind: "microvm",
        publicationId: input.publicationId,
        image: {
          ...microvm,
          planHash: input.evidence.planHash ?? input.image.digest.replace(/^sha256:/, ""),
        },
        evidence: input.evidence,
      });
};

/** Parse tagged rows and the complete historical image projection at the repository boundary. */
export const parsePersistedWorkspacePublication = (row: {
  readonly id: string;
  readonly publication: unknown;
  readonly publicationId: string | null;
  readonly repository: string;
  readonly tag: string;
  readonly publishedReference: string | null;
  readonly publishedDigestReference: string | null;
  readonly publishedDigest: string | null;
  readonly evidence: z.infer<typeof imageEvidenceSchema>;
}): WorkspacePublication | null => {
  if (row.publication != null) {
    const publication = workspacePublicationSchema.parse(row.publication);
    if (row.publicationId !== publication.publicationId)
      throw new Error("Publication identity mismatch.");
    return publication;
  }
  if (row.publicationId !== null) throw new Error("Publication identity without a publication.");
  if (
    row.publishedReference === null &&
    row.publishedDigestReference === null &&
    row.publishedDigest === null
  )
    return null;
  return parseLegacyWorkspacePublication({
    publicationId: row.id,
    image: publishedImageSchema.parse({
      repository: row.repository,
      tag: row.tag,
      reference: row.publishedReference,
      digestReference: row.publishedDigestReference,
      digest: row.publishedDigest,
    }),
    evidence: row.evidence,
  });
};
