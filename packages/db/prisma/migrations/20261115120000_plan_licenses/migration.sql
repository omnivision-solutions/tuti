-- Plan licenses (an AppSumo lifetime deal, say): a plan an account holds and assigns to one of its projects.
CREATE TABLE "plan_license" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "claimedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "creditsThrough" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_license_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_license_projectId_key" ON "plan_license"("projectId");
CREATE INDEX "plan_license_userId_idx" ON "plan_license"("userId");
CREATE UNIQUE INDEX "plan_license_source_externalKey_key" ON "plan_license"("source", "externalKey");

ALTER TABLE "plan_license" ADD CONSTRAINT "plan_license_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "plan_license" ADD CONSTRAINT "plan_license_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
