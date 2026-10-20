-- CreateTable
CREATE TABLE "changelog_seen" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelog_seen_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateIndex
CREATE INDEX "changelog_seen_userId_idx" ON "changelog_seen"("userId");

-- AddForeignKey
ALTER TABLE "changelog_seen" ADD CONSTRAINT "changelog_seen_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changelog_seen" ADD CONSTRAINT "changelog_seen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
