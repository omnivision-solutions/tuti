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
  `font-heading` pick it up automatically).
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
  (`app/app/layout.tsx`), content max-w-4xl.
- **Portals**: header with the project name and the four parts (Feedback,
  Roadmap, Changelog, Docs; `components/portal-nav.tsx`), under it the current
  part's row (boards, docs tabs) when it has two or more, content max-w-3xl,
  "Powered by tuti" footer.
- Both layouts stack page sections with `gap-6`; don't add margins between them.

## Components

Use these instead of hand-rolling layout:

- **`PageHeader`** (`title`, `description`, `actions`): the top of every page.
  Actions sit right on wide screens and under the title on phones.
- **`BackLink`**: "← Feedback" above a detail page's header.
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
