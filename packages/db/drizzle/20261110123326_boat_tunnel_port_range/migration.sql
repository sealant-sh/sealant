-- A run's gateway is given one host port. The sixteen of the first allocator (40000 to 40015) had
-- to be opened to the Internet for VMs to dial; the gateway's port is now published on the relay
-- host address alone and reached only by Core's own carrier, so the allocator hands out 61000 to
-- 61511, above Linux's default ephemeral range. The old sixteen stay valid: a reservation made
-- before this migration keeps its port until its run ends, and no row is rewritten.
ALTER TABLE "boat_tunnels" DROP CONSTRAINT "boat_tunnels_port", ADD CONSTRAINT "boat_tunnels_port" CHECK ("listen_port" between 61000 and 61511 or "listen_port" between 40000 and 40015);
