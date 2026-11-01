-- Sample content (Home's "Add sample content"), removed with "Remove sample content".
ALTER TABLE "post" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversation" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "changelog_entry" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "collection" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "article" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
