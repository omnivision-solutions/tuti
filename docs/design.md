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
| `soft` / `soft-foreground` | Quiet green emphasis |
| `highlight` / `highlight-foreground` | Things that need the team's attention ("Possible duplicate") |
| `unread` | A dot on what's new to the reader (the widget's Messages and What's new) |
| `muted-foreground` | Secondary text, meta lines, placeholders |
| `secondary`, `accent` | Neutral fills and hover backgrounds |
| `destructive` | Delete, remove, errors |
| `destructive-foreground` | Text on the destructive tint (a destructive badge or button, the picked Breaking tag), dark enough for 4.5:1 at small sizes; a tint under it stays light enough to keep that (a destructive button hovers at 15% in light mode, 25% in dark, also on a dialog's muted footer) |
| `series-1`, `series-2` | Reporting's charts (`DailyChart`): the first series (what went well) blue, the second (what needs the team) orange, a pair colour-blind readers tell apart, checked against the card in light and dark. Never a status's colour |

Post statuses (`PostStatusBadge`, `STATUS_STYLES` the one map of their look):
Open = outline, Under review / Planned / In progress / Closed = secondary,
Completed = solid primary, the only green badge. Beside each badge, its colour
dot (`status-*` tokens, `StatusDot`), a colour of its own so a list of mixed
statuses can be scanned: Open grey, Under review amber, Planned blue, In
progress orange, Completed green, Closed light grey. Where the place already
says the status (a roadmap column, "Recently shipped"), its cards don't repeat
the badge.

Changelog tags (`TagBadge`, `TAG_VARIANTS` the one map): Breaking in the
destructive colour (its text `destructive-foreground`), the rest neutral, the same on the portal, in the widget and
in the team's list; a tag picked in the editor takes its badge's colours.
States that aren't a status (the running draft's "Collecting pull requests")
are neutral (outline), never a status's colour.

People (`Avatar`): their photo, or else their initials in white on one of the
`avatar-*` colours, picked by the first letter (`AvatarFallback`), so a person has
the same colour everywhere; never grey initials. Faces in a row (voters) sit in a
ring of the page's colour and overlap by no more than the ring, so no letter is
cut. A team member uploads their photo on Account → Profile.

Autopilot's posts and articles: a badge for what their updates do (`TargetBadge`,
`kind-*` tokens), small monospaced capitals spaced wide, normal weight, in its colour
(a little dimmer in dark mode, still 4.5:1) at the end of the row, no pill, so a list
can be skimmed: Completing green and In progress orange (the statuses they
move a post to), Updated amber, New green. A pull request is a chip
(`PullRequestChip`): GitHub's mark and "PR #130" in a pill, nothing beside it on a
review (its activity page adds its author's GitHub avatar, login and "merged 1 month
ago"); hovering or clicking it shows its title, who merged it when, a link to it on
GitHub and one to its activity page. A Verify run's fix has a chip of its own in the
same place (`VerifyChip`): a shield and "Verify" in the pill, its popover saying the
commit it checked and when, with a link to the article's Verify panel. A review shows
three chips, then "+N more" (a button, `aria-expanded`), which shows the rest with a
short fade (none with reduced motion); its dot says when one it hides is out of date.
Chips are on a post's or article's review and a pull request's activity page, not in
Autopilot's list.
A pull request's row in Activity keeps a chip per kind of what waits ("1 post to
complete", "2 articles to update": nothing in them has gone out yet; the same
tokens, as text on a 15% fill). How sure Autopilot is stays in the data and decides
what's ticked as a review opens; the app doesn't show it.
Autopilot's list is a tree, as a pull request's activity page shows what it touched:
Feedback (its icon) → each board → its posts, Help center (a stack) → each collection
(its own icon, else a folder) → its articles (a page), an article in no collection right
under Help center; lines join each row to its parent. Boards and collections come in the
order of their first post or article: under To review the most reached first (each one's
too), under Reviewed the latest decided first. Once one is reviewed, the next row down
opens. A row is the list's whole width,
highlighted while it's open beside it, and keeps each post or article to a line or two,
to skim many: its title cut to one (in full on hover, and on its page), its badge at
the end, then when it goes out by itself, if it does. Each is reviewed on its page:
the list picks none to approve at once.

## Type scale

