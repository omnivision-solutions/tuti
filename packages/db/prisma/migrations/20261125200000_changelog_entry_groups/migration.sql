-- A changelog entry for some reader groups only (none: everyone).
CREATE TABLE "changelog_entry_group" (
    "entryId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "changelog_entry_group_pkey" PRIMARY KEY ("entryId","groupId")
);

CREATE INDEX "changelog_entry_group_groupId_idx" ON "changelog_entry_group"("groupId");

ALTER TABLE "changelog_entry_group" ADD CONSTRAINT "changelog_entry_group_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "changelog_entry_group" ADD CONSTRAINT "changelog_entry_group_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "reader_group"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
