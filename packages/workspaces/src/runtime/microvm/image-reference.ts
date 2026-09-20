/**
 * How a built MicroVM image is named in a `PublishedImage`: `<image ARN>:<version>`. An ARN has
 * colons and a version has none, so the last colon separates them. The image builder writes it
 * and the adapter reads it, and neither imports the other.
 */
const IMAGE_ARN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:microvm-image:[A-Za-z0-9_-]+$/;

export const microvmImageReference = (imageArn: string, version: string): string =>
  `${imageArn}:${version}`;

export const parseMicrovmImageReference = (
  reference: string,
): { readonly imageArn: string; readonly imageVersion: string } | undefined => {
  const at = reference.lastIndexOf(":");
  const imageArn = reference.slice(0, at);
  const imageVersion = reference.slice(at + 1);
  return at > 0 && IMAGE_ARN.test(imageArn) && imageVersion !== ""
    ? { imageArn, imageVersion }
    : undefined;
};
