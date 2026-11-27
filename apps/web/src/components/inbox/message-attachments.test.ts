import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { MessageAttachments } from "./message-attachments";

const dropped = (imported: string | boolean) => renderToStaticMarkup(createElement(MessageAttachments, { attachments: [], dropped: 1, imported }));

test("files an import couldn't bring are said under their message, in English: from the tool it names (the team's inbox), or none", () => {
  expect(dropped("Ferndesk")).toContain("1 attachment wasn&#x27;t brought across from Ferndesk.");
  expect(dropped(true)).toContain("1 attachment wasn&#x27;t brought across.");
  expect(dropped(false)).toContain("1 attachment wasn&#x27;t kept: this server has no file storage.");
});

test("the widget says the list's name and what wasn't brought across in its reader's language (`words`), else English", () => {
  const html = renderToStaticMarkup(
    createElement(MessageAttachments, {
      attachments: [{ id: "a1", filename: "report.pdf", contentType: "application/pdf", size: 1000, url: "https://files.example/report.pdf" }] as never,
      dropped: 1,
      imported: true,
      words: { attachments: "Anhänge", dropped: "1 Anhang wurde nicht übernommen." },
    }),
  );
  expect(html).toContain('aria-label="Anhänge"');
  expect(html).toContain("1 Anhang wurde nicht übernommen.");
  expect(html).not.toContain("brought across");
  expect(renderToStaticMarkup(createElement(MessageAttachments, { attachments: [], dropped: 1, imported: true }))).toContain("1 attachment wasn&#x27;t brought across.");
});
