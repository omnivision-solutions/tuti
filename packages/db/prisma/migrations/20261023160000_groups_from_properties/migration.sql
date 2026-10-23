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
