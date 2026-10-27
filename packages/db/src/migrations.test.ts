import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A deploy runs the previous release beside the new schema (see AGENTS.md), and
// Prisma selects every column it knows, so these break it. Written before the rule.
const grandfatheredThrough = "20261026120000_license_checkout";

const breaking = [
  /\bDROP\s+(TABLE|COLUMN|TYPE)\b/i,
  /\bALTER\s+(TABLE|TYPE)\s+\S+\s+RENAME\b/i,
  /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
];

const markedSafe = "\u0000previous-release\u0000";

/** The statements in a migration that the previous release can't run against, unless marked safe. */
function unsafeStatements(sql: string): string[] {
  // One pass, so a quote inside a comment or "--" inside a string can't confuse the other.
  const code = sql.replace(/'(?:[^']|'')*'|--[^\n]*/g, (token) =>
    token.startsWith("--") ? (/^--\s*Previous release:/i.test(token) ? markedSafe : "") : "''",
  );
  return code
    .split(";")
    .filter((statement) => !statement.includes(markedSafe))
    .filter((statement) => {
      const bare = statement.replace(/"[^"]*"/g, '""');
      return (
        breaking.some((pattern) => pattern.test(bare)) ||
        // A required column without a default: the previous release's inserts leave it out.
        bare
          .split(/\bADD\s+(?!CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|VALUE)(?:COLUMN\b)?/i)
          .slice(1)
          .map((rest) => rest.split(/,\s*(?:ADD|ALTER|DROP)\b/i)[0] ?? "")
          .some((column) => /\bNOT\s+NULL\b/i.test(column) && !/\bDEFAULT\b/i.test(column))
      );
    })
    .map((statement) => statement.trim());
}

describe("migrations", () => {
  it("keep working with the previous release", () => {
    const dir = new URL("../prisma/migrations/", import.meta.url);
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name > grandfatheredThrough)
      .flatMap((entry) =>
        unsafeStatements(readFileSync(new URL(`${entry.name}/migration.sql`, dir), "utf8")).map(
          (statement) => `${entry.name}: ${statement}`,
        ),
      );
    expect(found).toEqual([]);
  });

  it.each([
    ['ALTER TABLE "post" DROP COLUMN "title"'],
    ['DROP TABLE "post"'],
    ['ALTER TABLE "post" RENAME COLUMN "title" TO "name"'],
    ['ALTER TABLE "post" RENAME TO "idea"'],
    ['ALTER TYPE "Role" RENAME TO "Role_old"'],
    ['ALTER TABLE "post" ALTER COLUMN "votes" SET DATA TYPE BIGINT'],
    ['ALTER TABLE "post" ALTER COLUMN "title" SET NOT NULL'],
    ['ALTER TABLE "post" ADD COLUMN "slug" TEXT NOT NULL'],
    ['ALTER TABLE "post" ADD COLUMN "a" TEXT, ADD COLUMN "slug" TEXT NOT NULL'],
    ['ALTER TABLE "post" ADD COLUMN "price" DECIMAL(10,2) NOT NULL'],
    ['ALTER TABLE "post" ADD "slug" TEXT NOT NULL'],
    ['ALTER TABLE "post" ADD COLUMN "default" TEXT NOT NULL'],
  ])("flags %s", (sql) => {
    expect(unsafeStatements(`-- AlterTable\n${sql};\n`)).toEqual([sql]);
  });

  it("ignores what comments and strings say", () => {
    const sql = 'ALTER TABLE "post" ADD COLUMN "slug" TEXT NOT NULL -- DEFAULT comes later; promise\n;';
    expect(unsafeStatements(sql)).toEqual(['ALTER TABLE "post" ADD COLUMN "slug" TEXT NOT NULL']);
    expect(unsafeStatements("UPDATE \"post\" SET \"title\" = 'DROP TABLE x; -- y';\n")).toEqual([]);
  });

  it.each([
    ['ALTER TABLE "post" ADD COLUMN "slug" TEXT'],
    ['ALTER TABLE "post" ADD COLUMN "votes" INTEGER NOT NULL DEFAULT 0'],
    ['ALTER TABLE "post" ADD COLUMN "a" TEXT NOT NULL DEFAULT \'x\', ADD COLUMN "b" TEXT'],
    ['CREATE TABLE "idea" ("id" TEXT NOT NULL)'],
    ['DROP INDEX "post_title_idx"'],
    ['ALTER INDEX "a" RENAME TO "b"'],
    ['ALTER TYPE "Role" ADD VALUE \'OWNER\''],
    ['-- Previous release: 1.4 stopped reading it.\nALTER TABLE "post" DROP COLUMN "title"'],
    ['ALTER TABLE "post" ADD CONSTRAINT "c" CHECK ("title" IS NOT NULL)'],
    ["-- Previous release: unused since 1.4; safe to remove.\nALTER TABLE \"post\" DROP COLUMN \"title\""],
    ["-- Previous release: nothing reads it (it's new).\nALTER TABLE \"post\" DROP COLUMN \"title\""],
  ])("allows %s", (sql) => {
    expect(unsafeStatements(`${sql};\n`)).toEqual([]);
  });
});
