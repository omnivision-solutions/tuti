-- CreateTable
CREATE TABLE "license" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "version" TEXT,
    "lastRefreshAt" TIMESTAMP(3),
    "refusedCount" INTEGER NOT NULL DEFAULT 0,
    "lastRefusedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "license_installationId_projectId_key" ON "license"("installationId", "projectId");
