-- A team's own domain its support email comes from (docs/plan.md, Support inbox, item 11).
-- CreateTable
CREATE TABLE "email_domain" (
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "dkimTokens" TEXT[],
    "verifiedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_domain_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_domain_domain_key" ON "email_domain"("domain");

-- AddForeignKey
ALTER TABLE "email_domain" ADD CONSTRAINT "email_domain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
