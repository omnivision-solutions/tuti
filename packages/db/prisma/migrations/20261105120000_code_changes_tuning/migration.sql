-- Autopilot's Advanced tuning per project (who changed it last, and when), and the values each analysis ran with.
ALTER TABLE "project" ADD COLUMN "codeChangesTuning" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "tuningUpdatedAt" TIMESTAMP(3),
ADD COLUMN "tuningUpdatedBy" TEXT;

ALTER TABLE "code_change" ADD COLUMN "settings" JSONB;

ALTER TABLE "project" ADD CONSTRAINT "project_tuningUpdatedBy_fkey" FOREIGN KEY ("tuningUpdatedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
