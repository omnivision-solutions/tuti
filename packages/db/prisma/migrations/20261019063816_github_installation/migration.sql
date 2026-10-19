-- CreateTable
CREATE TABLE "github_installation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "installationId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_installation_projectId_key" ON "github_installation"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "github_installation_installationId_key" ON "github_installation"("installationId");

-- AddForeignKey
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
