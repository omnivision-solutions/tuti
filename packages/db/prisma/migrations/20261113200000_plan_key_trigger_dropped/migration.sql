-- The trigger copying the release before plan keys' enum writes into the key: the release that writes the key itself
-- (plan keys) runs everywhere now, and the enum column, still written by it, goes a release later.
DROP TRIGGER "project_plan_key_from_enum" ON "project";
DROP FUNCTION "project_plan_key_from_enum"();
