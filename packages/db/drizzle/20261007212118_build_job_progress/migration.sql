-- What the worker last saw of an image build in progress (step N of M, when it last wrote output),
-- so the API can report the workspace's image-build phase and a caller can tell a slow build that
-- is moving from one that stalled.
ALTER TABLE "oci_image_build_jobs" ADD COLUMN IF NOT EXISTS "progress" jsonb;
