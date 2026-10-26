-- Self-hosted licences bought on tuti.so/license (docs/plan.md, Licences): the subscription paying for each.
ALTER TABLE "license" ADD COLUMN "stripeSubscriptionId" TEXT;
CREATE UNIQUE INDEX "license_stripeSubscriptionId_key" ON "license"("stripeSubscriptionId");
