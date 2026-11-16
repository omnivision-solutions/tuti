-- AI credits become credits of a kind (AI, and email to come): the table, its keys and its type lose "ai".
-- Previous release: only servers with AI credits on (AI_CREDITS, off by default) read or write these, and those (Tuti's cloud)
-- deploy this release with the previous one stopped first, its web container and worker: renamed at once, so the old names
-- don't linger.
ALTER TABLE "ai_credit_grant" RENAME TO "credit_grant";
-- Previous release: as above.
ALTER TABLE "credit_grant" RENAME CONSTRAINT "ai_credit_grant_pkey" TO "credit_grant_pkey";
-- Previous release: as above.
ALTER TABLE "credit_grant" RENAME CONSTRAINT "ai_credit_grant_projectId_fkey" TO "credit_grant_projectId_fkey";
ALTER INDEX "ai_credit_grant_planLicenseId_idx" RENAME TO "credit_grant_planLicenseId_idx";
ALTER INDEX "ai_credit_grant_projectId_expiresAt_idx" RENAME TO "credit_grant_projectId_expiresAt_idx";
ALTER INDEX "ai_credit_grant_stripeInvoiceId_key" RENAME TO "credit_grant_stripeInvoiceId_key";
ALTER INDEX "ai_credit_grant_stripeSessionId_key" RENAME TO "credit_grant_stripeSessionId_key";
-- Previous release: as above.
ALTER TYPE "AiCreditSource" RENAME TO "CreditSource";

CREATE TYPE "CreditKind" AS ENUM ('AI', 'EMAIL');
ALTER TABLE "credit_grant" ADD COLUMN "kind" "CreditKind" NOT NULL DEFAULT 'AI';

-- A new AI grant clears the AI credit emails' claims (as before); other kinds leave them.
DROP TRIGGER "ai_credit_grant_clears_emails" ON "credit_grant";
DROP FUNCTION "ai_credit_grant_clears_emails"();
CREATE FUNCTION "credit_grant_clears_emails"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "project" SET "aiCreditsLowEmailedAt" = NULL, "aiCreditsOutEmailedAt" = NULL WHERE "id" = NEW."projectId";
  RETURN NEW;
END $$;
CREATE TRIGGER "credit_grant_clears_emails" AFTER INSERT ON "credit_grant"
FOR EACH ROW WHEN (NEW."kind" = 'AI') EXECUTE FUNCTION "credit_grant_clears_emails"();
