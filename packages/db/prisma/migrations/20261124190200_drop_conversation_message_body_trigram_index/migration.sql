-- The index on (project, text) before this replaces it; searches always name the project.
DROP INDEX CONCURRENTLY IF EXISTS "conversation_message_body_trgm_idx";
