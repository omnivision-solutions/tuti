-- Posts the team linked a conversation to: shown on the post, and the post on the conversation.
CREATE TABLE "conversation_post" (
    "conversationId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_post_pkey" PRIMARY KEY ("conversationId","postId")
);

CREATE INDEX "conversation_post_postId_idx" ON "conversation_post"("postId");

ALTER TABLE "conversation_post" ADD CONSTRAINT "conversation_post_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_post" ADD CONSTRAINT "conversation_post_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
