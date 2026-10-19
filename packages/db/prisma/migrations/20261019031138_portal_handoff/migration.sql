-- CreateTable
CREATE TABLE "portal_handoff" (
    "codeHash" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_handoff_pkey" PRIMARY KEY ("codeHash")
);

-- CreateIndex
CREATE INDEX "portal_handoff_expiresAt_idx" ON "portal_handoff"("expiresAt");

-- AddForeignKey
ALTER TABLE "portal_handoff" ADD CONSTRAINT "portal_handoff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_handoff" ADD CONSTRAINT "portal_handoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
