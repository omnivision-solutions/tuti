import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { GET, OPTIONS } from "./route";

const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

test("the widget learns when the latest announcement was: recent, announced and published only; any site may ask", async () => {
  const project = await createProject(await signUp());
  const entry = (number: number, publishedAt: Date | null, announced: boolean) =>
    prisma.changelogEntry.create({ data: { projectId: project.id, number, title: `Entry ${number}`, publishedAt, announced } });
  await entry(1, days(40), true); // too old
  await entry(2, days(5), true); // the one
  await entry(3, days(1), false); // published quietly
  await entry(4, null, true); // still a draft

  const ask = (slug: string) => GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${slug}`));
  const response = await ask(project.slug);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  const { latest } = (await response.json()) as { latest: string };
  expect(Math.abs(new Date(latest).getTime() - days(5).getTime())).toBeLessThan(60_000);

  expect((await (await ask("no-such-project")).json()) as object).toEqual({ latest: null });
  expect((await ask("../bad")).status).toBe(404);
  // Browsers that preflight (extensions, proxies adding headers) get a yes.
  expect(OPTIONS().headers.get("access-control-allow-origin")).toBe("*");
});
