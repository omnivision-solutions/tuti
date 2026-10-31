-- The team's reply sent to a post's voters too (Email voters): when it's due, and who it was sent to.
ALTER TABLE "comment" ADD COLUMN "votersEmailDueAt" TIMESTAMP(3);

CREATE TABLE "reply_email" (
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "reply_email_pkey" PRIMARY KEY ("commentId","userId")
);

CREATE INDEX "reply_email_userId_idx" ON "reply_email"("userId");

CREATE INDEX "comment_votersEmailDueAt_idx" ON "comment"("votersEmailDueAt");

ALTER TABLE "reply_email" ADD CONSTRAINT "reply_email_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reply_email" ADD CONSTRAINT "reply_email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
