import { prisma } from "@tuti/db";
import { afterEach, expect, test, vi } from "vitest";

import { portalUrl } from "@/lib/hosts";
import { createProject, signUp } from "@/test/helpers";

import { GET, OPTIONS } from "./route";

afterEach(() => vi.unstubAllEnvs());

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

test("the widget learns how its launcher looks (name, colour with readable text, corner and icon; not the quick links) and whether the inbox is on", async () => {
  // Without plans, whatever the environment says: the icon is served on every plan then (launcher-icon.db.test.ts has the rest).
  vi.stubEnv("PLANS", "");
  const project = await createProject(await signUp());
  const ask = async () =>
    (await (await GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`))).json()) as object;
  expect(await ask()).toEqual({ latest: null, launcher: { label: "Feedback", color: null, textColor: null, position: "bottom-right", icon: "chat", iconUrl: null }, inbox: false });

  await prisma.project.update({
    where: { id: project.id },
    data: {
      widgetLabel: "Help & ideas",
      widgetColor: "#facc15",
      widgetPosition: "bottom-left",
      widgetIcon: "megaphone",
      widgetLinks: [{ label: "Status", url: "https://status.example.com" }],
      // The support inbox: the script then asks about the team's messages to whoever the page signs in.
      supportInbox: true,
    },
  });
  expect(await ask()).toEqual({
    latest: null,
    launcher: { label: "Help & ideas", color: "#facc15", textColor: "#000000", position: "bottom-left", icon: "megaphone", iconUrl: null },
    inbox: true,
  });
});

test("read from one of the team's sites, the widget counts as added (Home's Get set up); from the app, or its portal, it doesn't", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const from = (origin: string) => GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`, { headers: { origin } }));
  const seen = async () => (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { widgetSeenAt: true } })).widgetSeenAt;
  await from(new URL(process.env.APP_URL!).origin);
  await from(new URL(portalUrl(project.slug)).origin);
  expect(await seen()).toBeNull();
  await from("https://www.acme.example");
  expect(await seen()).not.toBeNull();
});

test("the portal at its own address doesn't count as one of the team's sites either", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const hostname = `help-${project.slug}.example.com`;
  await prisma.customDomain.create({ data: { projectId: project.id, hostname, verificationToken: "t", verifiedAt: new Date() } });
  const { protocol, port } = new URL(portalUrl(project.slug));
  const from = (origin: string) => GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`, { headers: { origin } }));
  await from(`${protocol}//${hostname}${port ? `:${port}` : ""}`);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { widgetSeenAt: true } })).widgetSeenAt).toBeNull();
});

test("a portal under a path of the team's site: the site still counts (the widget may be on it)", async () => {
  vi.stubEnv("PLANS", "on");
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { plan: "BUSINESS" } });
  await prisma.siteMount.create({ data: { projectId: project.id, origin: "https://www.acme.example", path: "/portal", verificationToken: "t", verifiedAt: new Date() } });
  await GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`, { headers: { origin: "https://www.acme.example" } }));
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { widgetSeenAt: true } })).widgetSeenAt).not.toBeNull();
});
