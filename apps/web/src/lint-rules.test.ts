import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { expect, test } from "vitest";

/**
 * The tRPC migration's lint rules (eslint-rules.mjs), run as `pnpm lint` runs them: what they warn on is the list of
 * files left to move (docs/plan.md, "One way in").
 */

const web = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: web });

/** The tuti/* warnings for `code` as if it were the file at `path` (under apps/web). */
async function warnings(path: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: `${web}${path}` });
  return result!.messages.filter((message) => message.ruleId?.startsWith("tuti/")).map((message) => message.ruleId);
}

test('no server actions: no "use server", and no import of a "use server" module or operations/run.ts', { timeout: 60_000 }, async () => {
  expect(await warnings("src/server/example.ts", '"use server";\n\nexport async function save() {}\n')).toEqual(["tuti/no-server-actions"]);
  // server/screenshots.ts is a "use server" module.
  expect(await warnings("src/server/example.ts", 'import { saveScreenshotSettings } from "./screenshots";\n\nvoid saveScreenshotSettings;\n')).toEqual(["tuti/no-server-actions"]);
  expect(await warnings("src/server/example.db.test.ts", 'import { call } from "@/server/operations/run";\n\nvoid call;\n')).toEqual(["tuti/no-server-actions"]);
  expect(await warnings("src/server/example.ts", 'import { runOperation } from "./operations/define";\n\nvoid runOperation;\n')).toEqual([]);
});

test("the boundary: pages, components and lib/ take only serverCaller, types and constants from the server, and no Prisma", { timeout: 60_000 }, async () => {
  const page = "src/app/app/(workspace)/[project]/example/page.tsx";
  expect(await warnings(page, 'import { serverCaller } from "@/server/trpc/server";\nimport { MAX_AI_NAME, type AiFirstSettings } from "@/server/operations/ai-first";\nimport type { Session } from "@/server/auth/auth";\n\nexport type S = [AiFirstSettings, Session, typeof MAX_AI_NAME, typeof serverCaller];\n')).toEqual([]);
  expect(await warnings(page, 'import { aiFirstSettings } from "@/server/operations/ai-first";\n\nvoid aiFirstSettings;\n')).toEqual(["tuti/server-boundary"]);
  expect(await warnings(page, 'import { runOperation } from "@/server/operations/define";\n\nvoid runOperation;\n')).toEqual(["tuti/server-boundary"]);
  expect(await warnings("src/components/example.tsx", 'import { getMembership } from "@/server/membership";\n\nvoid getMembership;\n')).toEqual(["tuti/server-boundary"]);
  expect(await warnings("src/lib/example.ts", 'import { prisma, type TeamRole } from "@tuti/db";\n\nexport type R = TeamRole;\nvoid prisma;\n')).toEqual(["tuti/server-boundary"]);
  // Exempt by name: REST serves operations; Better Auth's handler is built from server/auth; proxy.ts's routing reads.
  expect(await warnings("src/app/api/v1/example/route.ts", 'import { authenticate } from "@/server/api-auth";\n\nvoid authenticate;\n')).toEqual([]);
  expect(await warnings("src/app/api/auth/example/route.ts", 'import { auth } from "@/server/auth/auth";\n\nvoid auth;\n')).toEqual([]);
  expect(await warnings("src/proxy.ts", 'import { siteMount } from "@/server/custom-domains";\n\nvoid siteMount;\n')).toEqual([]);
  // An exemption covers the imports it names, not the whole file.
  expect(await warnings("src/proxy.ts", 'import { getMembership } from "@/server/membership";\n\nvoid getMembership;\n')).toEqual(["tuti/server-boundary"]);
  // The server layer itself isn't checked.
  expect(await warnings("src/server/example.ts", 'import { prisma } from "@tuti/db";\n\nvoid prisma;\n')).toEqual([]);
});
