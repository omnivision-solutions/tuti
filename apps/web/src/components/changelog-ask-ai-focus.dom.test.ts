// @vitest-environment happy-dom
import { act, createElement as h, useContext, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import type { Doc } from "@tuti/content";

let answer: (result: object) => void = () => {};
const draftChangelogEntry = vi.fn(() => new Promise<object>((resolve) => (answer = resolve)));
vi.mock("@/server/changelog", () => ({ draftChangelogEntry }));
vi.mock("@/server/images", () => ({}));
vi.mock("@/server/rewrite", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const { ChangelogEntryActions, ChangelogForm, ChangelogSaving, ChangelogSavingContext } = await import("./changelog");

afterEach(() => document.body.replaceChildren());

const entry = (text: string) => ({
  number: 7,
  title: "Dark mode",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } as Doc,
  tags: [],
  groups: [],
  posts: [],
  published: false,
  cover: null,
  told: null,
  announced: false,
  emailedSubscribers: false,
  subscribersLeft: 0,
  subscribersSent: 0,
});

test("Draft with AI's new text makes the form again: the keyboard's focus ends on the new Ask AI, even when the dialog gave it to the old one first", async () => {
  let openDraft = () => {};
  // Ask AI's dialog opens Draft with AI's (saving.setDrafting), as "Draft with AI…" in it does.
  function Opener() {
    const saving = useContext(ChangelogSavingContext);
    useEffect(() => {
      openDraft = () => saving?.setDrafting(true);
    }, [saving]);
    return null;
  }
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  // The page keys the form by its title and text (changelog/[number]/page.tsx): new text, a new form.
  const render = (text: string) =>
    act(async () =>
      root.render(
        h(
          ChangelogSaving,
          null,
          h(Opener),
          h(ChangelogEntryActions, { projectSlug: "acme", number: 7, title: "Dark mode", published: false, postCount: 0, subscribers: 0, emails: 0, canDraftWithAi: true, part: "publish" }),
          h(ChangelogForm, { key: text, projectSlug: "acme", entry: entry(text), posts: [], mediaUrls: null, canAskAi: true }),
        ),
      ),
    );
  await render("Notes from the pull requests");
  const old = document.getElementById("ask-ai")!;
  old.focus();
  await act(async () => openDraft());
  const replace = [...document.querySelectorAll("button")].find((button) => button.textContent === "Replace the text")!;
  await act(async () => replace.click());
  // The draft is written and the dialog closes, giving the focus back to Ask AI, before the page has the new text.
  await act(async () => answer({}));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(old);
  // Then the new text comes: the form (and its Ask AI) is made again.
  await render("A darker look");
  const now = document.getElementById("ask-ai")!;
  expect(now).not.toBe(old);
  expect(document.activeElement).toBe(now);
});
