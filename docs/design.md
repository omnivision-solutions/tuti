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
  download fonts. A symbol none of them has, nor their fallback (the device's Arial, which
  has the common arrows and math signs), comes from a cut-down Noto Sans Math after them
  ("⋯", ✓; `--font-symbols`, also `next/font/local`), never an empty box.
- **Mark:** the parrot (`TutiMark`, `TutiLogo` in `components/tuti-logo.tsx`;
  favicon `app/icon.svg`). The current drawing is a placeholder until we have
  a proper illustration.
- **Corners:** `--radius` 0.5rem → controls (buttons, inputs, selects) 8px (`rounded-lg`), cards and tiles
  ~11px (`rounded-xl`), pills fully round. Nothing else.
- **Controls:** 36px tall (`h-9`: `Button`, `Input`, `SelectTrigger`), 32px in dense rows (`size="sm"`).
  Fields (`Input`, `Textarea`, `SelectTrigger`) sit on the card's colour in light (white) and on the
  page's in dark (a step below the card), with the `input` border, their placeholder lighter than a value; a textarea grows with its text and has no resize grip. A card's footer (`CardFooter`) is a
  line above its buttons, never a grey band. The primary
  button is flat: one fill, its border the same colour, a soft shadow; no bevel or edge.
- **Surfaces:** a ladder: the sidebar (a step darker than the page in light), the page (`background`, a soft
  cream), cards on it (`card`: white in light, a step lighter than the page in dark)
  with a `border` ring and a soft shadow (`Card`, `StatTile`), never a card without its edge.

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
| `muted-foreground` | Secondary text, meta lines, placeholders: 4.5:1 or more on the page, a card, the sidebar and a muted fill, in light and dark (`colours.test.ts`) |
| `border`, `input` | A card's or divider's edge (1.25:1 on the page), an input's (1.5:1) |
| `sidebar-active` / `sidebar-active-foreground` | The page open in a page's own menu (`SettingsMenu`: Settings', Reporting's): a pale green pill, its label and icon green (4.5:1). The sidebar's open page is a raised neutral pill (the card's colour, a `sidebar-border` ring), so a page with both shows one green |
| `secondary`, `accent` | Neutral fills and hover backgrounds |
| `destructive` | Delete, remove, errors |
| `destructive-foreground` | Text on the destructive tint (a destructive badge or button, the picked Breaking tag), dark enough for 4.5:1 at small sizes; a tint under it stays light enough to keep that (a destructive button hovers at 15% in light mode, 25% in dark, also on a dialog's muted footer) |
| `series-1`, `series-2` | Reporting's charts (`DailyChart`): the first series (what went well) the brand's green, the second (what needs the team) orange, a lightness step (≥0.15) apart so colour-blind readers tell them apart (`colours.test.ts`), checked against the card in light and dark; a period still under way (today, the month so far) a dashed outline in its colour around a light fill of it, said "so far". Never a status's colour |

Post statuses (`PostStatusBadge`, `STATUS_STYLES` the one map of their look): one
tinted pill, sentence case, its colour dot inside it, the text the foreground's, the
fill a light tint of the status's colour (`status-*` tokens, `StatusDot`), a colour of
its own so a list of mixed statuses can be scanned: Open grey, Under review amber,
Planned violet, In progress blue, Completed green, Closed light grey. Orange (the
highlight) is kept for what needs the team; no status uses it. Any other
state shown as a pill (a conversation's, a check's) follows the same shape: a tint, a
dot, sentence case; never solid fills, never spaced capitals. Where the place already
says the status (a roadmap column, "Recently shipped"), its cards don't repeat
the badge.

Changelog tags (`TagBadge`, `TAG_VARIANTS` the one map): Breaking in the
destructive colour (its text `destructive-foreground`), the rest neutral, the same in the widget and
in the team's list; a tag picked in the editor takes its badge's colours. On the portal's own changelog pages
(`ChangelogEntryView`'s `TAG_TINTS`) New, Improved and Fixed are tinted by kind (green, blue, amber) so a list can be
scanned; Breaking keeps its destructive look.
States that aren't a status (the running draft's "Collecting pull requests")
are neutral (outline), never a status's colour.

People (`Avatar`): their photo, or else their initials in white on one of the
muted `avatar-*` colours (low chroma, so a list of faces isn't a rainbow beside the green), picked by the first letter (`AvatarFallback`), so a person has
the same colour everywhere; never grey initials. Faces in a row (voters) sit in a
ring of the page's colour and overlap by no more than the ring, so no letter is
cut. A team member uploads their photo on Account → Profile.

Autopilot's posts and articles: a badge for what their updates do (`TargetBadge`,
`kind-*` tokens), a status pill (sentence case, its text in its colour on a light tint
of it, 4.5:1) at the end of the row, so a list
can be skimmed: Completing green and In progress blue (the statuses they
move a post to), Updated amber, New green. Under Reviewed the badge says what became of it, in the past
tense: Completed green, In progress blue, Published amber, Drafted green, Linked, Dismissed and Undone grey; under
the title, who decided it and when ("Approved by Olive · 2h", "Published by Autopilot · 3h"). Its page opens on the
same (`Outcome`, "What happened"): the outcome, who and when, what went out (how many people completing it emailed,
the team's comment) or why it was dismissed, then Undo while it can be put back and Open the post or article; a
published article's Changes keep what its edits changed.
While a post's update waits, its review shows what's needed to decide: "What they asked" (a group label; the
description's first lines quoted, the voters' faces with the first names and how many more, its Inbox conversations
linked), and, under the status card in the highlight colour, the same pull request's other updates still waiting ("Also
from PR #221: Change the theme (waits)", and when completing the post emails people and the other is an article edit,
"Publish it first, so the email points people to docs that say how."); an article's chip popover names them too.
Completing a post takes an optional comment of the team's, sent with the completion email and posted on the post. A pull request is a chip
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
too), under Reviewed the latest decided first. From laptop width up To review opens its first
beside it (Reviewed and Activity say what their rows open), and once one is reviewed, the next row down
opens. A row is the list's whole width,
highlighted while it's open beside it, and keeps each post or article to a line or two,
to skim many: its title cut to one (in full on hover, and on its page), its badge at
the end, then when it goes out by itself, if it does (or who stopped it). Each is reviewed on its page:
the list picks none to approve at once.

## Type scale

| Role | Classes |
| --- | --- |
| Page title | `PageHeader`'s `h1` (heading font, semibold, tracked -0.02em, 32px from 640px up, 24px under), on the page at every width |
| Section / card title | `CardTitle` (18px, semibold, Figtree: the heading font is for page titles and big numbers; 16px on a small card) or `h2` |
| Body | default (`text-base`) or `text-sm` in dense UI |
| Secondary | `text-sm text-muted-foreground` |
| Meta | `text-xs text-muted-foreground` in rows, parts joined with ` · `; under a page's title (`PageHeader`'s `meta`) `text-sm` |
| Group label | `group-label` (a utility in `globals.css`: 12px semibold capitals, tracked 0.06em, muted; capitals read a size up, the one size under 13px): the heading of a group inside a list or card (Home's Needs your attention, with its count as a `secondary` badge; a pull request's activity page's Help center and Feedback), a menu's group (Settings', Reporting's) and the part above a Reporting page's title. Quieter than the items under it, never in a colour |

| Tree level | `text-sm text-muted-foreground` after its icon, sentence case: a tree's sections and their groups (Autopilot's list: Feedback, Help center, a board, a collection) |

