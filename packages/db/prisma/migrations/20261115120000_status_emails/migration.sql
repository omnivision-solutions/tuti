-- Emailing a post's people that it moved to Planned or In progress: once per post, person and status.
CREATE TABLE "status_email" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PostStatus" NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "eventId" TEXT,

    CONSTRAINT "status_email_pkey" PRIMARY KEY ("postId","userId","status")
);

CREATE INDEX "status_email_userId_idx" ON "status_email"("userId");

CREATE INDEX "status_email_eventId_idx" ON "status_email"("eventId");

ALTER TABLE "status_email" ADD CONSTRAINT "status_email_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "status_email" ADD CONSTRAINT "status_email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "status_email" ADD CONSTRAINT "status_email_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "post_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
