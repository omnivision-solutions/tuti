---
title: "Migrations keep working with the previous release"
scope: "file"
path: ["packages/db/prisma/migrations/**"]
severity_min: "high"
---
## Instructions
During a deploy the previous release keeps running against the new schema, and Prisma reads every column it knows about. Check that the migration works with the code on main before this PR: no dropped, renamed, retyped or newly required columns or tables it still reads or writes. Adding tables, nullable or defaulted columns, and enum values is fine. A `-- Previous release: <why it's safe>` comment directly above a statement is the author's claim that nothing released still uses what it changes. It only exempts the statement from `packages/db/src/migrations.test.ts`. Check the claim against the code on main: if main still reads or writes what the statement drops, renames, retypes or makes required, report it.
