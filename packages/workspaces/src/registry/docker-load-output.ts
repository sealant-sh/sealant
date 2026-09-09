/**
 * `docker load` reports what it imported on stdout/stderr; both image stores use this to learn the
 * identifier they should tag when the caller did not name the source image.
 */
export const parseDockerLoadOutput = (
  output: string,
): {
  references: Array<string>;
  imageIds: Array<string>;
} => {
  const references = [...output.matchAll(/^Loaded image: (.+)$/gm)].map(
    (match) => match[1]?.trim() ?? "",
  );
  const imageIds = [...output.matchAll(/^Loaded image ID: (.+)$/gm)].map(
    (match) => match[1]?.trim() ?? "",
  );

  return {
    references: references.filter((value) => value.length > 0),
    imageIds: imageIds.filter((value) => value.length > 0),
  };
};

export const selectLoadedImageIdentifier = (
  output: string,
  preferredIdentifier?: string,
): string => {
  if (preferredIdentifier !== undefined) {
    return preferredIdentifier;
  }

  const parsed = parseDockerLoadOutput(output);

  if (parsed.references.length === 1) {
    return parsed.references[0] as string;
  }

  if (parsed.references.length > 1) {
    throw new Error(
      `Docker load returned multiple tagged images (${parsed.references.join(", ")}). Provide sourceReference explicitly.`,
    );
  }

  if (parsed.imageIds.length === 1) {
    return parsed.imageIds[0] as string;
  }

  throw new Error("Could not determine a source image identifier from docker load output.");
};