| Role | Classes |
| --- | --- |
| Page title | `PageHeader` (2xl, bold, heading font) |
| Section / card title | `CardTitle` or `h2` (base, semibold) |
| Body | default (`text-base`) or `text-sm` in dense UI |
| Secondary | `text-sm text-muted-foreground` |
| Meta | `text-xs text-muted-foreground`, parts joined with ` · ` |
| Group label | `text-xs font-medium tracking-wide text-muted-foreground uppercase`: the heading of a group inside a list or card (a pull request's activity page's Help center and Feedback) |
| Tree level | `text-sm text-muted-foreground` after its icon, sentence case: a tree's sections and their groups (Autopilot's list: Feedback, Help center, a board, a collection) |

## Layout

- **Admin app** (`/app`): every page lives in the sidebar shell
  (`app/app/layout.tsx`, `components/app-shell.tsx`), content max-w-4xl
  (the team's Roadmap the whole width, for its columns: `data-wide`).
  The top bar stays at the top as the page scrolls; from tablet width up it
  holds the page's title and actions (`PageHeader` puts them there), its
  meta line staying on the page, and it's fixed to the window as they are (so
  the page bouncing at its top can't pull them apart).
  A page of three panes (the sidebar, a column of its own, the page: Settings,
  Reporting, every Docs page with the docs' tree, Autopilot, Customize's sections) takes the whole
  width and folds the sidebar away; every other page has it open. Its column is
  the page's height with a border beside it (`data-slot="pane-layout"`).
  The Inbox folds the sidebar away too: its views (with their counts), the list
  and the open conversation side by side from laptop width up, each scrolling on
  its own under the header (the page itself doesn't; `InboxPanes`); the views always
  the row of tabs above the list, in the same place whether or not a conversation is open
  (they never move as one opens or closes); the list a third
  of the width (22–25rem), the conversation the rest; on phones and
  tablets the list or the conversation, its Back to the list. A row reads in four
  lines at most: who and their company on one (cut short, in full on hover) with
  its age at the right, short ("4m": how long they've waited, or since the latest
  message), the subject and the latest message's first line in two at most, then
  "Needs reply" (the highlight colour, no time in it; not in the Needs reply view, where every row would say it), its number and assignee.
  Needs reply lists who's waited longest first; the other views, the latest message first. A conversation keeps
  its own address (`/inbox/<number>`), the list beside it where it was, its row
  marked; J and K open the next and the previous one. Until one opens, the pane
  beside the list has the Inbox's numbers (`StatTile`, as Home's): who's waiting
  for a reply and the longest wait (the Needs reply tab's count, opening it), the
  usual first reply (the widget's, "Not enough yet" before five answers) and the
  week's new conversations (those two without sample content), with "Open a conversation to
  reply here" under them (an empty Inbox: that new ones show up here, said
  there rather than in the list's empty state too). On phones the list is alone.
  A conversation opens at its newest message, its reply box at
  the bottom of the screen as the messages scroll under it, however many there are.
  Beside it, the posts it's linked to (a card of its own, "Link post…" in it), then the
  person (a sheet where the conversation's pane is narrow, the linked posts staying in it); a post's
  sidebar lists its linked conversations. A changelog entry's editor has a sidebar
  beside the text (under it on phones): its tags as chips, the posts it completes
  ("Link post…"), its cover image, how it's announced (Email subscribers, Mark it new: picked
  there, so Publish only confirms; published, what happened and how many people were told),
  "View as reader"; Save sits with Publish in the top bar (at the bottom of the screen on phones),
  and on phones the title shows once, the one to edit. The cover shows under the title in the
  text's column, as readers see it. One way into AI: while the text is still the pull requests'
  titles, the top bar's Draft with AI (the main action); once it's written, Edit with AI's menu
  over the text, Draft with AI in it.
  Autopilot's column is what it updates, under To review (updates waiting for the
  team or going out by themselves) and Reviewed, each in two sections, Feedback (posts
  on every board) then Help center (articles, and new articles' drafts), the ones that
  reach the most people first; and Activity, every merged pull request (those with
  nothing to do folded away at the end, To review pointing to those not read yet).
  The post or article picked opens beside it (`/autopilot/feedback/<id>`,
  `/autopilot/articles/<id>`): its pull requests' chips, then its updates from each;
  once nothing of it waits, the next one to review opens by itself. A post's update is one
  card (one status change with one comment, Edit for the comment) with each pull request's part
  under it, each with its own Dismiss; a link is a card of its own beside it. An article's is
  one view of the whole article, like its editor (`ArticleChangesView`): above it what
  changed (each pull request's part is in its chip's popover: why, what became of it, and
  Dismiss, Write it again or Undo; a chip whose edit is out of date has an amber dot, and
  once one of them went, focus is on the chip row), then
  the article as readers see it, a segmented Changes and Article at the top (Changes:
  every waiting change inline, removed blocks struck out in the destructive tint, added
  ones in `soft`; Article: the new text alone) with "Change 1 of N" and up and down,
  the change stepped to outlined; one Approve (publishes it, asking first) and Dismiss in
  a bar at the bottom. A new article's draft is the same view, all of it added. In the article's
  editor, a save refused because the article changed since it opened (Autopilot's
  edit to the same part, or a teammate's save) keeps what was typed and shows the
  newest version beside it, to merge by hand; the next Save goes on top of it.
  An article's editor has Verify beside History in "More actions": a panel from the
  right (`?verify`, as History is `?history`) with Verify and what it sends where, then
  each run, newest first (its commit, what's still true, out of date and can't tell, its
  fix and what became of it, what it found per statement folded away). Docs' home has Verify all
  in its "More actions": a dialog saying what it will cost first (credits, or how many AI
  runs), then, started or opened again while it runs, how far it's got ("Checked 3 of 12
  articles", a bar) and at the end what it found, with Review in Autopilot. Its fix is a part of
  the article's review like a pull request's, named Verify. A pull request's
  activity page (`/autopilot/activity/<id>`) has its chip, what changed for users,
  "Why Autopilot made this change" folded away, and what it touched as a tree (Help
  center → collection → article, then Feedback), each opening its review. On phones
  and tablets it's the list right under the page's title, then the page picked.
  Users' tables take the whole width, the sidebar open (`data-wide` on the table's
  card): who (name, email, and their id from tablet width up), the properties the team
  picks, headed by the team's name for each or the key in words ("plan_name": "Plan
  name"), their groups in a column, then what they did. A person's page is the whole
  width too: their profile (avatar, their name as its heading, email, id, groups,
  properties) beside all their posts, votes and conversations, each status a badge
  (one column on phones, where the page's title is their name and the profile has no heading of its own).
  A page with sections of its own lists them under its header with `SubNav`
  (Users' People and Companies).
  Tabs come in two styles. Switching a page's views or sections (Feedback's
  statuses, Changelog, Users, the Inbox's views, Reporting's AI conversations) is
  underline tabs, `SubNav`; switching a control's mode (the reply
  box's Reply and Note, a docs tab's Content, Access and Settings) is a segmented
  `Tabs` (Autopilot's To review and Reviewed are still segmented till its
redesign). Filters are chips, not tabs (the portal changelog's). A row of tabs
  never wraps: too narrow, it scrolls sideways, with the active tab scrolled
  into view, faded at the end that has more (`useScrollingRow`; the portal's
  parts and their rows too). Settings has one menu of its own on the left, in groups
  (`SettingsMenu`: Project, Users, Support, AI, Connections, Billing; folded into
  one button above the page on phones); it opens on General. Reporting has one
  too (`SettingsMenu` with `label`: Docs, AI support, Inbox), each page its numbers
  (`Stat`, a labelled group), a chart by day (`DailyChart`: a day's numbers on hover,
  every day's in a table under "Show the numbers") and the lists behind them; its
  heading (`ReportHeading`) says only the days it covers, never a sentence. The Docs home shows every tab
  with its collections as cards (each with its articles, then the collections
  in it). Every Docs page (the home too) has the docs as a tree
  in a column of its own beside it (`DocsWorkspace`; a "Browse docs" menu
  above it on phones); ⌘K finds articles and collections by name; a tab's page has Content, Access and
  Settings tabs; a collection's page lists what's in it, and its Settings
  button opens one page with its details and who can read it, saved by one Save. Beside the tree the sidebar is folded away.
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
  status above the title, the vote button on the right; a completed idea's votes
  as text, with no button, here and on the roadmap), under Trending, Top
  and New tabs with a search box beside them (it filters the board), and Mine
  for a signed-in visitor who may post. On wide screens a board's page is
  max-w-5xl with a sidebar beside the list: the boards with their counts (the
  part's row is there instead), Recently shipped and Get updates (the shipped
  emails, the changelog by email, its page and feed); on phones
  there's no sidebar, and Recently shipped is under the list. The changelog's
  list has its tags as chips under the header (links, `?tag=`, only the tags
  its entries have); on wide screens it's max-w-5xl, each entry's date in a
  margin left of it (above the title on phones) and, past eight entries, a
  sticky month index beside it (each month with its count, opening the page
  its newest entry is on); on phones the header's menu lists the entries instead. Docs has
  one box for searching and asking, the header's ("Search or ask AI" with AI
  answers on; below tablet width a line of its own, the whole width; no
  separate AI button beside it), and searching the docs never happens in the box itself:
  it opens the search dialog (`DocsSearchBox`), where "Ask AI" hands the
  question to the assistant, and before anything's typed "Open the assistant"
  goes back to the conversation as it was. Its results page says what it's
  for ("Results for “invoice”"), the first tab marked, as the tree beside it is
  that tab's. Popular articles on a tab's overview are that tab's, and only
  with three or more. On phones and
  tablets the header's menu button (`PortalMenu`) opens a full-screen menu with
  the current part's navigation (the docs' tree, the boards) and the team's
  links and contact button, which the header shows only from tablet width. The header and the part's row stay at the top as
  the page scrolls, phones included (`PortalTop`; their height is `--portal-header-height`).
  Docs pages take the whole width (`DocsLayout`): the tab's tree on the left
  (not beside a tab's overview, whose cards are its collections: there the
  team's sidebar links alone, if it has some)
  with a line beside it running the page's height (on a short page too), scrolling on its own, each name on one line, cut
  short with "…" (a "Browse docs" menu on phones), the page at max-w-3xl
  with the footer under it (not under the tree, which it would push up), and an article's "On this page" on the right on wide screens
  (the section being read marked), with "Was this helpful?" under it (under the
  article where it's not shown, phones included). Above an article's or a
  collection's title, the level above in the accent colour: its collection,
  else its tab (with two or more) or "All collections". Articles use `article-text` on top of
  `rich-text`: bigger headings, softer body text, room between steps;
  their search box is in the header. A tab's overview shows its collections
  once: its own Popular articles first (three or more), then a card per collection
  (icon, name, description, how many articles the reader may open; three per
  row on wide screens, one on phones). A collection's page: its icon and name, a card of its
  articles (rows with a chevron), then a card per collection in it (its name,
  its articles, and the collections in that as folders opening their pages).
- **Widget panel** (`/widget` on the portal, framed on customers' sites): a
  header in the project's colour (a gradient shading it away from the text
  on it, black or white, so that reads everywhere) with the tab's name and Close, the tab scrolling under
  it, the tabs with icons at the bottom and "Powered by tuti" under them. On
  Home the header holds the greeting too ("Hi <first name>" for someone the page
  signs in), then help first (the docs search box, with three suggested articles
  as rows under it), "Send us a message" (the team's faces and when they usually
  reply), "Your ideas" (status news, each a row with its status's dot) for someone
  signed in, then Feedback, the latest update ("2 new" when some are unread) and the quick links.
  What's new is a card per update (cover, date and tags, title, two lines, Read more
  opening it in the panel), unread ones with the orange dot Messages uses.
  It grows out of the launcher's corner as it opens (a sidebar slides in from
  its edge) and shrinks back as it closes; with reduced motion it just appears.
  On screens up to 640px wide the floating panel takes the whole screen, over the
  launcher, kept clear of the phone's status bar and home indicator, and slides up.
  Messages has the team on top (their faces and when they usually reply, as on
  Home), then their conversations, newest first, each with its latest line ("You:"
  before theirs) and "Closed", "Replied" or "Waiting for a reply"; while it loads,
  a skeleton of that list, never "Loading…" (screen readers are told), and if it
  can't load, the error with Try again.
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
  `titleOnPage` is for a page about one thing (a post): its title stays on
  the page as its heading at every width, the top bar showing it too.
  Actions sit right on wide screens and under the title on phones; in the
  app from tablet width up, title and actions go in the top bar, and on phones
  the actions are a "More actions" menu from it (`PageActions`). A page whose
  every visit needs them (a conversation's Assign, Snooze and Close) shows them
  in a row under its header on phones as well, still in the menu (in reach once
  the row has scrolled away). An editor whose
  main action must stay in reach on phones (Save and Publish) pins `actions` to a
  bar at the bottom of the screen there (`pinActions`), the menu keeping `more`;
  the bar steps aside while text is being typed (the keyboard is up then).
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
    done to many at once, each tinted green while it is (`ItemRow picked`; more
    strongly when it's also the open one; on any highlighted row the meta line
    is `text-foreground/70`, as the grey falls under 4.5:1 there); a
    bar in the filters' place says how many and offers it (Feedback: Set
    status, Move to board, Merge…, Clear). Bar and filters share one grid cell,
    the filters `invisible` and `inert` while the bar shows, so the cell keeps
    the taller one's height and the list doesn't move. In a
    narrow list column (a phone, or a post open beside it; a container query on
    the column, not the window) it stays one row with shorter words (Status,
    Board, an × for Clear; the full names for screen readers); narrower still,
    the count stays whole and the actions scroll sideways, faded at the end
    that has more; a mouse's wheel scrolls them, and a button tabbed to comes
    clear of the fade (`showMore`, `FADE_AT_MORE`, `wheelSideways`,
    `focusClearOfFade`, as `SubNav`'s tabs). The bar's buttons
    keep focus while an action runs (`focusableWhenDisabled`); when the bar goes
    away (the action done, Clear), focus moves to the first filter. Each is done as it is
    for one; what fails is said, the rest still go. What emails people
    (Completed) or can't be undone (Merge) asks first, naming how many.
  - A list of one status (a Feedback tab) doesn't repeat it on every row: the
    status menu opens from a small button instead (`PostStatusMenu badge={false}`).
  - A post's vote count, first in its row, has the vote arrow over it (and
    "votes" for screen readers), so it doesn't read as a bare number (`VoteCount`).
  - Compact actions (a badge, one or two small buttons) stay on the right.
  - Pickers or several buttons → `wideActions`: on phones they move under the
    title and share the row width. Give select triggers `w-full sm:w-…`.
  - A card listing several kinds of thing (Home's "Needs your attention")
    groups them by kind, the most urgent first: each a heading with how many,
    its first few rows, the longest waiting first (or, where its list shows only the top few, as that list ranks them), and a link to that list ("See all" when it holds them all, else named for where it goes); no kind badge per row.
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
- **`CopyField`**: a value the team pastes elsewhere (a script tag, a DNS
  record) in a muted box with "Copy", never bare code.
- **`ColorField`**: a colour is the browser's swatch with its hex beside it,
  kept in step, so a brand colour can be typed exactly.
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
  A section's create button in its header is that primary ("New entry", "Add
  content", "New post") unless an open item beside it has its own: then it's
  outline. "View on portal" beside it is an outline button in words, not a bare icon.
- A settings page saves one way: a switch or a select saves as it's changed;
  fields share one primary Save; adding to a list beside its fields (Send
  invite, Create key, Add webhook, Add redirect, Add readers) is an outline
  button.
- Anything that can't be undone (delete, merge, remove) asks first in an
  `AlertDialog` that says what will happen.
- Feedback for actions goes in a toast (`sonner`): short and in the past tense
  ("Merged into #12", "Status: Planned").
- Disable buttons while their action runs.
- A setting left empty offers the obvious pick in one click (Who's asking's
  "Use Seats"); it isn't picked for the team.
- Users' properties show in words until the team names them: the key in
  sentence case (`company_size` is Company size, `mrr` MRR), a number as a
  number unless its key says it's an id, a time, a year, a zip code or a
  phone number (`propertyLabel`, `formatProperty`, `isAmount`).

## Copy

- Plain, short, friendly. Sentence case everywhere ("Possible duplicates",
  not "Possible Duplicates").
- Say "project", "board", "post", "team" (the customer's staff) and "users"
  (people on a portal). Avoid "workspace", "members" and "tickets".
- What users ask for is "a post" one at a time and "Feedback" all together
  (the area, a heading, a count across boards); never "requests" or "feature
  requests" in the team's words. A board's own name is the team's to pick
  (the default is "Feature requests"), and the portal may invite its users to
  "Share an idea".
- Name the thing: "Merge into #12", not "Confirm".
