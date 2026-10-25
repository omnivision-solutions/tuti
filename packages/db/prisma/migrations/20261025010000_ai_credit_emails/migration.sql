-- When owners and admins were emailed that the project's AI credits ran low or out (once each until the next grant).
ALTER TABLE "project" ADD COLUMN "aiCreditsLowEmailedAt" TIMESTAMP(3),
ADD COLUMN "aiCreditsOutEmailedAt" TIMESTAMP(3);

-- Every new grant clears both, however it's made (the app, Stripe's webhook, the operator's script), so
-- owners and admins hear again when the new credits run low or out.
CREATE FUNCTION "ai_credit_grant_clears_emails"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "project" SET "aiCreditsLowEmailedAt" = NULL, "aiCreditsOutEmailedAt" = NULL WHERE "id" = NEW."projectId";
  RETURN NEW;
END $$;

CREATE TRIGGER "ai_credit_grant_clears_emails" AFTER INSERT ON "ai_credit_grant"
FOR EACH ROW EXECUTE FUNCTION "ai_credit_grant_clears_emails"();
