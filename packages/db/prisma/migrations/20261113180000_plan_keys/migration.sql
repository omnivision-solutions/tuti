-- A project's plan as its key in the billing file (null: the file's default plan), so a server can sell any plans.
-- The enum column stays for the previous release while a deploy runs both; a later release drops it (and this trigger).
ALTER TABLE "project" ADD COLUMN "planKey" TEXT;
UPDATE "project" SET "planKey" = lower("plan"::text) WHERE "plan" <> 'FREE';

-- While both releases run, the previous one writes only the enum (Stripe's webhook, in the old web container): its
-- change follows into the key, so a payment or a cancellation it handles holds. Only its two writes: a plan ended (Free,
-- its status cleared) or Pro or Business paid where the key says otherwise. This release writes both, and its enum
-- (Free for any plan the enum has no name for) never clears a key that's paid for.
CREATE FUNCTION "project_plan_key_from_enum"() RETURNS trigger AS $$
BEGIN
  -- Its write sets the enum even unchanged (a plan the enum has no name for is already Free): an ended plan shows in its
  -- status cleared.
  IF NEW."planKey" IS NOT DISTINCT FROM OLD."planKey"
    AND (NEW."plan" IS DISTINCT FROM OLD."plan" OR (NEW."planStatus" IS NULL AND OLD."planStatus" IS NOT NULL)) THEN
    IF NEW."plan" = 'FREE' AND NEW."planStatus" IS NULL THEN
      NEW."planKey" := NULL;
    -- Pro or Business only over a key it could have known: none, pro or business (never over a paid plan it has no name for).
    ELSIF NEW."plan" <> 'FREE' AND NEW."planKey" IS DISTINCT FROM lower(NEW."plan"::text)
      AND (NEW."planKey" IS NULL OR NEW."planKey" IN ('pro', 'business')) THEN
      NEW."planKey" := lower(NEW."plan"::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_plan_key_from_enum" BEFORE UPDATE OF "plan" ON "project"
  FOR EACH ROW EXECUTE FUNCTION "project_plan_key_from_enum"();
