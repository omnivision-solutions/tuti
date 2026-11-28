import { MESSAGES } from "@tuti/shared/messages";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { UploadList } from "./attachment-uploads";
import { SendError } from "./send-error";

// (The provider's props type its children as required: they're the third argument here.)
const inGerman = (element: ReactElement) =>
  renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "de", messages: MESSAGES.de, timeZone: "UTC" } as never, element));

test("an upload's failure: the server's words marked English (L5), the panel's own in the page's language, unmarked", () => {
  const html = inGerman(
    createElement(UploadList, {
      remove: () => {},
      uploads: [
        { key: "a", name: "a.exe", size: 10, startedAt: 0, error: "This file type isn't allowed.", serverSaid: true },
        { key: "b", name: "b.pdf", size: 10, startedAt: 0, error: MESSAGES.de.widget.couldntUpload },
      ],
    }),
  );
  expect(html).toContain(`<span lang="en" class="shrink-0 text-xs text-destructive">This file type isn&#x27;t allowed.</span>`);
  expect(html).toContain(`<span class="shrink-0 text-xs text-destructive">${MESSAGES.de.widget.couldntUpload}</span>`);
});

test("a message that didn't go: the panel's own failure in its language, unmarked; the server's words marked English", () => {
  expect(inGerman(createElement(SendError, { error: MESSAGES.de.widget.couldntSend }))).toBe(`<p class="text-sm text-destructive">${MESSAGES.de.widget.couldntSend}</p>`);
  expect(inGerman(createElement(SendError, { error: "Conversation not found.", alert: true }))).toBe(`<p role="alert" lang="en" class="text-sm text-destructive">Conversation not found.</p>`);
});
