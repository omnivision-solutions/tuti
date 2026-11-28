// @vitest-environment happy-dom
import { MESSAGES } from "@tuti/shared/messages";
import { NextIntlClientProvider } from "next-intl";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const sendVerificationEmail = vi.fn(async () => ({ error: null }));
vi.mock("@/components/portal-base", () => ({ usePortalAuthClient: () => ({ sendVerificationEmail }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const { ResendVerificationButton } = await import("./resend-verification-button");

test("Resend email says the page's language, for its email's (lib/auth.ts)", async () => {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  const button = h(ResendVerificationButton, { email: "e2e-ada@example.com", callbackURL: "/de/account" });
  // (The provider's props type its children as required: they're the third argument here.)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "de", messages: MESSAGES.de, timeZone: "UTC" } as never, button)));
  await act(async () => box.querySelector("button")!.click());
  expect(sendVerificationEmail).toHaveBeenCalledWith({ email: "e2e-ada@example.com", callbackURL: "/de/account" }, { headers: { "x-tuti-page-language": "de" } });
  await act(async () => root.unmount());
});
