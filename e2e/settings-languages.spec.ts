import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";
import { nextModelReply } from "./model";

test("an owner adds German in Settings → Languages, writes its instructions, makes it live, takes it offline and removes it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Under Portal, after SEO.
  await owner.goto(`/app/${slug}/settings/seo`);
  await owner.getByRole("link", { name: "Languages" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/languages`);
  const pane = owner.getByRole("region", { name: "Languages" });
  const defaultLanguage = pane.getByRole("combobox", { name: "Default language" });
  await expect(defaultLanguage).toContainText("English");
  await expect(defaultLanguage).toBeEnabled();
  await expect(pane.getByText("Only English so far.", { exact: false })).toBeVisible();

  // Adding asks first: which language, the pages it takes on, offline until it's made live.
  await pane.getByRole("button", { name: "Add language" }).click();
  const add = owner.getByRole("dialog", { name: "Add a language" });
  await expect(add).toContainText("only your team sees it until you make it live");
  await expect(add).toContainText(/\d+ published pages?, shown in English until they're translated/);
  await expect(add.getByRole("button", { name: "Add language" })).toBeDisabled();
  await add.getByRole("combobox", { name: "Language" }).click();
  await owner.getByRole("option", { name: "Deutsch (German)" }).click();
  await checkpoint(owner, "settings-languages-add", { fullPage: false });
  await add.getByRole("button", { name: "Add Deutsch" }).click();
  await expect(owner.getByText("Added Deutsch")).toBeVisible();
  await expect(add).toBeHidden();

  const languages = pane.getByRole("list", { name: "Other languages" });
  const german = languages.getByRole("listitem").filter({ hasText: "Deutsch" });
  await expect(german).toContainText("German · Automatic");
  await expect(german).toContainText("Offline");
  // With another language the default is locked.
  await expect(defaultLanguage).toBeDisabled();
  await expect(pane.getByText("Remove the other languages first to change it.", { exact: false })).toBeVisible();

  // Instructions, and "Our product is available in Deutsch".
  const menu = german.getByRole("button", { name: "Actions for German" });
  await menu.click();
  await owner.getByRole("menuitem", { name: "Instructions…" }).click();
  const instructions = owner.getByRole("dialog", { name: "Translating into Deutsch" });
  await instructions.getByRole("textbox", { name: "Instructions" }).fill("Use du, not Sie.");
  const product = instructions.getByRole("switch", { name: "Our product is available in Deutsch" });
  await expect(product).toHaveAccessibleDescription("Off: names of buttons and screens stay as written. On: they're translated.");
  await product.check();
  await instructions.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved Deutsch's instructions")).toBeVisible();
  await expect(instructions).toBeHidden();

  // New pages: Manual.
  await menu.click();
  await owner.getByRole("menuitemradio", { name: "Manual" }).click();
  await expect(german).toContainText("German · Manual");

  // Go live, then offline again.
  await menu.click();
  await owner.getByRole("menuitem", { name: "Go live" }).click();
  await expect(owner.getByText("Deutsch is live")).toBeVisible();
  await expect(german).toContainText("Live");
  // Its toast gone, so the screenshots show the page.
  await expect(owner.getByText("Deutsch is live")).toBeHidden({ timeout: 10_000 });
  await checkpoint(owner, "settings-languages");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "settings-languages-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await menu.click();
  await owner.getByRole("menuitem", { name: "Take offline" }).click();
  await expect(owner.getByText("Deutsch is offline")).toBeVisible();

  // Saved as set, after a reload.
  await owner.reload();
  await menu.click();
  await owner.getByRole("menuitem", { name: "Instructions…" }).click();
  await expect(instructions.getByRole("textbox", { name: "Instructions" })).toHaveValue("Use du, not Sie.");
  await expect(product).toBeChecked();
  await instructions.getByRole("button", { name: "Cancel" }).click();
  await expect(instructions).toBeHidden();

  // Removing asks first; then the default can change again.
  await menu.click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  const remove = owner.getByRole("alertdialog", { name: "Remove Deutsch?" });
  await remove.getByRole("button", { name: "Remove Deutsch" }).click();
  await expect(owner.getByText("Removed Deutsch")).toBeVisible();
  await expect(remove).toBeHidden();
  await expect(languages).toBeHidden();
  // The row's ⋯ menu went with it: focus is on Add language, not lost.
  await expect(pane.getByRole("button", { name: "Add language" })).toBeFocused();
  await expect(defaultLanguage).toBeEnabled();
});

/** A query on the journeys' database. */
async function query(sql: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

// On Tuti's cloud, which sells plans: Free has the default language alone.
test("on a plan with no room for another language, Add language and Go live offer the upgrade", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/settings/languages`);
  const add = owner.getByRole("button", { name: "Add language" });
  await expect(add).toHaveAccessibleDescription(/^Projects on the Free plan have 1 language, the default included\. Upgrade to /);
  await add.click();
  const prompt = owner.getByRole("dialog", { name: /^Projects on the Free plan have 1 language/ });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "settings-languages-add-upgrade", { fullPage: false });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();

  // German kept from a bigger plan (after a downgrade): Go live offers the upgrade too, and it stays offline.
  await query(`INSERT INTO project_language ("projectId", code) SELECT id, 'de' FROM project WHERE slug = $1`, [slug]);
  await owner.reload();
  const german = owner.getByRole("list", { name: "Other languages" }).getByRole("listitem").filter({ hasText: "Deutsch" });
  await german.getByRole("button", { name: "Actions for German" }).click();
  const goLive = owner.getByRole("menuitem", { name: "Go live" });
  await expect(goLive).toHaveAccessibleDescription(/^Projects on the Free plan have 1 language, the default included\. Upgrade to .* to make more live\.$/);
  await goLive.click();
  const goLivePrompt = owner.getByRole("dialog", { name: /to make more live\.$/ });
  await expect(goLivePrompt).toBeVisible();
  await checkpoint(owner, "settings-languages-go-live-upgrade", { fullPage: false });
  await goLivePrompt.getByRole("button", { name: "Not now" }).click();
  await expect(goLivePrompt).toBeHidden();
  await expect(german).toContainText("Offline");
});

