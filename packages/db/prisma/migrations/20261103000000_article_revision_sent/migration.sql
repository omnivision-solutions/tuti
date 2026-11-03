-- An editor's save merged onto a newer version: the text it sent, which its next save is compared with.
ALTER TABLE "article_revision" ADD COLUMN "sentContent" JSONB;
