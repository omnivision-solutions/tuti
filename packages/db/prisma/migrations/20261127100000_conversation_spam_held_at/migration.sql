-- The spam filter's hold (docs/plan.md W4): a new nullable column, which the previous release never reads, and its index
-- for the inbox-due job: only holds it still has to settle, not those a teammate marked as spam (they keep
-- `spamHeldAt` for good, so a full index would grow with every one).
ALTER TABLE "conversation" ADD COLUMN "spamHeldAt" TIMESTAMP(3);

CREATE INDEX "conversation_spamHeldAt_idx" ON "conversation"("spamHeldAt") WHERE ("spamHeldAt" IS NOT NULL AND ("spamMarkedAt" IS NULL OR NOT "spam"));
