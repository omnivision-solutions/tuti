// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

// Try again's call, through tRPC (conversations.retryTranslation), and the page's refresh after it.
const retryTranslation = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/components/trpc", () => ({ useTRPCClient: () => ({ conversations: { retryTranslation: { mutate: retryTranslation } } }), errorMessage: String }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { MessageTranslation, TranslationRetries } = await import("./message-translation");

/** A conversation's customer messages as the page renders them: `failed`, those whose translation failed (Try again re-queues them). */
function page(root: Root, errors: Record<string, string | null>, failed: string[]) {
  const message = (id: string) =>
    h(
      "li",
      { key: id, "data-message": id },
      h(MessageTranslation, { id, body: `Nachricht ${id}`, teamText: null, language: "de", error: errors[id] ?? null, fromTeam: false, canRetry: true, projectSlug: "acme", number: 1 }),
    );
  return act(async () => root.render(h(TranslationRetries, { failed, children: h("ol", null, ...Object.keys(errors).map(message)) })));
}

afterEach(() => {
  vi.useRealTimers();
  retryTranslation.mockClear();
  document.body.replaceChildren();
});

test("Try again's Translating… shows on every message it re-queued, not only the one clicked, and clears after a while", async () => {
  vi.useFakeTimers();
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const says = (id: string) => element.querySelector(`[data-message="${id}"]`)!.textContent;
  // Two failed (re-queued by one Try again); one never translated (in the team's language), which it doesn't touch.
  await page(root, { m1: "Out of credits", m2: "Out of credits", m3: null }, ["m1", "m2"]);
  const tryAgain = [...element.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
  await act(async () => tryAgain.click());
  expect(retryTranslation).toHaveBeenCalledWith({ project: "acme", number: 1 });
  // The page comes back refreshed: their failures cleared (the operation claimed them), none translated yet.
  await page(root, { m1: null, m2: null, m3: null }, []);
  expect(says("m1")).toContain("Translating…");
  expect(says("m2")).toContain("Translating…");
  expect(says("m3")).not.toContain("Translating…");
  // A minute on, with no word from the job: the line goes.
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(says("m1")).not.toContain("Translating…");
  expect(says("m2")).not.toContain("Translating…");
});

test("a re-queued message whose failure is still on the page shows the failure: a retry that fails again isn't hidden", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await page(root, { m1: "Out of credits" }, ["m1"]);
  await act(async () => [...element.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click());
  // Refreshed before the job ran, or after it failed again: the failure stays said.
  await page(root, { m1: "Out of credits" }, ["m1"]);
  const says = element.querySelector('[data-message="m1"]')!.textContent;
  expect(says).toContain("Out of credits");
  expect(says).not.toContain("Translating…");
});
