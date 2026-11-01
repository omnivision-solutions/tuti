# Design system

Tuti's look ("Parrot") and the rules for building screens. See every pattern
live, in light and dark, at **`/design`** (dev only, e.g. https://dev.tuti.so/design).
Check new UI there and at phone width (390px) before shipping it.

## Brand

*Tuti* is Persian for parrot. The brand is friendly and a bit playful, never
cute at the expense of clarity.

- **Colour:** leafy green primary, a beak-orange highlight, warm paper
  neutrals. Dark mode uses a brighter green with dark text on it.
- **Type:** Figtree for text, Bricolage Grotesque for headings (`h1`–`h3` and
  `font-heading` pick it up automatically). Every font, these and the portals'
  16, is a file in `apps/web/src/fonts` (`node scripts/fetch-fonts.mjs` fetches
  them, with their licences), loaded with `next/font/local`: builds never
  download fonts.
- **Mark:** the parrot (`TutiMark`, `TutiLogo` in `components/tuti-logo.tsx`;
  favicon `app/icon.svg`). The current drawing is a placeholder until we have
  a proper illustration.
- **Corners:** `--radius` 0.625rem → cards 14px (`rounded-xl`), controls 10px.

## Tokens

All colours are CSS variables in `apps/web/src/app/globals.css` (`:root`/`.light`
and `.dark`), used through Tailwind (`bg-primary`, `text-muted-foreground`, …).
Never hard-code a colour in a component; add a token if one is missing.

| Token | Use for |
| --- | --- |
| `primary` | The one main action on a screen, votes you've cast, active tab, links that need emphasis |
| `soft` / `soft-foreground` | Quiet green emphasis: statuses in progress (Planned, In progress) |
| `highlight` / `highlight-foreground` | Things that need the team's attention ("Possible duplicate") |
| `muted-foreground` | Secondary text, meta lines, placeholders |
| `secondary`, `accent` | Neutral fills and hover backgrounds |
| `destructive` | Delete, remove, errors |

Post statuses (`PostStatusBadge`): Open = outline, Under review = secondary,
Planned / In progress = soft, Completed = solid primary, Closed = secondary.
Beside each badge, its colour dot (`status-*` tokens, `StatusDot`), so a list
of mixed statuses can be scanned: Open grey, Under review amber, Planned dark
green, In progress orange, Completed green, Closed light grey.

Autopilot's updates: a chip per kind (`kind-*` tokens, the text, and the same at
15% as its fill), so a list of changes can be skimmed: a request closed green,
updated blue, an article update violet, a new article pink; links and the
changelog line grey. How sure Autopilot is (`ConfidenceRing`): green when
likely, orange when not sure, red under 60%.
Autopilot's list keeps each change to two lines, to skim many: its title cut to
one (in full on hover, and on its page) and its chips cut short when they don't fit.

## Type scale

| Role | Classes |
| --- | --- |
| Page title | `PageHeader` (2xl, bold, heading font) |
| Section / card title | `CardTitle` or `h2` (base, semibold) |
| Body | default (`text-base`) or `text-sm` in dense UI |
| Secondary | `text-sm text-muted-foreground` |
| Meta | `text-xs text-muted-foreground`, parts joined with ` · ` |

## Layout

- **Admin app** (`/app`): every page lives in the sidebar shell
  (`app/app/layout.tsx`, `components/app-shell.tsx`), content max-w-4xl.
  The top bar stays at the top as the page scrolls; from tablet width up it
  holds the page's title and actions (`PageHeader` puts them there), its
  meta line staying on the page, and it's fixed to the window as they are (so
  the page bouncing at its top can't pull them apart).
  A page of three panes (the sidebar, a column of its own, the page: Settings,
  a docs tab, collection or article, Autopilot, Customize's sections) takes the whole
  width and folds the sidebar away; every other page has it open. Its column is
  the page's height with a border beside it (`data-slot="pane-layout"`).
  A conversation's page (Inbox) opens at its newest message, its reply box at
  the bottom of the screen as the messages scroll under it, however many there are.
  Beside it, the posts it's linked to (a card of its own, "Link post…" in it), then the
  person (a sheet on phones, where the linked posts stay on the page); a post's
  sidebar lists its linked conversations. A changelog entry's editor has a sidebar
  beside the text (under it on phones): its tags as chips, the posts it completes
  ("Link post…"; published, how many people were told), its cover image, "View as reader";
  Save sits with Publish in the top bar.
  Autopilot's column is its changes, under To review (updates waiting, being read,
  failed or paused) and Reviewed (those with nothing to do folded away at the end);
  the change picked opens beside it, and once nothing of it waits, the next one to
  review opens by itself. On phones and tablets it's the list, then the change's page.
  A page with sections of its own lists them under its header with `SubNav`
  (Inbox's views, Users' People and Companies). Settings has one menu of its own on the left, in groups
  (`SettingsMenu`: Project, Support, AI, Connections, Billing; folded into
  one button above the page on phones). The Docs home shows every tab
  with its collections as cards (each with its articles, then the collections
  in it). A tab's, a collection's or an article's page has the docs as a tree
  in a column of its own beside it (`DocsWorkspace`; a "Browse docs" menu
  above it on phones); ⌘K finds articles and collections by name; a tab's page has Content, Access and
  Settings tabs; a collection's page lists what's in it, and its Settings
  button opens one page with its details and who can read it. Beside the tree the sidebar is folded away (the docs' home,
  Insights and a new article show it all themselves, with the sidebar open).
