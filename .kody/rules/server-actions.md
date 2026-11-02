---
title: "Server actions check the caller and scope every id"
scope: "file"
path: ["apps/web/src/server/**"]
severity_min: "high"
---
## Instructions
Server actions are public endpoints: anyone can call them with any arguments.
- Each one enforces the access level its entry in `apps/web/src/server/authorization.db.test.ts` declares: public, signed in, or a team role. Public actions (the docs reader, the widget, sign-in links) are public on purpose.
- Every id it receives belongs to the project or account that level grants, so a caller can't read or change another project's records by passing its id.
- A new server action is listed in that matrix.
