import { Prisma } from "@tuti/db";

import type { GroupCondition, GroupRules } from "@/lib/group-conditions";

/**
 * conditionsMatch in SQL, on the properties (jsonb) at `column`. Numbers compare as Postgres writes
 * them, which differs from JavaScript only for ones written with an exponent (1e21).
 */
export function conditionsSql(conditions: GroupCondition[], column: Prisma.Sql): Prisma.Sql {
  if (conditions.length === 0) {
    return Prisma.sql`FALSE`;
  }
  return Prisma.join(
    conditions.map((condition) => {
      const name = condition.property;
      const items = Prisma.sql`(CASE WHEN ${column} -> ${name}::text IS NULL THEN ARRAY[]::text[]
        WHEN jsonb_typeof(${column} -> ${name}::text) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${column} -> ${name}::text))
        ELSE ARRAY[${column} ->> ${name}::text] END)`;
      switch (condition.op) {
        case "is":
          return Prisma.sql`(${condition.value}::text = ANY(${items}))`;
        case "is_not":
          return Prisma.sql`(NOT ${condition.value}::text = ANY(${items}))`;
        case "is_any_of":
          return Prisma.sql`(${items} && ${condition.value}::text[])`;
        case "is_none_of":
          return Prisma.sql`(NOT ${items} && ${condition.value}::text[])`;
        case "contains":
          return Prisma.sql`EXISTS (SELECT 1 FROM unnest(${items}) item WHERE strpos(item, ${condition.value}::text) > 0)`;
        case "excludes":
          return Prisma.sql`NOT EXISTS (SELECT 1 FROM unnest(${items}) item WHERE strpos(item, ${condition.value}::text) > 0)`;
        case "is_set":
          return Prisma.sql`(cardinality(${items}) > 0)`;
        case "is_not_set":
          return Prisma.sql`(cardinality(${items}) = 0)`;
      }
    }),
    " AND ",
    "(",
    ")",
  );
}

/** inGroup in SQL, for the project's user (sso_identity) at `user`: its `groups` has the claim, or its properties (the `attributes` column) match all the conditions. */
export function inGroupSql(rules: GroupRules, user: Prisma.Sql): Prisma.Sql {
  const claim = rules.claim === null ? Prisma.sql`FALSE` : Prisma.sql`(${rules.claim}::text = ANY(${user}.groups))`;
  return Prisma.sql`(${claim} OR ${conditionsSql(rules.conditions, Prisma.sql`${user}.attributes`)})`;
}
