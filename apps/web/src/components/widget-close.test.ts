import { expect, test, vi } from "vitest";

import { announceClose } from "./widget-close";

test("the widget's Close tells the loader it's here, and that it's gone: the page going away, or the Close (an error screen in its place)", () => {
  const listeners: Record<string, () => void> = {};
  const page = {
    parent: { postMessage: vi.fn() },
    addEventListener: (type: string, listener: () => void) => void (listeners[type] = listener),
    removeEventListener: vi.fn(),
  };
  const cleanup = announceClose(page as never);
  expect(page.parent.postMessage).toHaveBeenLastCalledWith("tuti:closable", "*");
  // The page goes away.
  listeners.pagehide!();
  expect(page.parent.postMessage).toHaveBeenLastCalledWith({ type: "tuti:closable", closable: false }, "*");
  // The Close goes (unmounted): said again.
  page.parent.postMessage.mockClear();
  cleanup();
  expect(page.parent.postMessage).toHaveBeenCalledWith({ type: "tuti:closable", closable: false }, "*");
  expect(page.removeEventListener).toHaveBeenCalledWith("pagehide", listeners.pagehide);
});
