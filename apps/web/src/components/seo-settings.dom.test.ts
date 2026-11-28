// @vitest-environment happy-dom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const refresh = vi.fn();
const mutate = vi.fn(async () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh, push: () => {} }) }));
vi.mock("@/components/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trpc")>()),
  useTRPCClient: () => ({ branding: { update: { mutate } } }),
}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/media", () => ({}));

const { SeoSettings } = await import("./seo-settings");
const { usePreviewPage } = await import("./customize-shell");

afterEach(() => document.body.replaceChildren());

/** The preview's context as Portal settings give it (PortalSettingsPane): its reload is what refreshes the page. */
function Pane({ children }: { children: ReactNode }) {
  const { provider } = usePreviewPage("SEO");
  return provider(children);
}

test("a save through tRPC refreshes the page exactly once: the preview's reload does it, as the server action's refresh did", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () =>
    createRoot(box).render(
      h(Pane, null, h(SeoSettings, { projectSlug: "acme", name: "Acme", title: "Old title", description: "", image: null, titleMax: 70, descriptionMax: 160 })),
    ),
  );
  box.querySelector<HTMLInputElement>("#seo-title")!.value = "New title";
  await act(async () => box.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mutate).toHaveBeenCalledWith({ project: "acme", seo: { title: "New title", description: "" }, seoImage: null });
  expect(refresh).toHaveBeenCalledTimes(1);
});
