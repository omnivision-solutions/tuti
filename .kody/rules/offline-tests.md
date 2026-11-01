---
title: "Tests are deterministic and offline"
scope: "file"
path: ["**/*.test.ts", "**/*.test.tsx", "e2e/**"]
severity_min: "medium"
---
## Instructions
Tests must give the same result on every run, on any machine, without network access.
- No real network calls, API keys or shared databases. External services use the fakes in `@tuti/testkit`.
- Background jobs run with `JOBS_DRIVER=inline`.
- Exception: `*.live.test.ts` files call real services on purpose (`pnpm test:live`, run by hand). They must skip, not fail, when their keys aren't set.
- Test data uses `e2e-…@example.com` emails.
