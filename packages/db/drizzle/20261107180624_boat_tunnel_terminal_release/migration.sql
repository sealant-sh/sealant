ALTER TABLE "boat_tunnels" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "boat_tunnels_host_port";--> statement-breakpoint
CREATE UNIQUE INDEX "boat_tunnels_host_port" ON "boat_tunnels" ("gateway_host_id","listen_port") WHERE "released_at" is null;--> statement-breakpoint
ALTER TABLE "boat_tunnels" ADD CONSTRAINT "boat_tunnels_release" CHECK (coalesce("record"->'released', 'false'::jsonb) = to_jsonb("released_at" is not null));