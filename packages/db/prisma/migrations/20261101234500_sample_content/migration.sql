-- Sample content (Home's "Add sample content"), removed with "Remove sample content".
ALTER TABLE "post" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversation" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "changelog_entry" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "collection" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "article" ADD COLUMN "sample" BOOLEAN NOT NULL DEFAULT false;
-- Sample people: removed with the project's sample content, or with the project.
ALTER TABLE "user" ADD COLUMN "sampleProjectId" TEXT;
CREATE INDEX "user_sampleProjectId_idx" ON "user"("sampleProjectId") WHERE "sampleProjectId" IS NOT NULL;
ALTER TABLE "user" ADD CONSTRAINT "user_sampleProjectId_fkey" FOREIGN KEY ("sampleProjectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
