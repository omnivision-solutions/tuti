-- Embeddings aren't recorded any more (they cost less than the rows): the ones recorded so far go.
DELETE FROM "ai_usage" WHERE "kind" = 'embedding';
