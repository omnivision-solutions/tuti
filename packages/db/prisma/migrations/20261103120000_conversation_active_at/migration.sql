-- How old a conversation is for a plan's history: the last thing done in it. Nullable: the previous release
-- doesn't write it, so rows from before it fall back to "updatedAt" (a later release fills it in, once none is left
-- that doesn't write it: filled now, a row the previous release closes during the deploy would keep an old age).
ALTER TABLE "conversation" ADD COLUMN "activeAt" TIMESTAMP(3);
-- The delete-old-history job: closed conversations and spam, by their age.
CREATE INDEX "conversation_inactive_idx" ON "conversation"((COALESCE("activeAt", "updatedAt"))) WHERE "status" = 'CLOSED' OR "spam";
