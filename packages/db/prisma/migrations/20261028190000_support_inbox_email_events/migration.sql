-- Amazon SES's events for the support inbox's emails (docs/plan.md, Support inbox, item 11): what became of
-- each email, each event once, and the addresses that marked a project's email as spam.
-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'DELIVERED';
ALTER TYPE "EmailStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "EmailStatus" ADD VALUE 'COMPLAINED';

-- CreateTable
CREATE TABLE "email_event" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_block" (
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_block_pkey" PRIMARY KEY ("projectId","email")
);

-- AddForeignKey
ALTER TABLE "email_block" ADD CONSTRAINT "email_block_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
