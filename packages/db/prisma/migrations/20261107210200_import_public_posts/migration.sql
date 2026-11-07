-- Imports from a source that can't say who may see each post ask whether its posts come onto a Public board or a Private one (docs/plan.md, Import from Frill).
ALTER TABLE "data_import" ADD COLUMN "publicPosts" BOOLEAN NOT NULL DEFAULT true;
