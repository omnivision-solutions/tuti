// @vitest-environment happy-dom
import { MESSAGES } from "@tuti/shared/messages";
import { NextIntlClientProvider } from "next-intl";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { FAILED, ListStatus } from "./widget-list-status";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

test("a failure is said once: the panel re-rendered with the same words (a new messages object, as a server action's refresh brings) doesn't say it again", async () => {
  vi.useFakeTimers();
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  // (The provider's props type its children as required: they're the third argument here.)
  const render = (messages: typeof MESSAGES.en) =>
    act(async () => root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" } as never, h(ListStatus, { text: FAILED }))));
  await render(MESSAGES.en);
  await act(async () => vi.advanceTimersByTime(100));
  const region = box.querySelector('[role="status"]')!;
  expect(region.textContent).toBe("Couldn't load your conversations.");
  const said: string[] = [];
  new MutationObserver(() => said.push(region.textContent ?? "")).observe(region, { childList: true, characterData: true, subtree: true });
  await render(structuredClone(MESSAGES.en));
  await act(async () => vi.advanceTimersByTime(100));
  expect(said).toEqual([]);
  await act(async () => root.unmount());
});