`text-sm` is 15px and `text-xs` 13px here (`globals.css` raises Tailwind's 14px and 12px: Figtree reads small):
`text-xs` is the smallest text anywhere. No `text-[11px]`,
`text-[0.625rem]` or other sizes below it for words a person reads.

## Layout

- **Admin app** (`/app`): every page lives in the sidebar shell
  (`app/app/layout.tsx`, `components/app-shell.tsx`), in one of three
  columns, each starting 32px past the sidebar (one left edge on every page, pages of panes too): max-w-5xl (lists, Home, a post), max-w-2xl for a form
  by itself (`data-narrow` on it: New project, Setup, Account), or the whole width (`data-wide`: the
  team's Roadmap, Users' tables; and pages of panes).
  The top bar stays at the top as the page scrolls; it holds the sidebar's
  button and where the page is, the project then its part ("Acme Calendar / Feedback"; `sectionOf`; the page's title once its heading has scrolled up
  under it); an editor's Save and Publish (`pinActions`) sit in it from tablet width up,
  fixed to the window as it is. The page's title, its description and its actions are on
  the page (`PageHeader`).
  A page of three panes (the sidebar, a column of its own, the page: Settings,
  Reporting, every Docs page with the docs' tree, Autopilot, the Inbox) takes the whole
  width, the labelled sidebar open beside its own column from 1280px up; under 1280px it
  folds to its rail, its column taking the room. The Inbox (its panes fill the window) and
  Customize (its rail and the portal's preview) always fold it. Every other page has it open. A pane's column is
  the page's height with a border beside it (`data-slot="pane-layout"`).
  The Inbox: its views (with their counts), the list
  and the open conversation side by side from laptop width up, each scrolling on
  its own under the header (the page itself doesn't; `InboxPanes`); the views always
  the row of tabs above the list, in the same place whether or not a conversation is open
  (they never move as one opens or closes): Needs reply, Mine and Unassigned as tabs, the
  rest (Waiting on user, Snoozed, Closed, Spam) under More, which reads as the one of them
  open, so the row fits the list's width (`SubNav`'s `more`); the list a third
  of the width (22–25rem), the conversation the rest; on phones and
  tablets the list or the conversation, its Back to the list. A row reads in two
  lines, as Featurebase's: who and their company on one (cut short, in full on hover) with,
  at the right, the assignee's face (their name on hover, and in the row's name to the ear) and its age, short ("4m": how long they've waited, or since
  the latest message); the subject and the latest message's first line on the other, cut
  short, after a small "Needs reply" (the highlight colour) when it needs one (not in the Needs
  reply view, where every row would say it; in Snoozed, when it's back first). Its number is in the conversation, and read out
  with the row.
  Every view lists the latest message first, Needs reply too. A conversation keeps
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
  `/autopilot/articles/<id>`): its pull requests' chips, then what happens to it;
  once nothing of it waits, the next one to review opens by itself. One going out by itself says when in its bar,
  with Dismiss, Stop and Publish now; one a teammate stopped says who and when it would have gone out. A post's review is what
  happens to the post and nothing else: its status change ("Open → In progress", "Open →
  Completed · emails up to N people"), the one comment that goes with it in a text box to edit,
  and one Approve (asking first) and Dismiss in a bar at the bottom; no list of updates, no
  checkboxes, no per-pull-request summaries. Each pull request's part (what it is, why, what
  became of it, its Dismiss and Undo) is in its chip's popover, as on an article's. A link
  isn't a review item (it changes nothing customers see): Autopilot applies the ones it's sure
  of by itself, and shows none waiting. An article's is
  one view of the whole article, like its editor (`ArticleChangesView`): above it what
  changed, folded away: what the new text says, written with the edits (none when it wasn't, never their reasons
  joined; each pull request's part is in its chip's popover: why, what became of it, and
  Dismiss, Write it again or Undo; a chip whose edit is out of date has an amber dot, and
  once one of them went, focus is on the chip row; when nothing waiting changes the article as
  readers see it, a notice says why: edits written on an earlier version, with Write them
  again and Dismiss them, or changes saved back to the published text; one of them out of date while others show,
  the same notice says it isn't in the changes), then
  the article as readers see it, a segmented Changes and Article at the top (Changes:
  every waiting change inline, removed blocks struck out in the destructive tint, added
  ones in `soft`; Article: the new text alone) with "Change 1 of N" and up and down from two changes,
  the change stepped to outlined; one Approve (publishes it, asking first) and Dismiss in
  a bar at the bottom, with Edit before publishing (its editor, whose ← leads back to the review). A new article's draft is
  the same view, all of it added, saying where it goes ("A new article, in Billing, after “Invoices”", "in a new
  collection, Exports", or "in no collection"), with Docs' collection picker in the bar to put it elsewhere (last
  there, or none), and its Approve says it saves a draft (Approve as a draft). Edits on a draft (an article not
  published) are the same view, the Changes against its text before them, with Edit the draft and Approve (asking
  first: they stay in the draft, which the team publishes from Docs). In the article's
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
  never wraps (one with more than fits puts the rest under More): too narrow, it scrolls sideways, with the active tab scrolled
  into view, faded at the end that has more (`useScrollingRow`; the portal's
  parts and their rows too). Settings has one menu of its own on the left, in groups
  (`SettingsMenu`: Project, Users, Support, AI, Connections, Billing; folded into
  one button above the page on phones); it opens on General. Reporting has one
  too (`SettingsMenu` with `label`: Help center, AI support, Inbox, a group's name
  small and uppercase, each page with its icon), each page its numbers (`Stat`, a
  labelled group; as Ferndesk's, its change on as many days just before as a badge, `soft` when
  better, `destructive` when worse, `secondary` when neither, with an arrow so it isn't colour
  alone, and a line of the range's days in its chart's colour: `countTrend`, `shareTrend` in
  points, `timeTrend`), a chart (`DailyChart`: a bar a day up to a month, a week up to a
  quarter, else a month; a bar's numbers on hover) and the lists behind them. Its
  heading (`ReportHeading`), as Ferndesk's: the part as a Group label, the title as a Page title,
  and the date range picker on the right (`?range=`, kept by the menu's links); never a sentence under it. The Docs home shows every tab
  with its collections as cards (each with its articles, then the collections
  in it). Every Docs page (the home too) has the docs as a tree
  in a column of its own beside it (`DocsWorkspace`; a "Browse docs" menu
  above it on phones); ⌘K finds articles and collections by name; a tab's page has Content, Access and
  Settings tabs; a collection's page lists what's in it, and its Settings
  button opens one page with its details and who can read it, saved by one Save.
- **Sidebar** (`AppSidebar`): its groups one under the other with a line between them (no gap
  pushing the last to the bottom); the page open is a raised neutral pill (the card's colour with a ring, semibold; green is for a page's own menu); a count
  is a small round pill, in the highlight colour where people wait on the team (the Inbox's open
  conversations), quiet otherwise (Feedback's to triage, Autopilot's to review).
- **Sign-in pages** (sign-in, sign-up, forgot and reset password, invitations): in the visitor's own
  light or dark, as the app is; the card's title in the heading font at 20px; the rest of the marketing site is light only (`forcedThemeFor`).
  Continue with Google and Continue with GitHub are both outline buttons with their marks, under
  nothing louder than the form's own primary. The header there has no Sign in or Start free
  (`SignedOutLinks`): the form is the way in. On phones no keyboard hints (`Ctrl K`).
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
- **Portals**: a header with the project name and the four parts (Feedback,
  Roadmap, Changelog, Docs; `components/portal-nav.tsx`), the open one underlined on the header's
  bottom edge; its contents in the pages' container (max-w-6xl, centred, on every page, Docs too).
  On phones the header is one line (name, Sign in or the account, the menu): the parts are in the
  menu. Under it the current part's row (boards, docs tabs) when it has two or more (none on a
  post's page, which has its way back). Content max-w-3xl; a board, a post and the changelog's list
  max-w-6xl on wide screens for their rails; the Roadmap max-w-6xl; "Powered by tuti" footer.
  The changelog's "New" for a signed-in reader is a dot in the `unread` colour (the widget's What's new dot), in the header
  and, on phones, in the menu.
  - **A board**: its name and a line under it (the team's description, else "Vote for the ideas you
    want most, or share your own."), then "Share an idea" (a card: the heading with a lightbulb, a
    one-line bordered title field and its button, opening to title + details once typed in; signed
    out, the button is "Sign in to post", and what's typed comes back after signing in). The list is
    open on the page (no card): Trending, Top, New (and Mine) tabs and the search on one bar with one
    rule under both, then rows: an 18px semibold title, two lines of excerpt, a byline (avatar, name,
    when, comments, then the status pill, none for Open), the vote pill on the right. Votes are a
    horizontal pill (chevron and count, 72px wide, 40px tall, `VoteButton pill`); a completed idea's,
    a green-tinted pill with a check, the count and "votes", no button. On wide screens a rail beside
    the list: Boards and Recently shipped as group-labelled lists, Get updates the one card (one line,
    the changelog by email, Changelog · RSS as text links); below wide screens Recently shipped and
    Get updates are under the list.
  - **A post**: back link, a 32px title, its status pill and "Expected <month>" under it, the byline,
    the body, the vote pill and the voters' faces ("+N more"). On wide screens a rail: Subscribe (the
    rail's filled button; Unsubscribe an outline), Copy link, a card with Board and Posted, "Shipped in";
    on phones Subscribe and Copy link under the post. Then the comments.
  - **The roadmap**: "Share an idea" beside the title, the board filter and "Sign in to vote" under it,
    three columns headed by their status's icon (calendar, hammer, check), name, plain count and meaning;
    a card per idea (board, title, two lines, the poster; "In the changelog" on a shipped one). On phones
    one column at a time, picked from tabs over them (`?column=`).
  - **The changelog**: a 48px title (36px on phones) with RSS and Subscribe (an outline, to the form)
    beside it (under it on phones), the tags as chips under it (links, `?tag=`, only the tags its
    entries have). On wide screens a timeline: each entry's short date ("7 Nov 2026") and tags in a
    margin, its dot on a line down the list; the entry's 28px title and 17px text beside them (date and
    tags above the title on phones, entries split by lines). Tags tinted on the portal (New green,
    Improved blue, Fixed amber, Breaking destructive). Reactions on an entry's own page only. A rail:
    past eight entries the month index (each month with its count, opening the page its newest entry
    is on), then Get updates by email; on phones the header's menu lists the entries and Get updates
    is after the list. An entry's page: a 40px title and, after it, Get updates by email.
  - **One-message pages** (the changelog's email links, unsubscribe, the SSO error, a page not found):
    one card (`PortalMessage`, max-w-sm) with a tinted icon, a 20px heading-font title, 15px text and
    full-width buttons, centred in the page. The 404 is the portal's (`not-found.tsx`), in its header
    and footer, no part marked, with links to Roadmap, Changelog and Docs. Sign-in pages (sign-in,
    forgot password, the link's page, the SSO error) are the same width at one fixed offset under the
    header, which has no Sign in there; the SSO error says it in plain words first, the technical
    detail as a small footnote, "Try again" its primary.
  Docs has one box for searching and asking, the header's ("Search or ask AI" with AI
  answers on; below tablet width a line of its own, the whole width; no
  separate AI button beside it); the docs home repeats it, big, under its heading (from tablet width:
  below it the header's is right above). Searching the docs never happens in the box itself:
  it opens the search dialog (`DocsSearchBox`), where "Ask AI" hands the
  question to the assistant, and before anything's typed "Open the assistant"
  goes back to the conversation as it was. The assistant is the widget's, the one
  conversation with AI answers: the portal opens its own widget with it
  (`Tuti.open({ ask })`), and has no panel of its own. Its results page says what it's
  for ("Results for “invoice”"), the first tab marked, as the tree beside it is
  that tab's. Popular articles on a tab's overview are that tab's, and only
  with three or more. On phones and
  tablets the header's menu button (`PortalMenu`) opens a full-screen menu with
  the parts (phones), the current part's navigation (the docs' tree, the boards) and the team's
  links, which the header shows only from tablet width. The header and the part's row stay at the top as
  the page scrolls, phones included (`PortalTop`; their height is `--portal-header-height`).
  Docs pages are in the header's container (`DocsLayout`): the tab's tree on the left
  (not beside a tab's overview, whose cards are its collections: there the
  team's sidebar links alone, if it has some)
  with a line beside it running the page's height (on a short page too), scrolling on its own, each name on one line, cut
  short with "…" (a "Browse docs" menu on phones), the page at max-w-3xl
  with the footer under it (not under the tree, which it would push up), and an article's "On this page" on the right on wide screens
  (the section being read marked), with "Was this helpful?" under it (under the
  article where it's not shown, phones included). Above an article's or a
  collection's title, the level above in the accent colour: its collection,
  else its tab (with two or more) or "All collections". An article's title 40px (32px on phones). Articles use `article-text` on top of
  `rich-text`: bigger headings, softer body text, room between steps (on the portal a step brighter
  and closer); Previous and Next are cards with the title in the foreground colour (left-aligned on
  phones). A tab's overview shows its collections once: on the docs home a heading over a soft green
  glow and the big box, then a card per collection (an icon tile beside the name, the description in
  two lines, how many articles the reader may open; two per row from tablet width, one on phones),
  then its own Popular articles (three or more) and the articles in no collection, as rows with a file
  icon and a chevron (one column; Related articles the same). The current article in the tree is
  tinted green. A collection's page: its icon and name, a card of its
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
  its edge; the first time, once its page has loaded, half a second at most, so it
  never grows in empty) and shrinks back as it closes; with reduced motion it just appears.
  Light or dark as the portal's colour scheme says (Customize → Branding; by default the visitor's
  device), unless the site picks one (`data-theme`, or `Tuti.setTheme` later), which every panel takes,
  from its first paint, and the button unless it has its own colour (Customize → Widget).
  On screens up to 640px wide the floating panel takes the whole screen, over the
  launcher, kept clear of the phone's status bar and home indicator, and slides up.
  Messages has the team on top in a card (their faces and when they usually reply,
  as on Home, and New message across it), then "Your conversations" (a group label)
  over their conversations, newest first, each a row with its latest line ("You:"
  before theirs) and "Closed", "Replied" or "Waiting for a reply"; while it loads,
  a skeleton of that list, never "Loading…" (screen readers are told), and if it
  can't load, the error with Try again.
  A conversation in Messages opens at its newest message, its reply box at the
  bottom of the panel as the messages scroll under it.
- Both layouts stack page sections with `gap-6`; don't add margins between them.

## Components

Use these instead of hand-rolling layout:

- **`PageHeader`** (`title`, `back`, `description`, `meta`, `actions`, `more`): the top of every page,
  its title the page's heading at every width (the Page title style), `back` above it, then
  `description`: one short muted line saying what the page is for ("Ideas and problems your
  users posted, by status."; on portals the team's own words), on a section's main page
  (Home, Feedback, Roadmap, Changelog, Docs, Autopilot, Users, Settings), not on a page
  about one thing; then `meta`, facts about the thing shown ("#12 · Ada · 3 votes").
  The actions sit beside the title and description, on the right, from tablet width up.
  `more` is the actions used less often, behind "More actions".
  An editor whose title field shows the title (an article, a changelog entry) keeps the
  heading for screen readers only (`sr-only`).
  In the app on phones the actions are a "More actions" menu from the top bar (`PageActions`). A page whose
  every visit needs them (a conversation's Assign, Snooze and Close) shows them
  in a row under its header on phones as well, still in the menu (in reach once
  the row has scrolled away). An editor whose
  main action must stay in reach (Save and Publish) pins `actions` (`pinActions`): to a
  bar at the bottom of the screen on phones, the menu keeping `more`, and to the top bar
  from tablet width up (`barActions`: the top bar alone, the docs article editor's);
  the bar steps aside while text is being typed (the keyboard is up then).
  Where Tuti's own chat launcher shows in the app (its cloud), what's held at the
  bottom of the screen keeps its buttons clear of the launcher's corner
  (`launcher:`): a bar (that one, Autopilot's Approve) stops them left of it, a
  row more if they need it. The launcher isn't in the Inbox or on Customize (`AppWidget`), so
  the Inbox's reply box needs no room for it.
  It assumes the launcher at the bottom right, where Tuti's help project keeps it:
  moved to the left (Customize → Widget), `launcher:` would need its side too.
- **`BackLink`**: "← Feedback" above a detail page's header; in the app it's
  `PageHeader`'s `back` (a post's page draws its own row: the back link, and the newer/older post as ‹ › at its
  other end, away from the title).
- **A post's page** (the team's): its header and text in one column (up to 48rem, the page the whole width), its
  sidebar beside it from the top with a line on its left: "Properties" as icon + label rows whose values are quiet
  selects (`QUIET_TRIGGER`: no border until hover, the chevron on hover), then Voters (their faces, three by name,
  "N more"), what shipped it, its changelog entries (Draft/Published badges), posts like it. The meta line under the
  title: number · author · age · "▲ N votes". Its status changes read as sentences ("Olive Owner moved it to [In
  progress] · 11 people emailed · 2 days ago"). The team's reply box picks "Reply | Internal note" above it (tinted in
  the highlight colour for a note), Email voters at its left, the button at its right. Team replies and notes: a 3px
  line down the left and a light tint (green, the highlight's); every comment inset by that line, so the avatars
  keep one column. On phones the properties are a card folded to one line (status, owner, ETA) over the post, the
  rest of the sidebar after the comments.
- **The team's roadmap**: no column fill (the cards make the lanes), each column's header an icon in its status's
  colour, its name, count and a one-line note; cards: board, the vote pill and "⋯" (status menu) on top, a 16px
  title, two lines of the post, then the owner and ETA when there are. On phones one column at a time, picked from a
  segmented row with counts.
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
  - Rows can be picked (a checkbox in the row's left padding, "Select <title>", shown on the row's hover or
    focus and on every row once one is picked; phones change posts one at a time) for what's
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
  - Feedback's rows (`PickedRow`), the same at every width: the votes in a small bordered box (`VoteBox`); the
    board as a small uppercase label over the title (17px semibold), a line of the post, then who · when · comments;
    at the right the owner's face (tablet width up) and the status menu, a quiet "⋯" (`PostStatusMenu
    badge={false}`): the tab says the status, and All, when it mixes them, is grouped under each status (its dot,
    name and count) in the tabs' order. Where statuses mix ungrouped (Possible duplicates, a tab only while there are
    some) the pill opens the menu. The list takes its column's whole width; a post opens beside it. The search sits
    in the filter row; on phones the filters are one "Filters" button (a popover, Boards in it too) beside the
    search and "+ New".
  - A post's vote count, first in its row, has the vote arrow over it (and
    "votes" for screen readers), so it doesn't read as a bare number (`VoteCount`, `VoteBox`).
  - Compact actions (a badge, one or two small buttons) stay on the right.
  - Pickers or several buttons → `wideActions`: on phones they move under the
    title and share the row width. Give select triggers `w-full sm:w-…`.
  - A card listing several kinds of thing (Home's "Needs your attention")
    groups them by kind, the most urgent first: each a heading with how many,
    its first few rows, the longest waiting first (or, where its list shows only the top few, as that list ranks them; Autopilot's, To review's first rows in its order, so the two read the same), and a link to that list ("See all" when it holds them all, else named for where it goes); no kind badge per row.
- A list compared across columns (Users) is a table in a `Card`: its headings
  sort it (a link each, `aria-sort` on the one in use, the most first; a rate whose low end is what needs the team,
  Reporting's Articles' Found it helpful, the least first and marked ascending), and on
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
- **`CopyField`**: a value the team pastes elsewhere (a script tag, a rule)
  in a muted box with "Copy", never bare code.
- **Setup steps** (`SetupSteps`, `SetupStep` in `components/dns-setup.tsx`): a
  setup the team goes through in order (a custom domain, their own email
  address) as steps down a line, each done (a green tick), current (a ring,
  `aria-current="step"`) or still to come (muted, saying what it'll ask). A done
  step shows what was given (`SetupValue`); a step's status sits beside its
  title, its shortcuts (`aside`) at its right (under it on phones). What a step waits for is a `WaitingNotice` (highlight colour).
- **`DnsRecords`**: DNS records to add, as a provider's form asks for them: a
  table of type, name, content, TTL and, where Tuti checks it, each record's
  status (`DnsStatusPill`: Verified green, Pending beak-orange, Failed red). Each
  name and content is selectable text with its own Copy button (copying is
  blocked over plain HTTP, so self-hosters select it), named for its record. On
  phones each record is a block, its parts labelled. `CopyRows` is the same for labelled values that aren't
  records (an address to forward, and where to).
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
- A control's parts read at 3:1 or more on what's under them, in light and dark: a switch's
  off track and its thumb, a progress bar's empty track (outlined, so one at 0 is seen to be empty).
  A menu item that's locked (a plan's) keeps its text, with a lock, not faded.
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
