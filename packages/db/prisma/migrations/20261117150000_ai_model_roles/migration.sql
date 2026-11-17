-- A project's model picks go by role (docs/plan.md, AI models by role): the Inbox's one pick is its two roles', and
-- Autopilot's double-check is its Checks role. Copied, not moved: the previous release still reads the old names
-- while it runs beside this one. A pick already saved under a new name is kept.
UPDATE "project"
SET "aiModels" =
  jsonb_strip_nulls(
    jsonb_build_object(
      'support_draft', "aiModels" -> 'support',
      'support_summary', "aiModels" -> 'support',
      'code_changes_check', "aiModels" -> 'code_changes_redecide'
    )
  ) || "aiModels"
WHERE "aiModels" ?| ARRAY['support', 'code_changes_redecide'];
