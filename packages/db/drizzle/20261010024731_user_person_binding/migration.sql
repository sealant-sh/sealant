CREATE TABLE "user_person_binding" (
	"user_id" text PRIMARY KEY,
	"person_id" text NOT NULL,
	"person_uid" integer NOT NULL,
	"person_home" text NOT NULL,
	"bound_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_person_binding_person_id_idx" ON "user_person_binding" ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_person_binding_person_uid_idx" ON "user_person_binding" ("person_uid");--> statement-breakpoint
ALTER TABLE "user_person_binding" ADD CONSTRAINT "user_person_binding_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;