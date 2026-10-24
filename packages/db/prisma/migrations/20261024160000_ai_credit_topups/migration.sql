-- AI credit top-ups through Stripe: one grant per Checkout Session, and what it paid.
ALTER TABLE "ai_credit_grant" ADD COLUMN "stripeSessionId" TEXT,
ADD COLUMN "paidCents" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_grant_stripeSessionId_key" ON "ai_credit_grant"("stripeSessionId");
