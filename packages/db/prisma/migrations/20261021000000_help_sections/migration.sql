-- AlterTable
ALTER TABLE "collection" ADD COLUMN "sectionId" TEXT;

-- CreateTable
CREATE TABLE "help_section" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_section_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_sectionId_idx" ON "collection"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "help_section_projectId_slug_key" ON "help_section"("projectId", "slug");

-- AddForeignKey
ALTER TABLE "collection" ADD CONSTRAINT "collection_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "help_section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_section" ADD CONSTRAINT "help_section_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
