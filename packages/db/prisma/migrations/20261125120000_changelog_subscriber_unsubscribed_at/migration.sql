-- AlterTable
ALTER TABLE "changelog_subscriber" ADD COLUMN     "unsubscribedAt" TIMESTAMP(3);

-- Rows that unsubscribed before this: unconfirmed with no link out (unsubscribing cleared it; or asked while the
-- project's email was paused, which sent none: kept from being added back too, the safe side), or unconfirmed though an
-- entry was emailed to them (so confirmed once; asked again since, unconfirmed).
UPDATE "changelog_subscriber" s SET "unsubscribedAt" = CURRENT_TIMESTAMP
WHERE s."confirmedAt" IS NULL
  AND (s."confirmTokenHash" IS NULL OR EXISTS (SELECT 1 FROM "changelog_email" e WHERE e."subscriberId" = s."id" AND e."sentAt" IS NOT NULL));
