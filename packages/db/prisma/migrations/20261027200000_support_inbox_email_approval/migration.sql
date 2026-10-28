-- Support inbox (docs/plan.md, Support inbox, item 7): on a server selling plans, approving a project before its replies are emailed to its users.
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "emailApprovedAt" TIMESTAMP(3),
ADD COLUMN     "emailRequestedAt" TIMESTAMP(3);


-- Projects that already email their replies keep doing so: approved, not stopped by this release.
-- Every other project, new or not, asks first.
UPDATE "project" SET "emailApprovedAt" = CURRENT_TIMESTAMP
WHERE "emailApprovedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "conversation_message" m WHERE m."projectId" = "project"."id" AND m."emailStatus" = 'SENT');
