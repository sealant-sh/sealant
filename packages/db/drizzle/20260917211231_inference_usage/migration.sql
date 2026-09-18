CREATE TABLE "inference_usage" (
	"owner_user_id" text,
	"day" text,
	"exchanges" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inference_usage_pkey" PRIMARY KEY("owner_user_id","day")
);
--> statement-breakpoint
ALTER TABLE "inference_usage" ADD CONSTRAINT "inference_usage_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;