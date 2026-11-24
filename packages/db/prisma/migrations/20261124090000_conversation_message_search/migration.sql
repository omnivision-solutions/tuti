-- The Inbox's search (conversations.list's `q`) looks for text in a project's messages.
-- A project's messages on their own: what a search of one or two characters reads (trigrams need three).
-- CreateIndex
CREATE INDEX "conversation_message_projectId_idx" ON "conversation_message"("projectId");

-- Trigrams of the text (pg_trgm, enabled for post titles): `ILIKE '%text%'` without reading every message.
-- CreateIndex
CREATE INDEX "conversation_message_body_trgm_idx" ON "conversation_message" USING GIN ("body" gin_trgm_ops);
