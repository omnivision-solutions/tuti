-- An API reference in the docs (docs/plan.md, API reference in Docs): a spec read into pages, in a tab beside its collections.
-- CreateEnum
CREATE TYPE "ApiReferenceFormat" AS ENUM ('OPENAPI', 'GRAPHQL');

-- CreateEnum
CREATE TYPE "ApiReferenceSource" AS ENUM ('UPLOAD', 'URL', 'GITHUB');

-- CreateEnum
CREATE TYPE "ApiReferenceTreeStyle" AS ENUM ('FOLDERS', 'HEADINGS', 'ENTRY');

-- CreateTable
CREATE TABLE "api_reference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tabId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "format" "ApiReferenceFormat" NOT NULL,
    "source" "ApiReferenceSource" NOT NULL DEFAULT 'UPLOAD',
    "sourceUrl" TEXT,
    "repoId" INTEGER,
    "path" TEXT,
    "ref" TEXT,
    "baseUrl" TEXT,
    "spec" TEXT NOT NULL,
    "doc" JSON NOT NULL,
    "state" JSONB NOT NULL,
    "operationCount" INTEGER NOT NULL DEFAULT 0,
    "shownCount" INTEGER NOT NULL DEFAULT 0,
    "unseenCount" INTEGER NOT NULL DEFAULT 0,
    "treeStyle" "ApiReferenceTreeStyle" NOT NULL DEFAULT 'FOLDERS',
    "publishedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_reference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_reference_tabId_idx" ON "api_reference"("tabId");

-- CreateIndex
CREATE UNIQUE INDEX "api_reference_projectId_slug_key" ON "api_reference"("projectId", "slug");

-- AddForeignKey
ALTER TABLE "api_reference" ADD CONSTRAINT "api_reference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_reference" ADD CONSTRAINT "api_reference_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "docs_tab"("id") ON DELETE SET NULL ON UPDATE CASCADE;

