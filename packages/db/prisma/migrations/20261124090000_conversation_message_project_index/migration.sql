-- The Inbox's search (conversations.list's `q`) looks for text in a project's messages: a project's messages on their
-- own, which a search of one or two characters reads (trigrams need three).
-- Built CONCURRENTLY, so messages keep coming in while it builds: the one statement of its file, as it can't run in a
-- transaction (a file with several runs as one). One that's interrupted leaves an invalid index to drop before trying again.
CREATE INDEX CONCURRENTLY "conversation_message_projectId_idx" ON "conversation_message"("projectId");
