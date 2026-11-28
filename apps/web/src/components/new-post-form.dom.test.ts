// @vitest-environment happy-dom
import { MESSAGES } from "@tuti/shared/messages";
import { NextIntlClientProvider } from "next-intl";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mutate = vi.fn();
// One client for the page, as the provider's.
const client = { posts: { similar: { mutate } } };
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/feedback/ideas",
}));
vi.mock("@/components/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trpc")>()),
  useTRPCClient: () => client,
}));
vi.mock("@/server/posts", () => ({ createPost: vi.fn() }));
// The details' editor's (never opened here).
vi.mock("@/server/rewrite", () => ({}));
vi.mock("@/server/images", () => ({}));

const { NewPostForm } = await import("./new-post-form");

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const post = { id: "p1", number: 1, title: "Dark mode", voteCount: 3, boardName: "Ideas", boardSlug: "ideas", voted: false };

test("a similar-posts call that fails or is refused clears the suggestions, as the action's empty answer did: never the last title's left up", async () => {
  vi.useFakeTimers();
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () =>
    createRoot(box).render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: MESSAGES.en, timeZone: "UTC" } as never,
        h(NewPostForm, { projectSlug: "acme", boardSlug: "ideas", mediaUrls: null, signedOut: true, collapsible: true }),
      ),
    ),
  );
  const title = box.querySelector<HTMLInputElement>("#post-title")!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, value);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(400));
  };
  mutate.mockResolvedValueOnce({ posts: [post] });
  await type("Dark mode");
  expect(box.textContent).toContain("Dark mode");
  expect(box.querySelector('[role="status"]')).not.toBeNull();
  mutate.mockRejectedValueOnce(new Error("Refused"));
  await type("Dark mode for the editor");
  expect(mutate).toHaveBeenLastCalledWith({ project: "acme", title: "Dark mode for the editor" }, { context: { authorization: undefined } });
  expect(box.querySelector('[role="status"]')).toBeNull();
});
