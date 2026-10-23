-- Groups come only from conditions on users' properties. A token's `groups` is the `groups` property now,
-- and a group named by it gets the condition "groups is <name>". A group with conditions as well keeps
-- just those (it can't be "the name or the conditions" any more). The columns go in a later migration,
-- so app instances from before keep working while a deploy overlaps them.
UPDATE "sso_identity" SET "attributes" = "attributes" || jsonb_build_object('groups', to_jsonb("groups"))
WHERE cardinality("groups") > 0;

-- And users with a `groups` property but none in the column get it there too, so instances from before
-- see the same groups while a deploy overlaps (see below).
UPDATE "sso_identity" SET "groups" = CASE
  WHEN jsonb_typeof("attributes" -> 'groups') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text("attributes" -> 'groups'))
  ELSE ARRAY["attributes" ->> 'groups']
END
WHERE cardinality("groups") = 0 AND jsonb_typeof("attributes" -> 'groups') IN ('string', 'number', 'boolean', 'array');

UPDATE "reader_group" SET "conditions" = jsonb_build_array(jsonb_build_object('property', 'groups', 'op', 'is', 'value', "claim"))
WHERE "claim" IS NOT NULL AND ("conditions" IS NULL OR jsonb_typeof("conditions") <> 'array' OR jsonb_array_length("conditions") = 0);

-- New groups have no claim; the unique index only ever held claims.
DROP INDEX IF EXISTS "reader_group_projectId_claim_key";

-- While a deploy overlaps, instances from before still read and write the old columns. Until they go,
-- these keep both in step, whichever side writes: a user's `groups` column and their `groups` property
-- follow each other (a change to the column wins when both change), taking groups away included, and a
-- group named by a claim gets its condition.
CREATE FUNCTION "sso_identity_groups_in_step"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  property jsonb := NEW."attributes" -> 'groups';
BEGIN
  IF (TG_OP = 'INSERT' AND cardinality(NEW."groups") > 0) OR (TG_OP = 'UPDATE' AND NEW."groups" IS DISTINCT FROM OLD."groups") THEN
    NEW."attributes" := (NEW."attributes" - 'groups')
      || CASE WHEN cardinality(NEW."groups") > 0 THEN jsonb_build_object('groups', to_jsonb(NEW."groups")) ELSE '{}'::jsonb END;
  ELSIF TG_OP = 'INSERT' OR property IS DISTINCT FROM OLD."attributes" -> 'groups' THEN
    NEW."groups" := CASE
      WHEN property IS NULL THEN '{}'::text[]
      WHEN jsonb_typeof(property) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(property))
      ELSE ARRAY[NEW."attributes" ->> 'groups']
    END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "sso_identity_groups_in_step" BEFORE INSERT OR UPDATE ON "sso_identity"
FOR EACH ROW EXECUTE FUNCTION "sso_identity_groups_in_step"();

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
