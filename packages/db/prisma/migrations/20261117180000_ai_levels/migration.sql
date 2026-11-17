-- AI levels (docs/plan.md, AI models by role, R2): the level each group of AI roles was put on. A group with none saved
-- is on Custom where it has a model picked, else on Balanced (projectLevels), so nothing is copied here.
ALTER TABLE "project" ADD COLUMN "aiLevels" JSONB NOT NULL DEFAULT '{}';
