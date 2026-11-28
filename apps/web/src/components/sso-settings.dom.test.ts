// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const rotate = vi.fn(async () => ({ secret: "new-secret" }));
vi.mock("@/components/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trpc")>()),
  useTRPCClient: () => ({ sso: { rotate: { mutate: rotate }, disable: { mutate: vi.fn() }, update: { mutate: vi.fn() } } }),
}));
// The page's refresh never lands here: what the switch shows is the component's own.
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {} }) }));

const { SsoSettings } = await import("./sso-settings");

beforeEach(() => vi.clearAllMocks());
afterEach(() => document.body.replaceChildren());

test("turned on, the switch shows On as soon as the key is made, before the page brings it: a second click can't make another key", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  await act(async () => createRoot(box).render(h(SsoSettings, { projectSlug: "acme", enabled: false, portal: "https://acme.example", signInUrl: null })));
  const toggle = () => box.querySelector<HTMLInputElement>('[role="switch"]')!;
  await act(async () => toggle().click());
  expect(rotate).toHaveBeenCalledTimes(1);
  expect(toggle().checked).toBe(true);
  // Clicked again: it asks to turn it off, it doesn't make another key.
  await act(async () => toggle().click());
  expect(rotate).toHaveBeenCalledTimes(1);
});
