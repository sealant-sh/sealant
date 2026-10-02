-- Deadline preservation's throughput sample keeps the queue's pending bytes beside the uploaded
-- bytes: a reading measures the link only when the queue held work at both ends of its interval.
ALTER TABLE "workspace_capture_drains" ADD COLUMN "upload_sample_pending_bytes" double precision;