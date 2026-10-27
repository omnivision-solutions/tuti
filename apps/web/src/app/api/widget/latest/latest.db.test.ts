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

  expect((await (await ask("no-such-project")).json()) as object).toEqual({ latest: null, launcher: null, inbox: false });
  expect((await ask("../bad")).status).toBe(404);
  // Browsers that preflight (extensions, proxies adding headers) get a yes.
  expect(OPTIONS().headers.get("access-control-allow-origin")).toBe("*");
});

test("the widget learns how its launcher looks (label, colour with readable text, and corner; not the quick links) and whether the inbox is on", async () => {
  const project = await createProject(await signUp());
  const ask = async () =>
    (await (await GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`))).json()) as object;
  expect(await ask()).toEqual({ latest: null, launcher: { label: "Feedback", color: null, textColor: null, position: "bottom-right" }, inbox: false });

  await prisma.project.update({
    where: { id: project.id },
    data: {
      widgetLabel: "Help & ideas",
      widgetColor: "#facc15",
      widgetPosition: "bottom-left",
      widgetLinks: [{ label: "Status", url: "https://status.example.com" }],
      // The support inbox: the script then asks about the team's messages to whoever the page signs in.
      supportInbox: true,
    },
  });
  expect(await ask()).toEqual({
    latest: null,
    launcher: { label: "Help & ideas", color: "#facc15", textColor: "#000000", position: "bottom-left" },
    inbox: true,
  });
});
