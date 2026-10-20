-- "Ask a person": the project's confirmed support address (and one waiting for confirmation),
-- and which questions were passed to the team.
ALTER TABLE "project" ADD COLUMN "supportEmail" TEXT,
ADD COLUMN "supportEmailPending" TEXT,
ADD COLUMN "supportEmailTokenHash" TEXT;

CREATE UNIQUE INDEX "project_supportEmailTokenHash_key" ON "project"("supportEmailTokenHash");

ALTER TABLE "help_question" ADD COLUMN "escalatedAt" TIMESTAMP(3),
ADD COLUMN "escalatedTo" TEXT;
