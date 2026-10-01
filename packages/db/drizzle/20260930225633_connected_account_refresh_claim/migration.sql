-- One refresh per login at a time, across every worker (docs/connected-accounts-design.md §6a "One
-- refresher"): a keep-fresh pass claims the account row until this instant. A crashed pass's claim
-- lapses on its own.
ALTER TABLE "connected_accounts" ADD COLUMN "refresh_claimed_until" timestamp with time zone;