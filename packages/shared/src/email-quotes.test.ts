import { expect, test } from "vitest";

import { REPLY_PREFIXES, stripQuotes } from "./email-quotes";

test.each([
  ["English", "Thanks, that worked!\n\nOn Mon, 27 Oct 2026 at 10:00, Acme Support <support@acme.tuti.email> wrote:\n> Try Settings → Export."],
  ["French", "Merci !\n\nLe lun. 27 oct. 2026 à 10:00, Acme <support@acme.tuti.email> a écrit :\n> Essayez…"],
  ["German", "Danke!\n\nAm Mo., 27. Okt. 2026 um 10:00 Uhr schrieb Acme <support@acme.tuti.email>:\n> Versuchen Sie…"],
  ["Spanish", "¡Gracias!\n\nEl lun, 27 oct 2026 a las 10:00, Acme (<support@acme.tuti.email>) escribió:\n> Pruebe…"],
  ["Dutch", "Bedankt!\n\nOp ma 27 okt 2026 om 10:00 schreef Acme <support@acme.tuti.email>:\n> Probeer…"],
  ["Italian", "Grazie!\n\nIl giorno lun 27 ott 2026 alle 10:00 Acme <support@acme.tuti.email> ha scritto:\n> Prova…"],
  ["Portuguese", "Obrigado!\n\nEm seg., 27 de out. de 2026 às 10:00, Acme <support@acme.tuti.email> escreveu:\n> Tente…"],
  ["Danish", "Tak!\n\nDen man. 27. okt. 2026 kl. 10.00 skrev Acme <support@acme.tuti.email>:\n> Prøv…"],
])("cuts the quote after the %s attribution line", (_, text) => {
  const result = stripQuotes(text);
  expect(result.stripped).toBe(true);
  expect(result.text).not.toContain("support@acme.tuti.email");
  expect(result.text.split("\n")).toHaveLength(1);
});

test("an attribution wrapped onto two lines, Outlook's blocks, signatures and quoted lines are cut", () => {
  expect(stripQuotes("Yes please.\n\nOn Mon, 27 Oct 2026 at 10:00, Acme Support\n<support@acme.tuti.email> wrote:\n> Shall we?").text).toBe("Yes please.");
  expect(stripQuotes("Done.\n\n-----Original Message-----\nFrom: Acme\nSent: Monday").text).toBe("Done.");
  expect(stripQuotes("Done.\n\n________________________________\nFrom: Acme Support <support@acme.tuti.email>\nSent: Monday").text).toBe("Done.");
  expect(stripQuotes("Done.\n\nFrom: Acme Support <support@acme.tuti.email>\nSent: Monday, 27 October 2026\nTo: me").text).toBe("Done.");
  expect(stripQuotes("Done.\n-- \nSam Smith\nAcme Corp").text).toBe("Done.");
  expect(stripQuotes("Done.\n\nSent from my iPhone").text).toBe("Done.");
  expect(stripQuotes("Done.\n\n> earlier\n>\n> more").text).toBe("Done.");
});

test("Featurebase's attribution and footer, and Yahoo's app signature, are cut", () => {
  expect(stripQuotes("Is it fixed?\n\nAaron Example (e2e-aaron@example.com) wrote on 9/30/2026, 1:47:14 PM:\nIt crashes on export.").text).toBe("Is it fixed?");
  expect(stripQuotes("Is it fixed?\nAaron Example (mailto:e2e-aaron@example.com) wrote on 9/30/2026, 1:47:14 PM:\nIt crashes.").text).toBe("Is it fixed?");
  expect(stripQuotes("Thanks!\n\nPowered by (https://featurebase.app)\nearlier").text).toBe("Thanks!");
  expect(stripQuotes("Thanks!\n\nYahoo Mail: Search, Organize, Conquer (https://mail.onelink.me/107872968?pid=nativeplacement)\n\nOn Mon, Oct 12, 2026 at 6:51 AM, Acme Support <e2e-support@example.com> wrote:").text).toBe("Thanks!");
  // Their own words that only mention someone's address are theirs.
  expect(stripQuotes("Ask Aaron (e2e-aaron@example.com), who wrote on Monday: it's fixed.").stripped).toBe(false);
  // "wrote on" without Featurebase's date and time: their own words, kept.
  expect(stripQuotes("Hi, same problem as my colleague.\nSam Lee (e2e-sam@example.com) wrote on your forum last week:\nExports fail with a 500.\nAny news?").stripped).toBe(false);
  // Featurebase's in other locales: day-first with a spaced "p. m.", and Korean.
  expect(stripQuotes("Is it fixed?\nAaron Example (e2e-aaron@example.com) wrote on 30/9/2026, 1:47:14 p. m.:\nIt crashes.").text).toBe("Is it fixed?");
  expect(stripQuotes("Is it fixed?\nAaron Example (e2e-aaron@example.com) wrote on 2026. 9. 30. 오후 1:47:14:\nIt crashes.").text).toBe("Is it fixed?");
  // Featurebase's in a 24-hour, day-first locale.
  expect(stripQuotes("Is it fixed?\nAaron Example (e2e-aaron@example.com) wrote on 30.09.2026, 13:47:14:\nIt crashes.").text).toBe("Is it fixed?");
});

test("kept whole: a forward, text with no quote, and a reply that's only a quote", () => {
  const forward = "FYI\n\nOn Mon, someone <a@example.com> wrote:\n> the bug";
  expect(stripQuotes(forward, "Fwd: the bug")).toEqual({ text: forward, stripped: false });
  expect(stripQuotes("Just a question\nwith two lines")).toEqual({ text: "Just a question\nwith two lines", stripped: false });
  expect(stripQuotes("> only a quote")).toEqual({ text: "> only a quote", stripped: false });
  // A "> " line in the middle that more text follows is theirs.
  expect(stripQuotes("I typed\n> this on purpose\nand more").stripped).toBe(false);
});

test("reply prefixes come off subjects", () => {
  expect("Re: AW: Fwd:  Export broken".replace(REPLY_PREFIXES, "")).toBe("Export broken");
  expect("Re[2]: Export".replace(REPLY_PREFIXES, "")).toBe("Export");
});