test("adding a language counts the published changelog entries it takes on, translates them, and its row says so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // One published entry, its title this journey's own (the model fake's reply is matched by it).
  const title = `Dark mode ${slug}`;
  await api("/changelog", { title, body: "Switch themes from your profile menu." });
  await api("/changelog/1/publish", {});
  await nextModelReply(JSON.stringify({ segments: { "1": `Dunkler Modus ${slug}`, "2": "Wechsle das Design im Profilmenü." } }), title);

  await owner.goto(`/app/${slug}/settings/languages`);
  const pane = owner.getByRole("region", { name: "Languages" });
  await pane.getByRole("button", { name: "Add language" }).click();
  const add = owner.getByRole("dialog", { name: "Add a language" });
  await expect(add).toContainText("1 published page, shown in English until they're translated");
  await add.getByRole("combobox", { name: "Language" }).click();
  await owner.getByRole("option", { name: "Deutsch (German)" }).click();
  await add.getByRole("button", { name: "Add Deutsch" }).click();
  await expect(add).toBeHidden();
  // Translated in the background: the row says so once it's done.
  const german = pane.getByRole("list", { name: "Other languages" }).getByRole("listitem").filter({ hasText: "Deutsch" });
  await expect(async () => {
    await owner.reload();
    await expect(german).toContainText("German · Automatic · 1 page translated", { timeout: 1000 });
  }).toPass();
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "settings-languages-entries-phone", { fullPage: false });
});

