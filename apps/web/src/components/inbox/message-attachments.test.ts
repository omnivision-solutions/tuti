import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { MessageAttachments } from "./message-attachments";

const dropped = (imported: string | boolean) => renderToStaticMarkup(createElement(MessageAttachments, { attachments: [], dropped: 1, imported }));

test("files an import couldn't bring are said under their message: from the tool it names (the team's inbox), or none (the widget)", () => {
  expect(dropped("Ferndesk")).toContain("1 attachment wasn&#x27;t brought across from Ferndesk.");
  expect(dropped(true)).toContain("1 attachment wasn&#x27;t brought across.");
  expect(dropped(false)).toContain("1 attachment wasn&#x27;t kept: this server has no file storage.");
});
