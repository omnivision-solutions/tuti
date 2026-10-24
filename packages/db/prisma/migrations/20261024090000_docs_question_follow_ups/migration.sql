-- A question can follow up on an earlier one, in a conversation with the docs' AI.
ALTER TABLE "docs_question" ADD COLUMN "followsId" TEXT;
