import { vi } from "vitest";

// Emails go to a local SMTP fake, readable through `mailbox`.
import "./mailbox";

// Server actions run outside a Next.js request: the signed-in user comes from
// actAs() (apps/web/src/test/helpers.ts) and cache refreshes are no-ops.
vi.mock("next/headers", () => import("./next-headers"));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {} }));
