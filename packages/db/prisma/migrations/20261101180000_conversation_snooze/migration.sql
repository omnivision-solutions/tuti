-- Snoozing a conversation: out of the inbox's views until then.
ALTER TABLE "conversation" ADD COLUMN "snoozedUntil" TIMESTAMP(3);

CREATE INDEX "conversation_snoozedUntil_idx" ON "conversation"("snoozedUntil");