- **Customize** (`/app/<project>/customize/<section>`): the whole width, the
  sidebar folded away. `CustomizeShell`: Customize's sections in a rail on
  the far left (a menu above the panel on smaller screens; no index page, no
  Back), the section's settings in a panel beside it (title; cards inside),
  the portal it changes on the right in a browser frame, at desktop or phone
  width, light or dark. Settings that
  change how the portal looks go here, not in Settings. A section's forms use
  `useCustomizeForm`: "Save changes" in the panel's header saves every one with
  a change (enabled once something changed), and `toDraft` shows a change in the frame as it's made
  (the portal's `PortalLookProvider` takes it); leaving with changes not saved
  asks first.
- **Portals**: header with the project name and the four parts (Feedback,
  Roadmap, Changelog, Docs; `components/portal-nav.tsx`), under it the current
  part's row (boards, docs tabs) when it has two or more, content max-w-3xl
  (the Roadmap max-w-6xl, about 1100px, for its three columns, which stack on
  phones), "Powered by tuti" footer. A board lists its posts as rows in one card (the
  status above the title, the vote button on the right), under Trending, Top
  and New tabs with a search box beside them (it filters the board). Searching the docs never happens in the box itself: the
  header's search (an icon on phones, a box from tablet width) and the docs'
  big box all open the same search dialog (`DocsSearchBox`). On phones and
  tablets the header's menu button (`PortalMenu`) opens a full-screen menu with
  the current part's navigation (the docs' tree, the boards) and the team's
  links and contact button, which the header shows only from tablet width. The header and the part's row stay at the top as
  the page scrolls, phones included (`PortalTop`; their height is `--portal-header-height`).
  Docs pages take the whole width (`DocsLayout`): the tab's tree on the left
  with a line beside it, scrolling on its own, each name on one line, cut
  short with "…" (a "Browse docs" menu on phones), the page at max-w-3xl
  with the footer under it (not under the tree, which it would push up), and an article's "On this page" on the right on wide screens
  (the section being read marked), with "Was this helpful?" under it (under the
  article where it's not shown, phones included). Above an article's or a
  collection's title, the level above in the accent colour: its collection,
  else its tab (with two or more) or "All collections". Articles use `article-text` on top of
  `rich-text`: bigger headings, softer body text, room between steps;
  their search box is in the header. A tab's overview has a large search box
  too, then a card per collection (icon, name, description; three per row
  on wide screens, one on phones). A collection's page: its icon and name, a card of its
  articles (rows with a chevron), then a card per collection in it (its name,
  its articles, and the collections in that as folders opening their pages).
- **Widget panel** (`/widget` on the portal, framed on customers' sites): a
  header in the project's colour (a gradient shading it away from the text
  on it, black or white, so that reads everywhere) with the tab's name and Close, the tab scrolling under
  it, the tabs with icons at the bottom and "Powered by tuti" under them. On
  Home the header holds the greeting too, then a card for each part the project
  has (Messages, a docs search box, Feedback, the latest update) and the quick links.
  It grows out of the launcher's corner as it opens (a sidebar slides in from
  its edge) and shrinks back as it closes; with reduced motion it just appears.
  On screens up to 640px wide the floating panel takes the whole screen, over the
  launcher, kept clear of the phone's status bar and home indicator, and slides up.
  A conversation in Messages opens at its newest message, its reply box at the
  bottom of the panel as the messages scroll under it.
- Both layouts stack page sections with `gap-6`; don't add margins between them.

## Components

