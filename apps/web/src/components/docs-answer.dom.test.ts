// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vitest";

const answer = { id: "q1", status: "answered", answer: "From the Team page.", sources: [{ slug: "team", title: "Your team", url: null }] };
const rateDocsAnswer = vi.fn(async () => ({}));
vi.mock("@/server/docs-readers", () => ({ askDocs: vi.fn(async () => answer), rateDocsAnswer, escalateDocs: vi.fn() }));
vi.mock("@/server/widget-inbox", () => ({ widgetStartConversation: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Its imports reach the server's settings.
vi.stubEnv("APP_URL", "https://tuti.example");
vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");
const { DocsAnswer } = await import("./docs-answer");

function setUp() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const elsewhere = document.body.appendChild(document.createElement("input"));
  const root = createRoot(host);
  onTestFinished(() => {
    act(() => root.unmount());
    host.remove();
    elsewhere.remove();
  });
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(name) || b.getAttribute("aria-label") === name)!;
  const thanks = () => [...host.querySelectorAll("p")].find((p) => p.textContent === "Thanks for letting us know.");
  return { host, elsewhere, root, button, thanks };
}

const props = { projectSlug: "acme", question: "How do I invite my team?", feedbackHref: null, askAPerson: null };

test("a rating's thanks takes focus once, as it saves; later renders leave focus where the reader put it", async () => {
  const { elsewhere, root, button, thanks } = setUp();
  await act(async () => root.render(h(DocsAnswer, props)));
  await act(async () => button("Ask AI").click());
  await act(async () => button("Helpful").click());
  expect(document.activeElement).toBe(thanks());
  // The reader moves on (the search box, a source); the page renders again.
  elsewhere.focus();
  await act(async () => root.render(h(DocsAnswer, { ...props })));
  expect(document.activeElement).toBe(elsewhere);
});

test("a reader who moves on while the rating saves keeps their focus", async () => {
  const { elsewhere, root, button, thanks } = setUp();
  let saved = () => {};
  rateDocsAnswer.mockImplementationOnce(() => new Promise((resolve) => (saved = () => resolve({}))));
  await act(async () => root.render(h(DocsAnswer, props)));
  await act(async () => button("Ask AI").click());
  await act(async () => button("Helpful").click());
  // Still saving: the reader goes to the search box.
  elsewhere.focus();
  await act(async () => saved());
  expect(thanks()).toBeDefined();
  expect(document.activeElement).toBe(elsewhere);
});
