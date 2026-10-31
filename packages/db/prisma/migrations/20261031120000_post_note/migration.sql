-- An internal note on a post: only the team sees it.
CREATE TABLE "post_note" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "content" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_note_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "post_note_postId_createdAt_idx" ON "post_note"("postId", "createdAt");

ALTER TABLE "post_note" ADD CONSTRAINT "post_note_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "post_note" ADD CONSTRAINT "post_note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
