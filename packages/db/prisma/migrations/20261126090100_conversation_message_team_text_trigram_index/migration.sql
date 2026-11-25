-- Alone in its file: CONCURRENTLY can't run in the transaction Prisma wraps a file of several statements in. The column
-- is new and empty, so it builds at once.
CREATE INDEX CONCURRENTLY "conversation_message_project_team_text_trgm_idx" ON "conversation_message" USING GIN ("projectId", "teamText" gin_trgm_ops);
