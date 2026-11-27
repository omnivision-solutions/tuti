import { render } from "@react-email/render";
import { expect, test } from "vitest";

import { emailLanguage } from "./language";
import { passwordChangedEmail, passwordResetEmail } from "./password-reset-email";
import { signInLinkEmail } from "./sign-in-link-email";

const project = { projectName: "Acme", accent: null, poweredBy: true, logo: null };

test("a sign-in link's email in the language of the page it was asked on: its subject, words, `lang` and Powered by", async () => {
  const email = signInLinkEmail({ ...project, url: "https://acme.example/de/sign-in/link?token=t", minutes: 15, language: "de" });
  expect(email.subject).toBe("Bei Acme anmelden");
  const html = await render(email.body);
  expect(html).toMatch(/<html[^>]* lang="de"/);
  const text = await render(email.body, { plainText: true });
  for (const shown of ["Hier ist dein Link, um dich bei Acme anzumelden.", "Der Link funktioniert einmal und läuft in 15 Minuten ab.", "Wenn du das nicht angefordert hast", "Bereitgestellt von"]) {
    expect(text).toContain(shown);
  }
  // English without a language (the team's and Tuti's own), as before.
  const english = signInLinkEmail({ ...project, url: "https://acme.example/sign-in/link?token=t", minutes: 15 });
  expect(english.subject).toBe("Sign in to Acme");
  expect(await render(english.body)).toMatch(/<html[^>]* lang="en"/);
  expect(await render(english.body, { plainText: true })).toMatch(/Powered by\s+tuti/);
});

test("a password reset and its change notice in the page's language; the app's (no project, no language) in English", async () => {
  const reset = passwordResetEmail({ project, url: "https://tuti.example/app/auth/reset-password?token=t", minutes: 60, language: "fr" });
  expect(reset.subject).toBe("Réinitialiser votre mot de passe");
  expect(await render(reset.body, { plainText: true })).toContain("Quelqu’un a demandé à réinitialiser le mot de passe de votre compte sur Acme.");
  const changed = passwordChangedEmail(project, "fr");
  expect(changed.subject).toBe("Votre mot de passe a été modifié");
  // "Forgot your password?" as the French sign-in page says it.
  expect(await render(changed.body, { plainText: true })).toContain("« Mot de passe oublié ? »");
  expect(passwordResetEmail({ url: "https://tuti.example/x", minutes: 60 }).subject).toBe("Reset your password");
});

test("a language the app doesn't have is English", () => {
  expect(emailLanguage("xx")).toBe("en");
  expect(emailLanguage(null)).toBe("en");
  expect(emailLanguage("pt-BR")).toBe("pt-BR");
});
