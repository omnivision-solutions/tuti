-- AI levels (docs/plan.md, AI models by role, R2): each group of roles runs on a level; Balanced where none is saved.
ALTER TABLE "project" ADD COLUMN "aiLevels" JSONB NOT NULL DEFAULT '{}';

-- A group with a model picked for any of its roles is on Custom, so the pick keeps being used (where the plan has Custom).
-- Autopilot's checks being "off" isn't a model: it holds on every level, so it alone doesn't make its group Custom.
UPDATE "project"
SET "aiLevels" = jsonb_strip_nulls(jsonb_build_object(
  'answers', CASE WHEN "aiModels" ?| ARRAY['answers', 'escalations'] THEN 'custom' END,
  'support', CASE WHEN "aiModels" ?| ARRAY['support_draft', 'support_summary'] THEN 'custom' END,
  'changelog', CASE WHEN "aiModels" ? 'changelog' THEN 'custom' END,
  'code_changes', CASE WHEN "aiModels" ?| ARRAY['code_changes_decide', 'code_changes'] OR COALESCE("aiModels" ->> 'code_changes_check', 'off') <> 'off' THEN 'custom' END
))
WHERE "aiModels" <> '{}';
