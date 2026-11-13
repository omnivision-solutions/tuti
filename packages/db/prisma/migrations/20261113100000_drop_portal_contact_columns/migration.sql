-- The portal header's "Contact us" button and its setting are gone; its columns left the schema in an earlier release.
-- Previous release: its schema has no contactLabel or contactUrl, so Prisma neither reads nor writes them.
ALTER TABLE "project" DROP COLUMN "contactLabel", DROP COLUMN "contactUrl";
