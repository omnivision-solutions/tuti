-- A project's plan as its key in the billing file (null: the file's default plan), so a server can sell any plans.
-- The enum column stays for the previous release while a deploy runs both; a later release drops it.
ALTER TABLE "project" ADD COLUMN "planKey" TEXT;
UPDATE "project" SET "planKey" = lower("plan"::text) WHERE "plan" <> 'FREE';
