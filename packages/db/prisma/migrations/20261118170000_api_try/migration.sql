-- Try it's requests through Tuti, counted for its rate limits (docs/plan.md, API reference in Docs, A12).
-- CreateTable
CREATE TABLE "api_try" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_try_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_try_projectId_createdAt_idx" ON "api_try"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "api_try_clientHash_createdAt_idx" ON "api_try"("clientHash", "createdAt");

-- AddForeignKey
ALTER TABLE "api_try" ADD CONSTRAINT "api_try_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
