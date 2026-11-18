-- The team's standing instructions for replies drafted by AI in the inbox (docs/plan.md, AI models by role, R6).
ALTER TABLE "project" ADD COLUMN "supportDraftInstructions" TEXT NOT NULL DEFAULT '';