Use these instead of hand-rolling layout:

- **`PageHeader`** (`title`, `meta`, `actions`, `more`): the top of every page;
  no sentence under the title in the app: what a page is for goes in its
  empty state, or a tooltip. `meta` is facts about the thing shown ("#12 ·
  Ada · 3 votes"); `description` is for portals, where it's the team's own words.
  `more` is the actions used less often, behind the top bar's "More actions".
  Actions sit right on wide screens and under the title on phones; in the
  app from tablet width up, title and actions go in the top bar, and on phones
  the actions are a "More actions" menu from it (`PageActions`).
- **`BackLink`**: "← Feedback" above a detail page's header; in the app it's
  `PageHeader`'s `back`, before the title in the top bar.
- **`ItemList` + `ItemRow`** (`leading`, `title`, `badges`, `meta`, `actions`):
  every list of things (posts, boards, team, invites, suggestions), usually in
  a `Card`. Titles wrap, never get cut off.
  - A list is read first: a row shows values, changed on click (a badge that
    opens a menu, like `PostStatusMenu`), in a preview pane or in bulk; no
    form controls (selects, checkboxes for settings) in rows, on phones too.
  - A list that's triaged (Feedback) opens a row in a pane beside it, the whole
    width: `?post=<number>` in the address (shareable, Back works), the list
    left as it was, the open row highlighted out to its card's edges
    (`ItemRow selected`). The pane holds what triage needs (description, properties,
    voters, a reply) and "Open full page" for the rest; J and K step through
    the list in it, Esc closes it (`pageShortcut`: not while typing, nor with a
    dialog or menu open). On a phone the pane takes the list's place, its
    arrow back to the list.
  - Rows can be picked (a checkbox before the row, "Select <title>") for what's
    done to many at once; a bar over the list says how many and offers it
    (Feedback: Set status, Move to board, Merge…, Clear). Each is done as it is
    for one; what fails is said, the rest still go. What emails people
    (Completed) or can't be undone (Merge) asks first, naming how many.
  - Compact actions (a badge, one or two small buttons) stay on the right.
  - Pickers or several buttons → `wideActions`: on phones they move under the
    title and share the row width. Give select triggers `w-full sm:w-…`.
- A list compared across columns (Users) is a table in a `Card`: its headings
  sort it (a link each, `aria-sort` on the one in use, the most first), and on
  phones it keeps who and the column that matters most (Last seen), the rest
  from tablet width up. Which properties it shows is the team's pick
  (Columns), kept for everyone.
- **`EmptyState`**: what a list shows when it's empty. Say what's missing and
  what to do next; add an `action` when there's an obvious one.
- **`Card`** with `CardHeader`/`CardTitle`/`CardDescription`: a settings section
  or form. One topic per card.
- **`RichEditor bare`**: long writing (docs articles, changelog entries, new
  posts) is written as it's published: no box and no toolbar; the title above
  it is a borderless `BARE_TITLE` input set like the published heading. Blocks
  come from a menu that typing / at the start of a line opens (the empty line
  being written says so), formatting from a bar over selected text (and
  Ctrl/⌘+K for a link). Comments keep the boxed editor with its toolbar.
- shadcn/ui primitives (Base UI) in `components/ui/*`. For navigation styled
  as a button use `<Link className={buttonVariants(...)}>`, not
  `<Button render={<Link />}>` (that adds `role="button"`).

## Responsive rules

- Design for 390px first; nothing may overflow or squeeze text to nothing.
- In a row, text gets the space and controls move below it on phones
  (`ItemRow wideActions`), never the other way round.
- Long user content (titles, emails, URLs) wraps (`break-words` / `break-all`;
  `wrap-anywhere` where it sits in a grid that sizes to it, such as a dialog's
  title, which `break-words` doesn't shrink).
- Filters wrap onto more lines; they don't scroll sideways.

## Interaction

- One primary button per screen or dialog, on the right; Cancel to its left.
- Anything that can't be undone (delete, merge, remove) asks first in an
  `AlertDialog` that says what will happen.
- Feedback for actions goes in a toast (`sonner`): short and in the past tense
  ("Merged into #12", "Status: Planned").
- Disable buttons while their action runs.

## Copy

- Plain, short, friendly. Sentence case everywhere ("Possible duplicates",
  not "Possible Duplicates").
- Say "project", "board", "post", "team" (the customer's staff) and "users"
  (people on a portal). Avoid "workspace", "members" and "tickets".
- Name the thing: "Merge into #12", not "Confirm".
