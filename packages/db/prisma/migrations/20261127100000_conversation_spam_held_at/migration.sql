-- The spam filter's hold (docs/plan.md W4): a new nullable column, which the previous release never reads, and its index
-- for the inbox-due job.
ALTER TABLE "conversation" ADD COLUMN "spamHeldAt" TIMESTAMP(3);

CREATE INDEX "conversation_spamHeldAt_idx" ON "conversation"("spamHeldAt");
