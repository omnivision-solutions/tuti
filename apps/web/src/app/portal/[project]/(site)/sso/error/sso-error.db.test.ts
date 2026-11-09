import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import SsoErrorPage from "./page";

/** A failed sign-on: plain words first, the technical detail as a footnote, and a way to try again. */
test("the SSO error says it in plain words, keeps the code as a footnote, and offers Try again (sign-in) and the board", async () => {
  const project = await createProject(await signUp());
  const html = renderToStaticMarkup(
    await SsoErrorPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ code: "invalid_claims" }) } as never),
  );
  expect(html).toContain("Couldn&#x27;t sign you in");
  expect(html).toContain("Signing in from your account didn&#x27;t work. Try again, or tell the team if it keeps happening.");
  expect(html).toMatch(/<code[^>]*>invalid_claims<\/code>/);
  expect(html).toMatch(/<a[^>]*href="\/sign-in"[^>]*>Try again<\/a>/);
  expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Continue to the board<\/a>/);
});
