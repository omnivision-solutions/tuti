-- Groups come only from conditions on users' properties. A token's `groups` is the `groups` property now,
-- and a group named by it gets the condition "groups is <name>". A group with conditions as well keeps
-- just those (it can't be "the name or the conditions" any more). The columns go in a later migration,
-- so app instances from before keep working while a deploy overlaps them.
UPDATE "sso_identity" SET "attributes" = "attributes" || jsonb_build_object('groups', to_jsonb("groups"))
WHERE cardinality("groups") > 0;

UPDATE "reader_group" SET "conditions" = jsonb_build_array(jsonb_build_object('property', 'groups', 'op', 'is', 'value', "claim"))
WHERE "claim" IS NOT NULL AND ("conditions" IS NULL OR jsonb_typeof("conditions") <> 'array' OR jsonb_array_length("conditions") = 0);

-- New groups have no claim; the unique index only ever held claims.
DROP INDEX IF EXISTS "reader_group_projectId_claim_key";

-- While a deploy overlaps, instances from before still read and write the old columns. Until they go,
-- these keep both in step: a user's `groups` written there (a sign-in on an old instance, taking groups
-- away included) is their `groups` property too, and a group named by a claim there gets its condition.
-- New instances write the column alongside the property (SsoIdentity.legacyGroups).
CREATE FUNCTION "sso_identity_groups_to_property"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR cardinality(NEW."groups") > 0 THEN
    NEW."attributes" := (NEW."attributes" - 'groups')
      || CASE WHEN cardinality(NEW."groups") > 0 THEN jsonb_build_object('groups', to_jsonb(NEW."groups")) ELSE '{}'::jsonb END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "sso_identity_groups_to_property" BEFORE INSERT OR UPDATE OF "groups" ON "sso_identity"
FOR EACH ROW EXECUTE FUNCTION "sso_identity_groups_to_property"();

CREATE FUNCTION "reader_group_claim_to_condition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."claim" IS NOT NULL AND (
    jsonb_array_length(NEW."conditions") = 0
    OR (TG_OP = 'UPDATE' AND OLD."claim" IS NOT NULL
        AND NEW."conditions" = jsonb_build_array(jsonb_build_object('property', 'groups', 'op', 'is', 'value', OLD."claim")))
  ) THEN
    NEW."conditions" := jsonb_build_array(jsonb_build_object('property', 'groups', 'op', 'is', 'value', NEW."claim"));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "reader_group_claim_to_condition" BEFORE INSERT OR UPDATE OF "claim", "conditions" ON "reader_group"
FOR EACH ROW EXECUTE FUNCTION "reader_group_claim_to_condition"();
