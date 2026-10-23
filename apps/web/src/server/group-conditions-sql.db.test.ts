import { Prisma, prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { CONDITION_CASES } from "@/lib/group-conditions.cases";

import { conditionsSql } from "./group-conditions-sql";

/** conditionsSql matches what conditionsMatch does (lib/group-conditions.test.ts runs the same cases). */
test.each(CONDITION_CASES)("$name", async ({ conditions, properties, matches }) => {
  const [row] = await prisma.$queryRaw<[{ matches: boolean }]>`
    SELECT ${conditionsSql(conditions, Prisma.sql`t.p`)} AS matches FROM (SELECT ${JSON.stringify(properties)}::jsonb AS p) t`;
  expect(row.matches).toBe(matches);
});
