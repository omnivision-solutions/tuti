-- The docs' home lists its popular articles for new projects; existing ones keep what they have.
ALTER TABLE "project" ALTER COLUMN "docsPopular" SET DEFAULT true;
