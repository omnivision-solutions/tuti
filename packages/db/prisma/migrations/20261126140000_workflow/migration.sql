-- Inbox automation (docs/plan.md, W8): the team's workflows, and when a user's message's workflows ran, so they never
-- run for it twice. A new table and a nullable column: the previous release reads neither, and its messages leave the
-- column empty, as every message from before is.
-- CreateTable
CREATE TABLE "workflow" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN "workflowsRanAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "workflow_projectId_trigger_position_idx" ON "workflow"("projectId", "trigger", "position");

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
