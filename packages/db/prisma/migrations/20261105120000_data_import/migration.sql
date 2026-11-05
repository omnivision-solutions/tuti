-- Imports from other tools (docs/plan.md, Switching from Featurebase): one row per run, what each brought across, the placeholder people they make, and the conversations those held.
-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('FEATUREBASE');

-- CreateEnum
CREATE TYPE "ImportState" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "placeholderFor" TEXT,
ADD COLUMN     "placeholderProjectId" TEXT;

-- AlterTable
ALTER TABLE "conversation" ADD COLUMN     "heldById" TEXT;

-- CreateTable
CREATE TABLE "data_import" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "startedById" TEXT,
    "apiKey" TEXT,
    "parts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" "ImportState" NOT NULL DEFAULT 'RUNNING',
    "step" TEXT NOT NULL DEFAULT '',
    "cursor" TEXT,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "data_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imported_record" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imported_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_import_projectId_createdAt_idx" ON "data_import"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "data_import_startedById_idx" ON "data_import"("startedById");

-- CreateIndex
CREATE UNIQUE INDEX "imported_record_projectId_source_kind_externalId_key" ON "imported_record"("projectId", "source", "kind", "externalId");

-- CreateIndex
CREATE INDEX "user_placeholderProjectId_idx" ON "user"("placeholderProjectId") WHERE ("placeholderProjectId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "conversation_heldById_idx" ON "conversation"("heldById") WHERE ("heldById" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_placeholderProjectId_fkey" FOREIGN KEY ("placeholderProjectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_heldById_fkey" FOREIGN KEY ("heldById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_import" ADD CONSTRAINT "data_import_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_import" ADD CONSTRAINT "data_import_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imported_record" ADD CONSTRAINT "imported_record_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

