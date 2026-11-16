-- A plan license's credits name the license, so its source revoking it (a refund) takes them back.
ALTER TABLE "ai_credit_grant" ADD COLUMN "planLicenseId" TEXT;

CREATE INDEX "ai_credit_grant_planLicenseId_idx" ON "ai_credit_grant"("planLicenseId");
