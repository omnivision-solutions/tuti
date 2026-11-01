---
title: "Migrations keep working with the previous release"
scope: "file"
path: ["packages/db/prisma/migrations/**"]
severity_min: "high"
---
## Instructions
During a deploy the previous release keeps running against the new schema, and Prisma reads every column it knows about. Check that the migration works with the code on main before this PR: no dropped, renamed, retyped or newly required columns or tables it still reads or writes. Adding tables, nullable or defaulted columns, and enum values is fine. A statement with a `-- Previous release: <why it's safe>` comment directly above it has been judged safe, as `packages/db/src/migrations.test.ts` requires; the same comment anywhere else doesn't count.
