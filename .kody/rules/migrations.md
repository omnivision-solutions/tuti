---
title: "Migrations keep working with the previous release"
scope: "file"
path: ["packages/db/prisma/migrations/**"]
severity_min: "high"
---
## Instructions
During a deploy the previous release keeps running against the new schema, and Prisma reads every column it knows about. Check that the migration works with the code on main before this PR: no dropped, renamed, retyped or newly required columns or tables it still reads or writes. Adding tables, nullable or defaulted columns, and enum values is fine. A statement marked `-- Previous release: <why it's safe>` has been judged safe.
