-- Support inbox (docs/plan.md, Support inbox, item 7): on a server selling plans, approving a project before its replies are emailed to its users.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "emailApprovedAt" TIMESTAMP(3),
ADD COLUMN     "emailRequestedAt" TIMESTAMP(3);

