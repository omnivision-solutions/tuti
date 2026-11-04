-- The Inbox conversation a question passed to the team ("Ask a person") started: nullable, so the previous release keeps working.
ALTER TABLE "docs_question" ADD COLUMN "conversationId" TEXT;

-- Questions passed on before it was kept: a conversation "Ask a person" started, its subject the question, within a minute of it
-- being passed on. Only where that pairs them one to one: the same question passed on twice within a minute stays unlinked (each
-- conversation waits on its own AI summary, so the order they started in says nothing), rather than linking someone else's.
UPDATE "docs_question" d SET "conversationId" = m.conversation
FROM (
  SELECT conversation, question FROM (
    SELECT c.id AS conversation, q.id AS question,
      count(*) OVER (PARTITION BY c.id) AS questions, count(*) OVER (PARTITION BY q.id) AS conversations
    FROM "conversation" c
    JOIN "docs_question" q ON q."projectId" = c."projectId" AND q.question = c.subject
      AND c."createdAt" >= q."escalatedAt" AND c."createdAt" < q."escalatedAt" + interval '1 minute'
    WHERE c.origin = 'ESCALATION'
  ) p
  WHERE questions = 1 AND conversations = 1
) m
WHERE d.id = m.question AND d."conversationId" IS NULL;
