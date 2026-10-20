-- CreateTable
CREATE TABLE "sign_in_link" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "tokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_in_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sign_in_link_tokenHash_key" ON "sign_in_link"("tokenHash");

-- CreateIndex
CREATE INDEX "sign_in_link_emailHash_createdAt_idx" ON "sign_in_link"("emailHash", "createdAt");

-- CreateIndex
CREATE INDEX "sign_in_link_projectId_createdAt_idx" ON "sign_in_link"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "sign_in_link" ADD CONSTRAINT "sign_in_link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
