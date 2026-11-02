-- An article edit's revision, tagged with its Autopilot update and the revision it was written on.
ALTER TABLE "article_revision" ADD COLUMN "codeChangeActionId" TEXT,
ADD COLUMN "basedOnId" TEXT;

CREATE INDEX "article_revision_codeChangeActionId_idx" ON "article_revision"("codeChangeActionId");

ALTER TABLE "article_revision" ADD CONSTRAINT "article_revision_codeChangeActionId_fkey" FOREIGN KEY ("codeChangeActionId") REFERENCES "code_change_action"("id") ON DELETE SET NULL ON UPDATE CASCADE;
