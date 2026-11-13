-- A project's plan as its key in the billing file (null: the file's default plan), so a server can sell any plans.
-- The enum column stays for the previous release while a deploy runs both; a later release drops it (and this trigger).
ALTER TABLE "project" ADD COLUMN "planKey" TEXT;
UPDATE "project" SET "planKey" = lower("plan"::text) WHERE "plan" <> 'FREE';

-- While both releases run, the previous one writes only the enum (Stripe's webhook, in the old web container): its
-- change follows into the key, so a payment or a cancellation it handles holds. This release writes both, the key
-- first, so its own writes are left as they are.
CREATE FUNCTION "project_plan_key_from_enum"() RETURNS trigger AS $$
BEGIN
  IF NEW."plan" IS DISTINCT FROM OLD."plan" AND NEW."planKey" IS NOT DISTINCT FROM OLD."planKey" THEN
    NEW."planKey" := CASE WHEN NEW."plan" = 'FREE' THEN NULL ELSE lower(NEW."plan"::text) END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_plan_key_from_enum" BEFORE UPDATE OF "plan" ON "project"
  FOR EACH ROW EXECUTE FUNCTION "project_plan_key_from_enum"();
