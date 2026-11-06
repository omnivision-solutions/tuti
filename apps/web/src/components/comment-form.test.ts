import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/sign-in-link", () => ({ useSignInHref: () => "/sign-in" }));
vi.mock("@/components/rich-editor", () => ({ RichEditor: () => null }));
vi.mock("@/server/posts", () => ({ addComment: async () => ({}) }));

const { CommentForm } = await import("./comment-form");

/** The team's reply form's Email voters switch, as markup. */
const emailVoters = (voters: number | "paused") => {
  const html = renderToStaticMarkup(createElement(CommentForm, { postId: "p", notes: true, voters }));
  return { html, switch: html.match(/<[^>]*name="emailVoters"[^>]*>/)?.[0] ?? "" };
};

test("while the project's email is paused, Email voters is off, can't be turned on, and says why", () => {
  const paused = emailVoters("paused");
  expect(paused.html).toContain("your project&#x27;s email is paused");
  expect(paused.switch).toMatch(/ disabled=""/);
  expect(paused.switch).not.toMatch(/ checked=""/);
  expect(paused.html).not.toContain("Comment and email");
  // With voters to email, it can be.
  expect(emailVoters(3).switch).not.toMatch(/ disabled=""/);
});
