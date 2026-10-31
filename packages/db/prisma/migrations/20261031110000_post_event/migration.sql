-- A change of a post's status, for its activity.
CREATE TABLE "post_event" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "actorId" TEXT,
    "from" "PostStatus" NOT NULL,
    "to" "PostStatus" NOT NULL,
    "emailed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "post_event_postId_createdAt_idx" ON "post_event"("postId", "createdAt");

ALTER TABLE "post_event" ADD CONSTRAINT "post_event_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "post_event" ADD CONSTRAINT "post_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The completion a shipped email is for: sent, it's counted there.
ALTER TABLE "shipped_email" ADD COLUMN "eventId" TEXT;

ALTER TABLE "shipped_email" ADD CONSTRAINT "shipped_email_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "post_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
