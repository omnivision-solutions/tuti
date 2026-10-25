-- Credits taken back from a grant whose payment was refunded or disputed (docs/plan.md, Plans).
ALTER TABLE "ai_credit_grant" ADD COLUMN "takenBack" DECIMAL(20,6) NOT NULL DEFAULT 0;
