-- The Inbox's search: trigrams of messages' text (pg_trgm, enabled for post titles), so `ILIKE '%text%'` doesn't read
-- every message. Built CONCURRENTLY, the one statement of its file, as the index before it.
CREATE INDEX CONCURRENTLY "conversation_message_body_trgm_idx" ON "conversation_message" USING GIN ("body" gin_trgm_ops);
