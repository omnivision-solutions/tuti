-- The docs' home lists its popular articles for new projects; existing ones keep what they have.
-- Previous release: only the default changes and every row keeps its value; projects the previous release creates get the new default, which it reads like any other.
ALTER TABLE "project" ALTER COLUMN "docsPopular" SET DEFAULT true;
