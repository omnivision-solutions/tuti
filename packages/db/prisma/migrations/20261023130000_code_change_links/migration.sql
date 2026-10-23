-- Post links written by an applied code change action remember it.
ALTER TYPE "PostLinkSource" ADD VALUE 'CODE_CHANGE';

ALTER TABLE "post_link" ADD COLUMN "codeChangeId" TEXT;

ALTER TABLE "post_link" ADD CONSTRAINT "post_link_codeChangeId_fkey" FOREIGN KEY ("codeChangeId") REFERENCES "code_change"("id") ON DELETE SET NULL ON UPDATE CASCADE;
