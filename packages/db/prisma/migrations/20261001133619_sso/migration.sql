-- AlterTable
ALTER TABLE "workspace" ADD COLUMN     "ssoSecret" TEXT;

-- CreateTable
CREATE TABLE "sso_identity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_token_use" (
    "workspaceId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_token_use_pkey" PRIMARY KEY ("workspaceId","jti")
);

-- CreateIndex
CREATE UNIQUE INDEX "sso_identity_userId_key" ON "sso_identity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_identity_workspaceId_externalId_key" ON "sso_identity"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "sso_token_use_expiresAt_idx" ON "sso_token_use"("expiresAt");

-- AddForeignKey
ALTER TABLE "sso_identity" ADD CONSTRAINT "sso_identity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_identity" ADD CONSTRAINT "sso_identity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_token_use" ADD CONSTRAINT "sso_token_use_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
