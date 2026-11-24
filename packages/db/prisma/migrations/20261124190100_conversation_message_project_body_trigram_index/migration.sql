-- Alone in its file: CONCURRENTLY keeps messages coming in while the index builds, and can't run in the
-- transaction Prisma wraps a file of several statements in.
CREATE INDEX CONCURRENTLY "conversation_message_project_body_trgm_idx" ON "conversation_message" USING GIN ("projectId", "body" gin_trgm_ops);
