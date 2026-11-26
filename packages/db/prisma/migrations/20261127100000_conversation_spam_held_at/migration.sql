-- The spam filter's hold (docs/plan.md W4): a new nullable column, which the previous release never reads.
ALTER TABLE "conversation" ADD COLUMN "spamHeldAt" TIMESTAMP(3);
