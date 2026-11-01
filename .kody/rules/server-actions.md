---
title: "Server actions check the caller and scope every id"
scope: "file"
path: ["apps/web/src/server/**"]
severity_min: "high"
---
## Instructions
Server actions are public endpoints: anyone can call them with any arguments.
- Each one checks who is calling (signed in, team role) before doing anything.
- Every id it receives is scoped to the caller's project, so a caller can't read or change another project's records by passing its id.
- A new server action is listed in `apps/web/src/server/authorization.db.test.ts`.
