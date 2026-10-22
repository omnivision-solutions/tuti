-- GitHub per repository: several projects may connect one installation, each including its own repositories.
DROP INDEX "github_installation_installationId_key";
CREATE INDEX "github_installation_installationId_idx" ON "github_installation"("installationId");

ALTER TABLE "github_installation"
  ADD COLUMN "includeNewRepositories" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "repositories" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "seenRepositoryIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
-- Connections so far took every repository of their installation: they keep doing so, each
-- repository included as Tuti first hears of it.
UPDATE "github_installation" SET "includeNewRepositories" = true;

CREATE TABLE "github_repository" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "repoId" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_repository_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "github_repository_repoId_key" ON "github_repository"("repoId");
CREATE INDEX "github_repository_connectionId_idx" ON "github_repository"("connectionId");
ALTER TABLE "github_repository" ADD CONSTRAINT "github_repository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "github_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