test("an owner edits the glossary: a term's word per language, one never translated, saved after saying which pages it updates; a card per term on phones", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // German and French written by the team: nothing asks the model. A page using Board, with its German.
  await api("/languages", { languages: [{ code: "de", newPages: "manual" }, { code: "fr", newPages: "manual" }] }, "PATCH");
  await api("/glossary", { terms: [{ term: "Board", translations: { de: "Tafel" } }] }, "PATCH");
  const article = await api("/articles", { title: "Boards", body: "Make a Board for ideas." });
  await api(`/articles/${article.slug}/publish`, {});
  await query(
    `INSERT INTO article_translation (id, "articleId", "projectId", language, title, body, automatic, "publishedAt", "updatedAt")
     SELECT gen_random_uuid()::text, a.id, a."projectId", 'de', 'Tafeln', 'Eine Tafel für Ideen.', false, now(), now()
     FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`,
    [slug, article.slug],
  );

  await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.goto(`/app/${slug}/settings/languages/glossary`);
  const pane = owner.getByRole("region", { name: "Glossary" });
  await expect(pane.getByRole("link", { name: "Languages" })).toHaveAttribute("href", `/app/${slug}/settings/languages`);
  const terms = pane.getByRole("list", { name: "Terms" });
  await expect(terms.getByRole("textbox", { name: "Term", exact: true })).toHaveValue("Board");
  await expect(terms.getByRole("textbox", { name: "Board in Deutsch" })).toHaveValue("Tafel");
  await expect(terms.getByRole("textbox", { name: "Board in Français" })).toHaveAttribute("placeholder", "Model decides");
  await expect(pane.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // Board's German changes; Acme is added, never translated.
  await terms.getByRole("textbox", { name: "Board in Deutsch" }).fill("Brett");
  await pane.getByRole("button", { name: "Add term" }).click();
  await expect(terms.getByRole("textbox", { name: "Term", exact: true }).last()).toBeFocused();
  await terms.getByRole("textbox", { name: "Term", exact: true }).last().fill("Acme");
  await terms.getByRole("switch", { name: "Never translated: Acme" }).check();
  // Never translated: no word per language for it.
  await expect(terms.getByRole("textbox", { name: "Acme in Deutsch" })).toHaveCount(0);
  await checkpoint(owner, "glossary", { fullPage: false });

  // Saving asks first: the German page using Board is the team's, so it gets its sections to update. What it asks about is
  // the terms as Save found them: an edit made while it works that out (its request held here) isn't saved with them.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  await owner.route(`**/app/${slug}/settings/languages/glossary`, async (route) => {
    if (route.request().method() === "POST" && posts++ === 0) await held;
    await route.continue();
  });
  await pane.getByRole("button", { name: "Save changes" }).click();
  await terms.getByRole("textbox", { name: "Board in Français" }).fill("Planche");
  release();
  const confirm = owner.getByRole("alertdialog", { name: "Save the glossary?" });
  await expect(confirm).toContainText("To update1 page your team writes");
  await checkpoint(owner, "glossary-confirm", { fullPage: false });
  await confirm.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved the glossary")).toBeVisible();
  await expect(confirm).toBeHidden();
  await owner.unroute(`**/app/${slug}/settings/languages/glossary`);
  // Saved as Save found it: French's "Planche" (typed after) isn't, and is still there to save.
  const saved = (await api("/glossary", undefined, "GET")) as unknown as { terms: { term: string; translations: Record<string, string> }[] };
  expect(saved.terms.find(({ term }) => term === "Board")?.translations).toEqual({ de: "Brett" });
  await expect(pane.getByRole("button", { name: "Save changes" })).toBeEnabled();

  // A change no page uses (French's word for Board: no French page) saves without asking; Enter in a field saves, as Save changes does.
  await terms.getByRole("textbox", { name: "Board in Français" }).fill("Tableau");
  await terms.getByRole("textbox", { name: "Board in Français" }).press("Enter");
  await expect(pane.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await expect(owner.getByRole("alertdialog")).toHaveCount(0);

  // The same term twice is refused, and what's on screen stays.
  await pane.getByRole("button", { name: "Add term" }).click();
  await terms.getByRole("textbox", { name: "Term", exact: true }).last().fill("board");
  await pane.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("“board” is in the glossary twice")).toBeVisible();
  await expect(terms.getByRole("textbox", { name: "Term", exact: true }).last()).toHaveValue("board");
  // Removed: focus goes to the term before it, and there's nothing left to save.
  await terms.getByRole("button", { name: "Remove board", exact: true }).click();
  await expect(terms.getByRole("textbox", { name: "Term", exact: true }).last()).toBeFocused();
  await expect(terms.getByRole("textbox", { name: "Term", exact: true }).last()).toHaveValue("Acme");
  await expect(pane.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // A row with a word but no term isn't dropped quietly: saving it says so.
  await pane.getByRole("button", { name: "Add term" }).click();
  await terms.getByRole("textbox", { name: "this term in Deutsch" }).fill("Tafel");
  await pane.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Write the term first")).toBeVisible();
  await expect(terms.getByRole("textbox", { name: "Term", exact: true }).last()).toBeFocused();
  // Leaving with changes not saved asks first.
  await pane.getByRole("link", { name: "Languages" }).click();
  const leave = owner.getByRole("alertdialog", { name: "Leave without saving?" });
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  await terms.getByRole("button", { name: "Remove this term", exact: true }).click();
  await expect(pane.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // A teammate saves meanwhile (adding Zeta): a save from the list shown here is refused, the edit kept; undone, the
  // teammate's list shows.
  await api("/glossary", { terms: [...saved.terms, { term: "Zeta", translations: { fr: "Zêta" } }] }, "PATCH");
  await terms.getByRole("textbox", { name: "Board in Deutsch" }).fill("Planke");
  await pane.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("The glossary changed since you opened it. Reload to see it, then save again")).toBeVisible();
  await expect(terms.getByRole("textbox", { name: "Board in Deutsch" })).toHaveValue("Planke");
  await expect(terms.getByRole("textbox", { name: "Zeta in Français" })).toHaveCount(0);
  await terms.getByRole("textbox", { name: "Board in Deutsch" }).fill("Brett");
  await expect(terms.getByRole("textbox", { name: "Zeta in Français" })).toHaveValue("Zêta");
  await expect(pane.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // Saved: there after a reload, and as a card per term on a phone.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.reload();
  await expect(terms.getByRole("textbox", { name: "Board in Deutsch" })).toHaveValue("Brett");
  await expect(terms.getByRole("listitem").filter({ has: owner.getByRole("switch", { checked: true }) }).getByRole("textbox", { name: "Term", exact: true })).toHaveValue("Acme");
  await expect(terms.getByText("Deutsch", { exact: true }).first()).toBeVisible();
  await checkpoint(owner, "glossary-phone");
});
