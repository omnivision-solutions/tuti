-- "People without access" on tabs, collections and articles: inherit (the default; with nothing
-- above it, hidden, as before), shown with a lock, or hidden.

-- CreateEnum
CREATE TYPE "NoAccess" AS ENUM ('INHERIT', 'LOCK', 'HIDE');

-- AlterTable
ALTER TABLE "collection" ADD COLUMN     "noAccess" "NoAccess" NOT NULL DEFAULT 'INHERIT';

-- AlterTable
ALTER TABLE "docs_tab" ADD COLUMN     "noAccess" "NoAccess" NOT NULL DEFAULT 'INHERIT';

-- AlterTable
ALTER TABLE "article" ADD COLUMN     "noAccess" "NoAccess" NOT NULL DEFAULT 'INHERIT';
