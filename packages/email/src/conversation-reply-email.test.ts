import { render } from "@react-email/render";
import { expect, test } from "vitest";

import { conversationReplyEmail } from "./conversation-reply-email";

test("a translated reply: the translation, with the team's own text quoted below it", async () => {
  const email = conversationReplyEmail({
    projectName: "Acme",
    subject: "Export",
    messages: [
      { name: "Ada", body: "Danke! Eine Lösung ist unterwegs.", original: "Thanks! A fix is on its way." },
      { name: "Ada", body: "Noch etwas?" },
    ],
  });
  const text = await render(email.body, { plainText: true });
  expect(text.indexOf("Danke! Eine Lösung ist unterwegs.")).toBeLessThan(text.indexOf("Original: Thanks! A fix is on its way."));
  expect(text.match(/Original:/g)).toHaveLength(1);
});
