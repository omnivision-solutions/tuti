// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), unstable_rethrow: () => {} }));
vi.mock("@/server/api-references", () => ({}));
vi.mock("@/server/docs", () => ({}));

// Its imports reach the server's settings.
vi.stubEnv("APP_URL", "https://tuti.example");
vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");

const { SourceUrl } = await import("./api-reference-settings");

afterEach(() => document.body.replaceChildren());

test("the stored address typed in before the page has it is the field left alone: a teammate's next address shows", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const refresh = (url: string) => act(async () => root.render(h(SourceUrl, { projectSlug: "acme", slug: "acme-api", url })));
  await refresh("https://a.example/openapi.json");
  const field = box.querySelector<HTMLInputElement>("#reference-source-url")!;
  // Typed while the page still has the old address: an edit, for now.
  await act(async () => {
    // React tracks the value it set: the prototype's setter gets a typed one past it.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "https://b.example/openapi.json");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The page catches up with it (the change just made), then a teammate moves it on.
  await refresh("https://b.example/openapi.json");
  await refresh("https://c.example/openapi.json");
  expect(field.value).toBe("https://c.example/openapi.json");
});
