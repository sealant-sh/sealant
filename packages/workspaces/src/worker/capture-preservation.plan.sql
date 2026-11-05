\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('sealant.capture_ledger', '3', true);
CREATE TEMP TABLE parking_plan_owner ON COMMIT DROP AS
  SELECT 'parking-plan-' || gen_random_uuid()::text AS id;
INSERT INTO "user" (id, name, email, created_at, updated_at)
  SELECT id, 'parking query diagnostic', id || '@example.invalid', now(), now()
  FROM parking_plan_owner;
INSERT INTO workspace_attempts (id, owner_user_id, status, queued_at, created_at, updated_at)
  SELECT o.id || '-' || n, o.id, 'succeeded', now(), now(), now()
  FROM parking_plan_owner o CROSS JOIN generate_series(1, 25000) n;
INSERT INTO workspace_capture_drains (run_id, state, created_at, updated_at)
  SELECT o.id || '-' || n, 'gone', now(), now()
  FROM parking_plan_owner o CROSS JOIN generate_series(1, 25000) n;
ANALYZE workspace_capture_drains;
SELECT custody_contract, count(*) AS roots, count(next_preservation_action_at) AS scheduled
  FROM workspace_capture_drains GROUP BY custody_contract;
EXPLAIN (ANALYZE, BUFFERS)
SELECT run_id FROM workspace_capture_drains
WHERE custody_contract = 3 AND retention_episode_id IS NOT NULL
  AND (preservation_claim_until IS NULL OR preservation_claim_until <= now())
  AND lease_owner IS NULL AND recovery_lease_token IS NULL AND deletion_state IS NULL
  AND next_preservation_action_at IS NOT NULL AND next_preservation_action_at <= now()
ORDER BY next_preservation_action_at, run_id LIMIT 10 FOR UPDATE SKIP LOCKED;
SELECT run_id AS parking_plan_run_id FROM workspace_capture_drains
WHERE custody_contract = 3 AND retention_episode_id IS NOT NULL
  AND (preservation_claim_until IS NULL OR preservation_claim_until <= now())
  AND lease_owner IS NULL AND recovery_lease_token IS NULL AND deletion_state IS NULL
  AND next_preservation_action_at IS NOT NULL AND next_preservation_action_at <= now()
ORDER BY next_preservation_action_at, run_id LIMIT 1;
\gset
EXPLAIN (ANALYZE, BUFFERS)
UPDATE workspace_capture_drains SET preservation_claim_token = gen_random_uuid(),
  preservation_claim_until = now() + interval '120 seconds',
  preservation_claim_fence = preservation_claim_fence + 1
WHERE run_id = :'parking_plan_run_id' AND custody_contract = 3 AND retention_episode_id IS NOT NULL
  AND (preservation_claim_until IS NULL OR preservation_claim_until <= now())
  AND lease_owner IS NULL AND recovery_lease_token IS NULL AND deletion_state IS NULL
RETURNING run_id, preservation_claim_fence, custody_revision;
ROLLBACK;
