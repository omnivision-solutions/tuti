-- The previous release's unsubscribes while this one deployed (it doesn't know unsubscribedAt): marked as its own
-- migration marked them.
UPDATE "changelog_subscriber" s SET "unsubscribedAt" = CURRENT_TIMESTAMP
WHERE s."unsubscribedAt" IS NULL AND s."confirmedAt" IS NULL
  AND (s."confirmTokenHash" IS NULL OR EXISTS (SELECT 1 FROM "changelog_email" e WHERE e."subscriberId" = s."id" AND e."sentAt" IS NOT NULL));
-- And its confirmations meanwhile: a subscriber confirmed again isn't unsubscribed.
UPDATE "changelog_subscriber" SET "unsubscribedAt" = NULL WHERE "unsubscribedAt" IS NOT NULL AND "confirmedAt" IS NOT NULL;
