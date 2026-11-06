-- When the source last changed a record, as an import last read it (a conversation's last activity): a later import
-- reads it again only once it changed since, for what's new in it.
ALTER TABLE "imported_record" ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3);
