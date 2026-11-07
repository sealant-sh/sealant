CREATE TABLE "boat_tunnels" (
	"runtime_instance_id" text PRIMARY KEY,
	"gateway_host_id" uuid NOT NULL,
	"listen_port" integer NOT NULL,
	"reservation_id" uuid NOT NULL UNIQUE,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boat_tunnels_port" CHECK ("listen_port" between 40000 and 40015),
	CONSTRAINT "boat_tunnels_identity" CHECK (coalesce("record"->'binding'->'target'->>'runtimeInstanceId' = "runtime_instance_id" and "record"->'binding'->>'gatewayHostId' = "gateway_host_id"::text and "record"->>'reservationId' = "reservation_id"::text and ("record"->>'listenPort')::integer = "listen_port", false))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "boat_tunnels_host_port" ON "boat_tunnels" ("gateway_host_id","listen_port");--> statement-breakpoint
ALTER TABLE "boat_tunnels" ADD CONSTRAINT "boat_tunnels_TblMwvLQ8gCt_fkey" FOREIGN KEY ("runtime_instance_id") REFERENCES "boat_executions"("runtime_instance_id") ON DELETE RESTRICT;