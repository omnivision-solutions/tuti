-- Plans on tuti.so (docs/plan.md, Plans): each project's plan, kept in step with its Stripe subscription.
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'BUSINESS');

ALTER TABLE "project" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'FREE',
ADD COLUMN "stripeCustomerId" TEXT,
ADD COLUMN "stripeSubscriptionId" TEXT,
ADD COLUMN "planInterval" TEXT,
ADD COLUMN "planStatus" TEXT,
ADD COLUMN "planPeriodEnd" TIMESTAMP(3),
ADD COLUMN "planEndsAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "project_stripeCustomerId_key" ON "project"("stripeCustomerId");
CREATE UNIQUE INDEX "project_stripeSubscriptionId_key" ON "project"("stripeSubscriptionId");

-- A plan's credits for a period: one grant per paid invoice.
ALTER TABLE "ai_credit_grant" ADD COLUMN "stripeInvoiceId" TEXT;
CREATE UNIQUE INDEX "ai_credit_grant_stripeInvoiceId_key" ON "ai_credit_grant"("stripeInvoiceId");
