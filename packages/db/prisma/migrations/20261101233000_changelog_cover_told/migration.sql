-- A changelog entry's cover image, an upload shown above it on the portal.
ALTER TABLE "changelog_entry" ADD COLUMN "coverId" TEXT;
ALTER TABLE "changelog_entry" ADD CONSTRAINT "changelog_entry_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The entry whose publishing completed a post: its shipped emails are how many people the entry told.
ALTER TABLE "post_event" ADD COLUMN "changelogEntryId" TEXT;
CREATE INDEX "post_event_changelogEntryId_idx" ON "post_event"("changelogEntryId");
ALTER TABLE "post_event" ADD CONSTRAINT "post_event_changelogEntryId_fkey" FOREIGN KEY ("changelogEntryId") REFERENCES "changelog_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
