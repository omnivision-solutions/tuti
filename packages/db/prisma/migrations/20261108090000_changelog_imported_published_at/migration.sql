-- A changelog entry imported as a draft keeps the date it was published in the other tool (Import from Ferndesk).
ALTER TABLE "changelog_entry" ADD COLUMN "importedPublishedAt" TIMESTAMP(3);
