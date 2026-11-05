import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type PublishedImage } from "@sealant/validators";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const imageIdSchema = z
  .string()
  .trim()
  .regex(/^sha256:[a-f0-9]{64}$/);

export const inspectLocalPublishedImage = async (
  image: Pick<PublishedImage, "repository" | "tag" | "reference">,
): Promise<PublishedImage> => {
  const result = await execFileAsync("docker", [
    "image",
    "inspect",
    image.reference,
    "--format",
    "{{.Id}}",
  ]);
  const digest = imageIdSchema.parse(result.stdout);
  return { ...image, digestReference: digest, digest };
};
