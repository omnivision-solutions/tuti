import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, onTestFinished, test } from "vitest";

import { actAs, createProject, onPortal, signUp, withoutEmail } from "@/test/helpers";
import { request } from "@/test/next-headers";

import SignInPage from "./sign-in/page";

test("a private portal's reader whose address isn't verified yet is told, in the page's language, with the address", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  // A reader the team added by address, signed in before verifying it.
  const reader = await signUp("Reader", undefined, { verified: false });
  await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email.toLowerCase() } });
  await onPortal(reader, project);
  actAs(reader);
  // The German address (what proxy.ts sets on its requests).
  request.headers = { "x-tuti-language": "de", "x-tuti-language-prefix": "/de" };
  onTestFinished(() => {
    request.headers = {};
  });

  const html = renderToStaticMarkup(await SignInPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never));
  expect(html).toContain(
    `${reader.email} kann ${project.name} lesen, sobald die Adresse bestätigt ist. Melde dich mit einem Link per E-Mail an, um sie zu bestätigen.`,
  );
});

test("on a server that sends no email, the sign-in page's way in, through Tuti's own sign-in, is in the page's language", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(null);
  request.host = `${project.slug}.localhost:3100`;
  request.headers = { "x-tuti-language": "de", "x-tuti-language-prefix": "/de" };
  onTestFinished(() => {
    request.host = "";
    request.headers = {};
  });

  const html = await withoutEmail(async () =>
    renderToStaticMarkup(await SignInPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never)),
  );
  expect(html).toContain("Weiter mit deinem Tuti-Konto");
});
