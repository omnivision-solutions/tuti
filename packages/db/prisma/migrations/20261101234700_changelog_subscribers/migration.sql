-- People who asked for a project's changelog by email: confirmed before anything is sent.
CREATE TABLE "changelog_subscriber" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "confirmedAt" TIMESTAMP(3),
    "confirmTokenHash" TEXT,
    "confirmExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changelog_subscriber_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "changelog_subscriber_token_key" ON "changelog_subscriber"("token");
CREATE UNIQUE INDEX "changelog_subscriber_confirmTokenHash_key" ON "changelog_subscriber"("confirmTokenHash");
CREATE UNIQUE INDEX "changelog_subscriber_projectId_email_key" ON "changelog_subscriber"("projectId", "email");
ALTER TABLE "changelog_subscriber" ADD CONSTRAINT "changelog_subscriber_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each entry emailed to each subscriber once: claimed, then sent.
CREATE TABLE "changelog_email" (
    "entryId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "changelog_email_pkey" PRIMARY KEY ("entryId","subscriberId")
);
CREATE INDEX "changelog_email_subscriberId_idx" ON "changelog_email"("subscriberId");
ALTER TABLE "changelog_email" ADD CONSTRAINT "changelog_email_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "changelog_email" ADD CONSTRAINT "changelog_email_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "changelog_subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Publishing with "Email subscribers": when (once), and whether its emails are still to send.
ALTER TABLE "changelog_entry" ADD COLUMN "subscribersEmailedAt" TIMESTAMP(3);
ALTER TABLE "changelog_entry" ADD COLUMN "subscribersEmailDueAt" TIMESTAMP(3);
