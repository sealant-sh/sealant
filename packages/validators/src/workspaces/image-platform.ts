import { z } from "zod";

/**
 * The platform a workspace image is planned and built for: the architecture of the Docker daemon
 * or the cluster nodes that run it. It is part of the image's plan hash, so an image built for
 * one is never reused for the other.
 */
export const workspaceImagePlatforms = ["linux/amd64", "linux/arm64"] as const;

export const workspaceImagePlatformSchema = z.enum(workspaceImagePlatforms);

export type WorkspaceImagePlatform = z.infer<typeof workspaceImagePlatformSchema>;
