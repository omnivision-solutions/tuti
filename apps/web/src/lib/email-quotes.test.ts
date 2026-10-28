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
