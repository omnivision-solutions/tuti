-- AlterTable
ALTER TABLE "changelog_subscriber" ADD COLUMN     "unsubscribedAt" TIMESTAMP(3);

-- Unsubscribing cleared the confirmation, link and all; an unconfirmed row with no link is one that unsubscribed
-- (or asked while the project's email was paused, which never sent one: kept from being added back too, the safe side).
UPDATE "changelog_subscriber" SET "unsubscribedAt" = CURRENT_TIMESTAMP WHERE "confirmedAt" IS NULL AND "confirmTokenHash" IS NULL;
