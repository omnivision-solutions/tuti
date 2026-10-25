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
  description staying on the page.
  A page with sections of its own lists them under its header with `SubNav`
  (Settings → Access, Single sign-on, …). The Docs home shows every tab
  with its collections as cards (each with its articles, then the collections
  in it). A tab's, a collection's or an article's page has the docs as a tree
  in a column of its own beside it (`DocsWorkspace`; a "Browse docs" menu
  above it on phones). "Filter by title" (`DocsFilter`) is in the top bar and
  filters the tree and the home alike; a tab's or a collection's page has Content, Access and
  Settings tabs. On Docs pages the sidebar is folded
  away, as on Customize's.
- **Customize** (`/app/<project>/customize/<section>`): the whole width, the
  sidebar folded away. `CustomizeShell`: the section's settings in a panel on
  the left (back, title; cards inside), the portal it changes on the right in
  a browser frame, at desktop or phone width, light or dark. Settings that
  change how the portal looks go here, not in Settings. A section's form uses
  `useCustomizeForm`: "Save changes" in the panel's header (enabled once
  something changed), and `toDraft` shows a change in the frame as it's made
  (the portal's `PortalLookProvider` takes it); leaving with changes not saved
  asks first.
- **Portals**: header with the project name and the four parts (Feedback,
  Roadmap, Changelog, Docs; `components/portal-nav.tsx`), under it the current
  part's row (boards, docs tabs) when it has two or more, content max-w-3xl,
  "Powered by tuti" footer. Searching never happens in the box itself: the
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
  (the section being read marked). Articles use `article-text` on top of
  `rich-text`: bigger headings, softer body text, room between steps;
  their search box is in the header. A tab's overview has a large search box
  too, then a card per collection (icon, name, description; three per row
  on wide screens, one on phones). A collection's page: its icon and name, a card of its
  articles (rows with a chevron), then a card per collection in it (its name,
  its articles, and the collections in that as folders opening their pages).
- Both layouts stack page sections with `gap-6`; don't add margins between them.

## Components

Use these instead of hand-rolling layout:

- **`PageHeader`** (`title`, `description`, `actions`): the top of every page.
  Actions sit right on wide screens and under the title on phones; in the
  app from tablet width up, title and actions go in the top bar, and on phones
  the actions are a "More actions" menu from it (`PageActions`).
- **`BackLink`**: "← Feedback" above a detail page's header; in the app it's
  `PageHeader`'s `back`, before the title in the top bar.
- **`ItemList` + `ItemRow`** (`leading`, `title`, `badges`, `meta`, `actions`):
  every list of things (posts, boards, team, invites, suggestions), usually in
  a `Card`. Titles wrap, never get cut off.
  - Compact actions (a badge, one or two small buttons) stay on the right.
  - Pickers or several buttons → `wideActions`: on phones they move under the
    title and share the row width. Give select triggers `w-full sm:w-…`.
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
- Long user content (titles, emails, URLs) wraps (`break-words` / `break-all`).
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
