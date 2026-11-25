-- conversations.reply's `requestId`: one message per conversation, writer and id.
-- Built CONCURRENTLY, so messages keep coming in while it builds: the one statement of its file, as it can't run in a
-- transaction (a file with several runs as one). One that's interrupted leaves an invalid index to drop before trying again.
CREATE UNIQUE INDEX CONCURRENTLY "conversation_message_conversationId_author_authorId_request_key" ON "conversation_message"("conversationId", "author", "authorId", "requestId") WHERE ("requestId" IS NOT NULL);
