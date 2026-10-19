-- AlterTable
ALTER TABLE "changelog_entry" ADD COLUMN     "collecting" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "changelog_entry_pull_request" (
    "entryId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changelog_entry_pull_request_pkey" PRIMARY KEY ("entryId","url")
);

-- AddForeignKey
ALTER TABLE "changelog_entry_pull_request" ADD CONSTRAINT "changelog_entry_pull_request_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "changelog_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One running draft per project.
CREATE UNIQUE INDEX "changelog_entry_collecting_key" ON "changelog_entry"("projectId") WHERE "collecting";
