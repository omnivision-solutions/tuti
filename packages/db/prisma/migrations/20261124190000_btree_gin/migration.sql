-- The Inbox's search looks for text in one project's messages: with btree_gin, one GIN index holds both
-- the project and the text's trigrams (the next migration). It ships with Postgres and is a trusted
-- extension, so the database owner can enable it, as with pg_trgm.
CREATE EXTENSION IF NOT EXISTS btree_gin;
