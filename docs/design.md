# Design system

Tuti's look ("Parrot") and the rules for building screens. See every pattern
live, in light and dark, at **`/app/design`** (dev only, e.g. https://dev.tuti.so/app/design).
Check new UI there and at phone width (390px) before shipping it.

## Brand

*Tuti* is Persian for parrot. The brand is friendly and a bit playful, never
cute at the expense of clarity.

- **Colour:** leafy green primary, a beak-orange highlight, warm paper
  neutrals. Dark mode uses a brighter green with dark text on it (the public portal's dark is neutral, see Layout →
  Portals).
- **Type:** Figtree for text, Bricolage Grotesque for headings (`h1`–`h3` and
  `font-heading` pick it up automatically) in the app; Inter for both on the public portal, unless the project picks
  its own (Settings → Branding; see Layout → Portals). Every font is a file: these and the symbols font in
  `packages/ui/src/fonts` (`brand-fonts.ts`, the app's and the marketing site's), the portals' 16 in `apps/web/src/fonts`
  (`node scripts/fetch-fonts.mjs` fetches
  them, with their licences), loaded with `next/font/local`: builds never
  download fonts. A symbol none of them has, nor their fallback (the device's Arial, which
  has the common arrows and math signs), comes from a cut-down Noto Sans Math after them
  ("⋯", ✓; `--font-symbols`, also `next/font/local`), never an empty box.
- **Mark:** the parrot (`TutiMark`, `TutiLogo` in `packages/ui/src/tuti-logo.tsx`;
  favicon `app/icon.svg`, in each app). The current drawing is a placeholder until we have
  a proper illustration.
- **Corners:** `--radius` 0.5rem → controls (buttons, inputs, selects) 8px (`rounded-lg`), cards and tiles
  ~11px (`rounded-xl`), pills fully round. On the public portal `--radius` is 0.625rem: controls 10px,
  cards 14px, through the same `rounded-lg` and `rounded-xl`. The portal board search variant below uses the larger corners.
  A workspace's panes, the large surfaces that sit on the page's canvas side by side (the Inbox's list, conversation
  and details; the composer card; Docs' tree, page and article tools), are a step larger, `rounded-2xl` (~14px), so they read as panes, not as cards inside one.
- **Controls:** 36px tall (`h-9`: `Button`, `Input`, `SelectTrigger`), 32px in dense rows (`size="sm"`).
  Fields (`Input`, `Textarea`, `SelectTrigger`) sit on the card's colour in light (white) and on the
  page's in dark (a step below the card), with the `input` border, their placeholder lighter than a value; a textarea grows with its text and has no resize grip. A card's footer (`CardFooter`) is a
  line above its buttons, never a grey band. The primary
  button is flat: one fill, its border the same colour, a soft shadow; no bevel or edge.
- **Portal board search:** a larger, filled field (`BoardSearch`), full width as the first step in finding an existing
  idea: 40px high on phones (`h-10`), 44px from 640px (`sm:h-11`), with 14px portal corners (`rounded-xl`) and the
  page's fill in light and dark (`bg-background`). Its search icon sits inside on the left. Text is 16px below 768px
  to avoid iOS focus zoom, 15px from 768px (`text-base md:text-[0.9375rem]`). This named variant deliberately differs from
  the standard control's height, radius and light-mode fill; it gives the board's search room to lead the list.
- **Surfaces:** a ladder: the sidebar (a step darker than the page in light), the page (`background`, a soft
  cream), cards on it (`card`: white in light, a step lighter than the page in dark)
  with a `border` ring and a soft shadow (`Card`, `StatTile`), never a card without its edge.

## Tokens

All colours are CSS variables in `packages/ui/src/globals.css` (`:root`/`.light`
and `.dark`), used through Tailwind (`bg-primary`, `text-muted-foreground`, …).
Never hard-code a colour in a component; add a token if one is missing.

| Token | Use for |
| --- | --- |
| `primary` | The one main action on a screen, votes you've cast, active tab, links that need emphasis |
| `soft` / `soft-foreground` | Quiet green emphasis (on the portal and the widget, the project's accent: Layout → Portals → Accent) |
| `highlight` / `highlight-foreground` | Things that need the team's attention ("Possible duplicate") |
| `unread` | A dot on what's new to the reader (the widget's Messages and What's new) |
| `muted-foreground` | Secondary text, meta lines, placeholders: 4.5:1 or more on the page, a card, the sidebar and a muted fill, in light and dark (`colours.test.ts`) |
| `border`, `input` | A card's or divider's edge (1.25:1 on the page), an input's (1.5:1) |
| `sidebar-active` / `sidebar-active-foreground` | The page open in a page's own menu (`SettingsMenu`, which no area uses now): a pale green pill, its label and icon green (4.5:1). The sidebar's open page is a raised neutral pill (the card's colour, a `sidebar-border` ring), so a page with both shows one green. A section pane (Panes) marks its open link with the neutral `accent` instead |
| `secondary`, `accent` | Neutral fills and hover backgrounds |
| `destructive` | Delete, remove, errors |
| `destructive-foreground` | Text on the destructive tint (a destructive badge or button, the picked Breaking tag), dark enough for 4.5:1 at small sizes; a tint under it stays light enough to keep that (a destructive button hovers at 15% in light mode, 25% in dark, also on a dialog's muted footer) |
| `series-1`, `series-2` | Reporting's charts (`DailyChart`): the first series (what went well) the brand's green, the second (what needs the team) orange, a lightness step (≥0.15) apart so colour-blind readers tell them apart (`colours.test.ts`), checked against the card in light and dark; a period still under way (today, the month so far) a dashed outline in its colour around a light fill of it, said "so far". Never a status's colour |

Post statuses in the app (`PostStatusBadge`, `STATUS_STYLES` the one map of their look; the public portal's own hues and
`StatusLabel`/`StatusPill` are under Layout → Portals): one
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
(`ChangelogEntryView`'s `TAG_TINTS`) New, Improved and Fixed are tinted by kind (soft green, `tag-improved` blue, the
orange `highlight`) so a list can be scanned; Breaking keeps its destructive look.
States that aren't a status (the running draft's "Collecting pull requests")
are neutral (outline), never a status's colour.

People (`Avatar`; on the public portal one neutral style, `PortalAvatar`): their photo, or else their initials in white on one of the
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
| Group label | `group-label` (a utility in `globals.css`: 12px semibold capitals, tracked 0.06em, muted; capitals read a size up, the one size under 13px): the heading of a group inside a list or card (Home's Needs your attention, with its count as a `secondary` badge; a pull request's activity page's Help center and Feedback). Quieter than the items under it, never in a colour. A section pane's groups (Panes) are sentence case instead |

| Tree level | `text-sm text-muted-foreground` after its icon, sentence case: a tree's sections and their groups (Autopilot's list: Feedback, Help center, a board, a collection) |

`text-sm` is 15px and `text-xs` 13px here (`globals.css` raises Tailwind's 14px and 12px: Figtree reads small):
`text-xs` is the smallest text anywhere. No `text-[11px]`,
`text-[0.625rem]` or other sizes below it for words a person reads.

## Layout

- **Admin app** (`/app`): every signed-in page lives in the sidebar shell
  (`app/app/(workspace)/layout.tsx`, `components/app-shell.tsx`); the pages for the signed out and the
  operator's links (`/app/auth/*`, `/app/license`, `/app/admin/*`) sit outside it, under Tuti's logo
  over a centred `<main>` (`app/app/(account-pages)/layout.tsx`). Shell pages sit in one of three
  columns, each starting 32px past the sidebar (one left edge on every page, pages of panes too): max-w-5xl (lists, a post), max-w-2xl for a form
  by itself (`data-narrow` on it; New project, Setup and Account are panes now), or the whole width (`data-wide`: the
  team's Roadmap; and pages of panes: Home, Users). Feedback, a page of panes, caps itself at 72rem while
  no post is open beside its list, so its rows stay scannable on a wide screen. It keeps the shell's left edge
  whether or not a post is open, so the clicked row stays in place.
  From tablet width up there is no separate app header: the page starts at the top of the shell. Its own
  `PageHeader` keeps the title, description, metadata and actions together and, in windows at least 40rem tall, sticks
  to the top as the page scrolls; a post's back/previous/next row sticks with it. Editors keep Save and Publish beside
  their page context, in the same sticky header at any window height. Shorter or zoomed windows let other headers scroll
  away to leave room for the content. An article's back link and draft state share one compact block beside its actions,
  with a lower divider; the toolbar and text share a reading column, at the portal's width. The sidebar's visible "Toggle Sidebar"
  button sits beside the project switcher when expanded and at the top of the icon rail when collapsed. The edge rail
  and Ctrl/⌘B shortcut also toggle it, with a visible keyboard focus indicator. The shortcut leaves typing
  and shortcuts already handled by an editor alone. On phones a compact sticky row keeps the menu and project/section path, the page's title
  once its heading scrolls away, and `PageActions` at its right end. An editor's primary actions (`pinActions`) stay
  at the bottom on phones. Pane heights and sticky menus use the full window on wider screens.
  A page of three panes (the sidebar, a column of its own, the page: Settings (Panes),
  Reporting, every Docs page with the docs' tree, Autopilot, the Inbox) takes the whole
  width. The app sidebar starts collapsed to the same icon rail on every page. Only its toggle, Ctrl/⌘+B,
  or App navigation in the Docs sheet can open it. The toggle and shortcut also collapse it; that choice stays
  across navigation, screen widths and reloads (the existing `sidebar_state`
  cookie, kept for seven days). Phones keep their off-canvas sheet, which closes on navigation.
  Inset thresholds translated from viewport breakpoints subtract the 3rem rail: 64rem becomes 61rem,
  and 80rem becomes 77rem, preserving the layout at the default rail width.
  The docs' tree folds independently, when the sidebar inset has at least 61rem, on its own button at its top ("Hide the docs
  tree"; a rail with "Show the docs tree" in its place), remembered per browser on every Docs page (`DocsTreeFold`:
  `data-docs-tree-folded` on `<html>`, set before the page shows by the app layout's script). A pane's column is
  the page's height with a border beside it (`data-slot="pane-layout"`).
  The Inbox is panes (`PaneLayout`, under Panes): its views in a section pane titled "Inbox" (Needs reply, Mine,
  Unassigned, Waiting on user, Snoozed, Closed, Spam, each with its count; on phones the list header's menu), the
  list and the open conversation side by side when the room beside the section pane has 52.5rem, each scrolling on
  its own (the page itself doesn't; `InboxPanes`). The list's pane header is its view and count; the conversation's
  is "Inbox ›" and its subject, with Close, More actions and the details toggle. With less room, the list or the
  conversation ("‹ Inbox" on phones, its subject on a line of its own under the header).
  Opening the app sidebar can switch to this single-pane layout without changing the sidebar preference. A row reads in three
  lines: who and their company on one (cut short, in full on hover) with,
  at the right, the assignee's face (their name on hover, and in the row's name to the ear) and its age, short ("4m": how long they've waited, or since
  the latest message); the subject and the latest message's first line on separate lines, cut
  short, after a small "Needs reply" (the highlight colour) when it needs one (not in the Needs
  reply view, where every row would say it; in Snoozed, when it's back first). Its number is in the conversation, and read out
  with the row. Unread customer messages make the name and subject bold for each teammate; opening the
  conversation makes them normal-weight in a softer foreground, with a muted preview. Team replies and notes
  never make it unread. Only customer messages after deployment or the teammate joining start unread;
  opening acknowledges the latest customer message shown, using its timestamp, only while the page is visible and focused. Needs reply is independent of whether it has been read.
  Every view lists the latest message first, Needs reply too. A conversation keeps
  its own address (`/inbox/<number>`), the list beside it where it was, its row
  marked; J and K open the next and the previous one. Until one opens, the pane
  beside the list has the Inbox's numbers (`StatStrip`): who's waiting
  for a reply and the longest wait (the Needs reply view's count, opening it), the
  usual first reply (the widget's, "—" with "Not enough yet" below before five answers) and the
  week's new conversations (those two without sample content), with "Open a conversation to
  reply here" under them (an empty Inbox: that new ones show up here, said
  there rather than in the list's empty state too). On phones the list is alone.
  A conversation opens at its newest message, its reply box at
  the bottom of the screen as the messages scroll under it, however many there are.
  Its list, conversation and details are white panes on the shell's canvas, 8px apart.
  Rows put who, the subject and the latest message on separate lines. Messages are plain text plus attachments,
  in chat bubbles with the author's avatar and time; internal notes have the highlight tint. The composer is one card.
  Close, More actions and the details toggle share the conversation's title row at every width. Assign lives in
  details, followed by Status and Snooze (Waiting until while snoozed). The details card collapses, with that choice
  kept for the browser; without room for it (38rem beside a 480px conversation) its toggle opens the same controls and context in a sheet,
  leaving room for the conversation even with the app sidebar open. The toggle uses the same rem threshold
  and current root font size as the CSS, so the sheet stays reachable with larger text.
  Linked posts and Looks related start open. Customer details, Company, Other conversations from this person,
  Recent page visits, Events and Conversation attributes start folded, each with an icon, count and chevron.
  Other conversations expand to a title, a muted status · number · date line and one line of the latest message.
  Day dividers group each message by its own day in the viewer’s time zone, with "Today · <date>" or "Yesterday · <date>" when applicable. The widget-off notice is
  13px muted text. Inbox layout uses component Tailwind utilities; its message bubbles' fills use the
  `inbox-customer`, `inbox-team` and `inbox-note` tokens in `globals.css`.
  When their columns fit (61rem of sidebar inset for Docs, 52.5rem beside the Inbox's section pane), the Docs tree (240–440px) and Inbox list (22rem minimum, 352px at default text, up to 520px;
  defaulting to the minimum) resize from a 10px handle centred in their gap. Hover, focus and dragging highlight its line in primary; dragging keeps the resize cursor and
  prevents selection across the page. The Inbox maximum also shrinks to keep the conversation at least 480px wide beside visible
  details, recomputing as the window or details change without replacing the saved preference. Details keep a 15rem
  minimum; when the Inbox's actual container cannot fit the list, conversation, details and gaps, their toggle opens
  the details sheet instead. Conversation actions stay
  beside the subject, which shows its full text on hover (and wraps in full on phones). A narrow Docs page wraps its title actions. Arrow keys resize by 10px, Home/End pick the limits, and double-click resets.
  Each width is remembered in the browser and restored before paint; folded trees and smaller screens have no handle.
  Company keeps company, plan and seats together; Customer details keeps identity, other properties, groups, posts and votes reachable; visits and events show zero until
  recorded. The conversation title stays in view as its messages scroll, and the composer stays at the bottom.
  A changelog entry's editor has a sidebar
  beside the text (under it on phones): its tags as chips, the posts it completes
  ("Link post…"), its cover image, how it's announced (Email subscribers, Mark it new: picked
  there, so Publish only confirms; published, what happened and how many people were told),
  "View as reader"; Save sits with Publish in the page's sticky toolbar (at the bottom of the screen on phones),
  and on phones the title shows once, the one to edit. The cover shows under the title in the
  text's column, as readers see it. One way into AI: while the text is still the pull requests'
  titles, the toolbar's Draft with AI (the main action); once it's written, Edit with AI's menu
  over the text, Draft with AI in it.
  Autopilot's column is what it updates, under To review (updates waiting for the
  team or going out by themselves) and Reviewed, each in two sections, Feedback (posts
  on every board) then Help center (articles, and new articles' drafts), the ones that
  reach the most people first; and Activity, every merged pull request (those with
  nothing to do folded away at the end, To review pointing to those not read yet).
  Its list is a pane titled Autopilot (the page's heading while nothing is open beside it, a level-2 heading once
  something is), To review, Reviewed and Activity as pills in a row of their own under the title (the pane is too
  narrow for them beside it); they are tabs, not links (the rows' pages don't say which one they're in).
  With at least 61rem of sidebar inset, the list pane sits beside the open page's pane (20rem wide, 24rem from 77rem
  of inset); with nothing open, that pane says what a row of the tab opens, or with nothing in the tab, what
  Autopilot is, never an empty panel. With less room, the list or the picked page fills the width, each a pane the
  window's height from the shell's tablet width up, the list scrolling inside it under its header; the page's
  notices (sent here from a review with nothing left, the plan's) sit above the list, or with nothing to list,
  under its header. Opening the first review follows this same layout.
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
  The team Docs workspace uses rounded tree, page and tools surfaces on the canvas, separated by 12px gaps,
  with no breadcrumb bar or embedded preview. Its tree defaults to 274px and owns the Docs title, search and navigation;
  below 61rem of sidebar inset width the Docs button opens it as a sheet, including App navigation. Moving back to an inline tree
  closes and resets the sheet; Search docs opens the command menu in either layout. Subpages have a small parent link.
  An article's editable title sits beside Saved (Save while there are edits) and Publish; its publishing state
  and live Open link sit below. New and saved articles use the same inset thresholds for editor padding and formatting controls.
  The formatting row stays pinned while the article body scrolls. Settings,
  History and Verify share one collapsible card (20.625rem, 18.75rem below 77rem of sidebar inset width), opening from icons at the
  end of the formatting row. Below 76rem of inset width the tools use a bottom sheet so the editor keeps its room,
  even with the app sidebar open. Narrowing the inset closes an open card without opening a sheet; its Settings draft
  stays until the user explicitly closes or saves it, and clicking Settings again opens that draft in the sheet.
  Focus inside a closing card returns to that tool's toolbar button. Saving keeps the visible fields current while the panel closes.
  Collapsing the card returns its space to the document. These layout thresholds
  follow the inset and the current root font size in both CSS and JavaScript.
  History keeps a timeline and an inline comparison under the selected version, with the full comparison available.
  Verify keeps its runs, source evidence, sentence jumps and fixes to review. Unpublish and Delete stay under
  More actions; the Unpublished changes pill opens Review and Discard. The text remains capped at the portal's
  reading width (46rem with sections, 43rem without), and the title wraps. A new article includes an optional
  description and its collection beside Draft. Collection settings keep one Save with the title.
  Docs' home has Verify all beside its explanation: a dialog saying what it will cost first (credits, or how many AI
  runs), then, started or opened again while it runs, how far it's got ("Checked 3 of 12
  articles", a bar) and at the end what it found, with Review in Autopilot. Its fix is a part of
  the article's review like a pull request's, named Verify. A pull request's
  activity page (`/autopilot/activity/<id>`) has its chip, what changed for users,
  "Why Autopilot made this change" folded away, and what it touched as a tree (Help
  center → collection → article, then Feedback), each opening its review. On phones
  and tablets it's the list right under the page's title, then the page picked.
  Users is a pane (Panes): People and Companies as pills in its header, Sync from your app at its right end, its
  tables on the pane at its whole width: who (name, email, and their id from tablet width up), the properties the team
  picks, headed by the team's name for each or the key in words ("plan_name": "Plan
  name"), their groups in a column, then what they did. A person's page is a pane too, "All users ›" before their
  name in its header (on phones "‹ All users", the name for screen readers): their avatar, name, email and id first,
  then their profile (groups, properties, on a muted fill) beside all their posts, votes and conversations, each
  status a badge (one column on phones). A page with sections of its own that isn't a page of panes yet lists them
  under its header with `SubNav`.
  Tabs come in two styles. Switching a page's views or sections (Feedback's
  statuses, Changelog, Users, a docs tab's Content, Access and
  Settings, a collection's Content and Settings) is
  underline tabs, `SubNav` (in a pane, pills: `FilterPills`, under Panes; Reporting's AI conversations); switching a control's mode (the reply
  box's Reply and Note) is a segmented
  `Tabs` (Autopilot's To review, Reviewed and Activity are tabs drawn as pills, as `FilterPills`). Filters are chips, not tabs, except a public list's one filter that splits it into views of itself: the
  portal changelog's tags (All, New, Improved, Fixed) are underline tabs (`SubNav`), as the board's sort tabs, so the
  portal's lists read the same way. A portal board's status is a menu at the end of its sort row (each status with its
  count): a second row of chips or tabs would put more between the visitor and the list. The portal roadmap's three columns, one at a time on phones, are a segmented control:
  three fixed parts of one board that always fit, side by side on wider screens. A row of tabs
  never wraps (one with more than fits puts the rest under More): too narrow, it scrolls sideways, with the active tab scrolled
  into view, faded at the end that has more (`useScrollingRow`; the portal's
  parts and their rows too). Settings has a section pane of its own (Panes), in groups (Project,
  Portal, Users, Support, AI, Connections, Billing; a drawer from the page's header below 48rem of sidebar inset); it opens
  on General. Each of its pages is a `SettingsPane`: a pane titled by the page, a line on what it's for, then its
  `SettingsCard`s (a form that isn't a row in a `SettingBlock`); the Portal group's pages are `PortalSettingsPane`s
  instead, their settings beside a preview (Portal settings, below). Reporting is a
  `SectionPane` (Help center, AI support, Inbox, each page with its icon; a drawer on phones), its links keeping the
  range. Each report is a pane (`ReportPane`): its title in the `PaneHeader`, the date range picker at its right
  (`?range=`; on phones in a row under the title; its dates beside it from 64rem of sidebar inset); never a sentence
  under it. Its numbers sit in one strip as `StatStrip`'s (`Stats`, each `Stat` a
  labelled group; as Ferndesk's, its change on as many days just before as a badge, `soft` when
  better, `destructive` when worse, `secondary` when neither, with an arrow so it isn't colour
  alone, and a line of the range's days in its chart's colour: `countTrend`, `shareTrend` in
  points, `timeTrend`), then a chart (`DailyChart`: a bar a day up to a month, a week up to a
  quarter, else a month; a bar's numbers on hover) and the lists behind them. The Docs home starts
  with live articles, views and helpful votes for the last 30 days, followed by Waiting to publish and Most read
  side by side (stacked on phones). The queue shows three saved versions, expands to the rest, and confirms
  Publish or Publish all before taking them live. Verify all and the live help center link sit below. Collections
  and tabs remain reachable in the tree. A collection's page is a flat ordered table with article state, views,
  helpful votes and updated date; Content and Settings sit under its header. Collection settings use flat Details
  and Access sections with labelled fields, a single Save beside the title and deletion at the end. Tab pages
  keep Content, Access and Settings. Recently deleted articles can still be restored from the overview.

- **Sidebar** (`AppSidebar`): its groups one under the other with a line between them (no gap
  pushing the last to the bottom); the page open is a raised neutral pill (the card's colour with a ring, semibold; green is for a page's own menu); a count
  is a small round pill, in the highlight colour where people wait on the team (the Inbox's open
  conversations), quiet otherwise (Feedback's to triage, Autopilot's to review).
- **Sign-in pages** (sign-in, sign-up, forgot and reset password, invitations): in the visitor's own
  light or dark, as the app is; the card's title in the heading font at 20px; the rest of the marketing site (`apps/marketing`) is light only (it never sets the dark theme), though a page may set dark brand bands inside it (the home page's forest-green sections and final band, `landing.css`).
  Continue with Google and Continue with GitHub are both outline buttons with their marks, under
  nothing louder than the form's own primary. Their header (the account pages' layout, under `/app/auth`)
  is Tuti's logo alone, no Sign in or Start free: the form is the way in. On phones no keyboard hints (`Ctrl K`).
- **Portal settings** (Settings' Portal group: `/app/<project>/settings/<page>`, `lib/portal-pages.ts`; Customize's
  old addresses send people on to them). `PortalSettingsPane`: one pane, the page's title and description in its
  header with "Save changes"; its settings in a column (cards inside) and beside it, from 61rem of the shell up, the
  portal it changes in a browser frame at desktop or phone width, light or dark (or the page's own preview: the
  widget, a search result), each scrolling on its own; with less room the preview comes after the settings. Settings
  that change how the portal looks go here. A page's forms use `useCustomizeForm`: "Save changes" saves every one with
  a change (enabled once something changed), and `toDraft` shows a change in the frame as it's made (the portal's
  `PortalLookProvider` takes it); leaving with changes not saved asks first. Tuti's own chat launcher stays off these
  pages: their previews show the project's widget.
- **Portals** (the public portal's own look: a header card per list, a rail led by its one primary action, a calm shell):
  - **Look.** Inter for headings and text by default (preloaded; headings 650, tracked −0.022em; body 15–17px); a project's own
    fonts (Settings → Branding: `headingFont`, `bodyFont`) still win, and the portal's dialogs and menus take them too.
    Portal-only tokens in `globals.css` (`:root:has([data-portal-top])`, so the app keeps its own): stronger lines on the
    paper (`border` 0.87 L, `input` 0.81 L), secondary text at 0.48 L, a neutral dark mode (background 0.165, cards
    0.205, lines 0.32/0.40, chroma ≈0.005; green stays the accent), 14px cards and 10px controls (`--radius` 0.625rem),
    a soft card shadow (`shadow-card`), `sunken` for inline code, `info` for callouts and `tag-improved` for the changelog.
    Statuses there are one hue each in both themes: Under review violet, Planned blue, In progress orange, Completed
    green, Open grey (`status-*` overridden), shown as `StatusLabel` (its icon and name in its colour: eye, calendar, a
    half-filled circle, a circled check) or `StatusPill` (the same on a light tint of it). People's initials are one
    neutral style (`PortalAvatar`; the `avatar-*` tokens are all `secondary` there), the team's soft green.
  - **Accent.** "Green" on the portal means the project's accent (Settings → Branding), Tuti's green only when it has
    none: `brandCss` (`lib/colors.ts`) sets `primary`, its text, the focus `ring` and the `soft` tint and its text (at
    Tuti's own tints' lightness in each mode, in the accent's hue) on the portal's pages and the widget's panel. So the
    accent is the letter mark, the one filled button, links, focus rings, selection, a vote cast, the open board, part or
    article, the team's replies, the New tag, numbered steps, the widget's header and launcher (unless Settings → Widget
    gives it a colour of its own, or the accent wouldn't stand out on a light page and a dark one: the launcher is one
    colour on any site, so it's the brand green then). What keeps a
    colour of its own, whatever the accent: statuses (Completed stays green: it says what happened), the changelog's
    other tags, destructive red, the info blue, the unread orange, people's initials, and "Powered by tuti" (Tuti's own
    mark). The portal never uses the app's own green tokens (`sidebar-active`, `series-*`, `chart-*`, `kind-*`), and
    `e2e/accent-colour.spec.ts` checks every page type and the widget in light and dark for any green but those.
  - **Header.** The logo, or without one a square in the brand's colour with the name's first letter, then the name;
    the four parts (Feedback, Roadmap, Changelog, Docs; `components/portal-nav.tsx`) in medium weight, the open one
    underlined on the header's bottom edge; Sign in an outline at the end; 64px tall (56px on phones). Its contents in
    the pages' container (max-w-6xl; 82rem on every docs page from 1280px, and on docs articles with sections below 1280px too).
    On phones the header is one line (mark and name, Sign in or the account, the
    menu): the parts are in the menu. Under it the current part's row (boards, docs tabs) when it has two or more
    (none on a post's page, nor beside a board's rail). A "Powered by tuti" footer under a line.
  - **A board** (the visitor's job: is my idea here? then vote or post it): a card with its name (34px), its line (the team's
    description, else "Vote for the ideas you want most, or share your own."), and at its top right **Get updates** (an
    outline with a bell; a popover with where the reader stands, the changelog by email, "Read the changelog" and RSS).
    Then the Portal board search variant above, first and full width: after a typing pause it replaces the current URL
    without adding a history entry; Enter submits a new entry. Back and Forward cancel waiting typing and update the
    box only when the URL's search changes, keeping unsent words through sort- or status-only history changes. Links
    restore the destination's search; opening a link elsewhere leaves this page's search alone. Then under a line the
    sort tabs with icons (Trending flame, Top trending, New clock, Mine) and at the row's end the **status menu**, a quiet
    button saying what the list shows and how many ("Not done yet 8"; a status in its icon and colour): a menu of links
    with counts, Not done yet (the default), each status with ideas on the board, then Every idea. Then the rows, open on
    the page and inset to the card's text: the status label above the title (none for Open), a 17px title, two lines of
    excerpt, a byline (initial, name, when, comments), a boxed vote on the right (`VoteButton shape="box"`: chevron over
    the count, 52×58; voted, soft green with a green edge; a completed idea's a green-tinted box with a check). Under the
    default list "That's all N ideas still to come in <board>. Share yours"; under a search's results "Not here? Post it".
    The rail, nothing else competing with the list: **New idea** (the page's one filled button; it opens the board's form
    in a dialog, `NewIdea`, open as the page loads with `?title=` or `?new`; signed out its title and "Sign in to post",
    which comes back with the title; without JavaScript the old box is in the page; after a search that found nothing it
    reads "Not here? Post it", and the empty list has "Post it as a new idea"), Boards in a card (the open one soft green),
    and the latest shipped idea as one line ("Shipped 9 Nov: <title>"; the rest under Completed in the status menu).
    Phones: New idea beside the title, no card, the status menu's count without its words, the shipped line and Get
    updates under the list.
  - **A post**: back link, a 38px title (28px on phones), the byline, then the status pill and "Expected <month>" with a
    calendar, the body at 17px. The rail is one card: **Upvote** filled with the count after a rule (`shape="upvote"`;
    voted, "Upvoted" in soft green), Subscribe an outline with "Get an email when it ships." under it (Unsubscribe quiet, without the line), the voters' faces, Board and Posted as
    rows, Copy link and Share (the device's share sheet, where it has one), "Have another idea? Post it". On phones the
    same actions in a row under the body (Copy link and Share as icon buttons), the voters under them. Signed out, one
    "Join the conversation" bar (Sign in) above the thread instead of a comment box. In the thread, the team's replies
    on a soft green fade with a green rule and the Team badge, status changes as rows with the status's icon and pill.
  - **Comment threads** (the portal's post and the team's): "N comments" with "Oldest first ▾" at its right (Newest
    first; kept in the address as `?sort=newest`, shown once there are two). Under each comment **Reply** and a heart
    with its count ("Like" at none; liked, filled green); signed out, both are links to sign in, as voting is. Replies
    are one level deep: indented to the comment's words, oldest first under it whichever way the thread is sorted;
    Reply on a reply answers the same comment. Reply opens one box under the thread's last reply ("Reply to <name>…",
    Cancel and Reply). A comment whose parent is gone (its author's account deleted, Autopilot's comment undone) stays,
    as a comment of its own. Internal notes have neither: only the team sees them.
  - **The roadmap**: a 48px title, its line with "Sign in to vote." after it, New idea at the right (to a board's
    dialog, or a pick of boards), the boards as chips (All boards first), a line, then three open columns headed by
    the status's icon, name and count, its meaning and a line; a card per idea (the board, the title, two lines,
    "Expected <month>", the poster, the comment count and a vote chip, `shape="chip"`; "In the changelog →" on a
    shipped one). On phones one column at a time, picked from a segmented control over them (`?column=`).
  - **The changelog**: a 48px title and "What's new, improved and fixed in <project>.", then one row: the tags as text
    tabs (links, `?tag=`, only the tags its entries have) and RSS (outline) and **Subscribe** (filled; a popover with
    the email form) at its end (above the tabs on phones). On wide screens a timeline: each entry's short date and a dot
    on a line in a 110px margin; beside it the tag (New soft green, Improved blue, Fixed the orange highlight, Breaking
    destructive) above a 28px title, the cover framed as a card, the text, "Built from an idea · N votes →" (with more than one idea, each pill shows its title; with one, the title is read out after the pill's words)
    it shipped, and its reactions, small and grey until picked; a line between entries. A "Jump to month" index beside
    the list past eight entries (the page's month marked): the latest six months, older ones under "Earlier months" (open when the page's month is among them). An entry's page: a 40px title, the reactions, then Get
    updates by email.
  - **Sign-in**: one card (max-w-sm, the width and offset of every sign-in page) under the portal's mark (its logo, or the letter square), "Sign in to <project>",
    "Vote, comment and follow ideas. We'll email you when they ship.", the email with a mail icon, **Email me a sign-in
    link**, "Use a password instead · Forgot your password?", then under a line "New here? Create an account" and
    "Team member? Sign in with Tuti".
  - **One-message pages** (the changelog's email links, unsubscribe, the SSO error, a page not found):
    one card (`PortalMessage`, max-w-sm) with a tinted icon, a 20px heading-font title, 15px text and
    full-width buttons, centred in the page. The 404 is the portal's (`not-found.tsx`), in its header
    and footer, no part marked, with links to Roadmap, Changelog and Docs. Sign-in pages (sign-in,
    forgot password, the link's page, the SSO error) are the same width at one fixed offset under the
    header, which has no Sign in there; the SSO error says it in plain words first, the technical
    detail as a small footnote, "Try again" its primary.
  - **Docs** has one box for searching and asking, the header's ("Search or ask AI" with AI answers on, ⌘K; below
    tablet width a line of its own, the whole width). Searching never happens in the box itself: it opens the search
    dialog (`DocsSearchBox`), where "Ask AI" hands the question to the assistant, and before anything's typed "Open the
    assistant" goes back to the conversation as it was. The assistant is the widget's, the one conversation with AI
    answers: the portal opens its own widget with it (`Tuti.open({ ask })`), and has no panel of its own. Its results
    page says what it's for ("Results for “invoice”"), the first tab marked. On phones and tablets the header's menu
    button (`PortalMenu`) opens a full-screen menu with the parts (phones), the current part's navigation (the docs'
    tree, the boards) and the team's links. The header and the part's row stay at the top as the page scrolls, phones
    included (`PortalTop`; their height is `--portal-header-height`).
  - **The docs home** (a tab's overview): centred, over a soft green glow, the team's title (default "How can we
    help?") and subtitle, the big box (from tablet width, where the header's is hidden: the same box) with ⌘K and
    **Ask AI** at its end, and the three most-read articles as chips; then a card per collection (its icon and name on
    one row, the description, how many articles the reader may open at the bottom; two per row), Popular articles as a
    card in two columns (three or more, a tab's own), the articles in no collection, and "Can't find it?" (Contact us)
    where the project answers messages. The overview takes the container's width.
  - **Content first.** A page's core content gets the room it needs before anything goes beside it: a long read (an
    article with sections) about 70 characters a line, 64 at least from 1280px up. Short pages and lists stay as compact as
    reads best (a wider short article or collection only stretched, in blind reviews): the measure is what the visitor
    came for, not a share of the screen. Side columns
    are slim and quiet (muted type, nothing heavier than a hairline competing with the content); what a reader may want but
    didn't come for sits one click away (a menu, a disclosure) rather than in another column.
  - **An article**: the tab's tree on the left (`DocsLayout`, 16rem, a line beside it the page's height): each
    collection a row with its icon that opens (`<details>`), the page's own open with a line down its articles and the
    current one soft green; the articles in no collection under a line. Then "Docs › <collection>" with Reading mode (a ghost book icon, named in its tooltip; from tablet
    width, on an article with sections) and Copy page at
    the row's end, a 42px title, "Updated <date> · N min read" (about 200 words a minute), and the text at 17px (`article-text` on top of `rich-text`): 26px section headings, steps numbered in soft green circles, inline code on
    a sunken chip, code blocks as cards (a labelled one with its label in a strip, and Copy: `CodeCopyButtons`), quotes
    as callouts (an info-blue rule and icon on the card's surface). At its end: "Was this helpful?" (Yes and No with
    thumbs), Previous and Next cards, Related articles, and "Still stuck?" (Ask AI and Contact us, outlines). With two or more
    sections, "On this page" on the right from 1280px (13rem, the section being read marked). Every docs page uses
    the same desktop container (79rem, the header 82rem) so navigation keeps the logo, tree and article's left edge in place.
    The text keeps 65–70 characters a line between the two (a 46rem column; 64ch
    at 1280px); below 1280px "On this page" is a compact menu under the title. Without sections the text is a 43rem
    column, aligned to the same left edge beside the tree from 1280px, with the outline's column left empty; below that it stays centred beside the tree.
    **Reading mode** hides the tree and "On this page", leaving the article alone; the same
    button (pressed, soft green) brings them back. Remembered per browser (`localStorage`, set on `<html>` before the
    page shows, `lib/docs-reading.ts`). A collection's page: its icon and name, a card
    of its articles (rows with a chevron), then a card per collection in it.
- **Widget panel** (`/widget` on the portal, framed on customers' sites; floating on the portal it stays below the portal's
  header, `--portal-header-height`, so the header's buttons stay in reach): a
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
  Light or dark as the portal's colour scheme says (Settings → Branding; by default the visitor's
  device), unless the site picks one (`data-theme`, or `Tuti.setTheme` later), which every panel takes,
  from its first paint, and the button unless it has its own colour (Settings → Widget).
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

- **`PageHeader`** (Docs uses `DocsPageHeader` and its pinned editor layout above; elsewhere `title`, `back`, `description`, `meta`, `actions`, `more`): the top of every page,
  its title the page's heading at every width (the Page title style), `back` above it, then
  `description`: one short muted line saying what the page is for ("Ideas and problems your
  users posted, by status."; on portals the team's own words), on a section's main page
  (Feedback, Roadmap, Docs; a page of panes has `PaneHeader`'s instead), not on a page
  about one thing; then `meta`, facts about the thing shown ("#12 · Ada · 3 votes").
  The actions sit beside the title and description, on the right, from tablet width up.
  `more` is the actions used less often, behind "More actions".
  An editor whose title field shows the title (an article, a changelog entry) keeps the
  heading for screen readers only (`titleInForm`), with the back link and actions in one compact row.
  In the app on phones the actions are a "More actions" menu from the top bar (`PageActions`). A page whose
  every visit needs them keeps them in reach. Inbox conversations keep Close, More actions and details in their pane header;
  Assign and Snooze are in the details card or phone sheet. An editor whose
  main action must stay in reach (Save and Publish) pins `actions` (`pinActions`): to a
  bar at the bottom of the screen on phones, the menu keeping `more`, and beside the title
  in the page’s sticky header from tablet width up;
  the bar steps aside while text is being typed (the keyboard is up then).
  Where Tuti's own chat launcher shows in the app (its cloud), what's held at the
  bottom of the screen keeps its buttons clear of the launcher's corner
  (`launcher:`): a bar (that one, Autopilot's Approve) stops them left of it, a
  row more if they need it. The launcher isn't in the Inbox or on Settings' Portal pages (`AppWidget`), so
  the Inbox's reply box needs no room for it.
  It assumes the launcher at the bottom right, where Tuti's help project keeps it:
  moved to the left (Settings → Widget), `launcher:` would need its side too.
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
    away (the action done, Clear), focus moves to the first filter (Feedback: its Filters button, once its
    transitions are done: `invisible` takes `visibility` with them, and a hidden button can't take focus). Each is done as it is
    for one; what fails is said, the rest still go. What emails people
    (Completed) or can't be undone (Merge) asks first, naming how many.
  - Feedback's rows (`PickedRow`), the same at every width: the votes in a small bordered box (`VoteBox`); the
    board as a small uppercase label over the title (17px semibold), a line of the post, then who · when · comments;
    at the right the owner's face (tablet width up) and the status menu, a quiet "⋯" (`PostStatusMenu
    badge={false}`): the tab says the status, and All, when it mixes them, is grouped under each status (its dot,
    name and count) in the tabs' order. Where no tab or group heading names the status (Possible duplicates, a tab
    only while there are some; All while it isn't grouped: one status, or more to load) the pill opens the menu. By itself the page (header, toolbar, list)
    is a column of at most 72rem at the shell's left edge, so a row's title and its "⋯" stay close on a wide screen; a post open
    beside it, the whole width, with the same left edge. Above the list, on a page 64rem wide or more (the page's width, not the list's: the same
    with a post open or not), one toolbar row (the job is triage: nothing else between the tabs and the rows): the status tabs on the left (scrolling sideways when short of room), the search and one "Filters"
    button on the right (a popover with Board, Voters and the sort; how many are set on it). The row is the same height
    whether or not a post is open (the list never moves as one opens): beside a post the statuses are the first
    three tabs and More (reading as the one of the rest that's open, as the Inbox's), so Needs triage stays in sight,
    the search is narrower ("Search") and Filters its icon. Picked rows' bar takes the whole row. Boards, used less, is in the header's "…"
    menu, New post the one button beside it. On a narrower page the tabs are above the search and Filters (and, on phones,
    "+ New"); while rows are picked, their bar replaces only that search line, keeping the status tabs visible and usable.
  - A post's vote count, first in its row, has the vote arrow over it (and
    "votes" for screen readers), so it doesn't read as a bare number (`VoteCount`, `VoteBox`).
  - Compact actions (a badge, one or two small buttons) stay on the right.
  - Pickers or several buttons → `wideActions`: on phones they move under the
    title and share the row width. Give select triggers `w-full sm:w-…`.
  - A card or a pane's section listing several kinds of thing (Home's "Needs your attention", a section on its pane)
    groups them by kind, the most urgent first: each a heading with how many,
    its first few rows, the longest waiting first (or, where its list shows only the top few, as that list ranks them; Autopilot's, To review's first rows in its order, so the two read the same), and a link to that list ("See all" when it holds them all, else named for where it goes); no kind badge per row.
- A list compared across columns is a table, in a `Card` on a page or straight on its pane (Users' People and
  Companies, the pane's whole width): its headings
  sort it (a link each, `aria-sort` on the one in use, the most first; a rate whose low end is what needs the team,
  Reporting's Articles' Found it helpful, the least first and marked ascending), and on
  phones it keeps who and the column that matters most (Last seen), the rest
  from tablet width up (Users' phone row: name, email, then "company · seen …", with no header row, so no sort links
  sit unseen in the tab order). Which properties it shows is the team's pick
  (Columns), kept for everyone.
- **`EmptyState`**: what a list shows when it's empty. Say what's missing and
  what to do next; add an `action` when there's an obvious one.
- **`Card`** with `CardHeader`/`CardTitle`/`CardDescription`: a settings section
  or form. One topic per card.
- **`RichEditor bare`**: long writing (docs articles, changelog entries, new
  posts) is written as it's published, without a box; the title above it is a
  borderless `BARE_TITLE` input set like the published heading. Docs articles
  keep a pinned formatting row; changelog entries and posts have no toolbar.
  All keep the selection bar, Ctrl/⌘+K for a link, and the block menu that typing
  / at the start of a line opens (the empty line being written says so).
  Comments keep the boxed editor with its toolbar.
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

### Panes (the admin's new layout)

The admin is moving, area by area, to one layout shared with every page: the sidebar and the page on the shell's canvas
(the sidebar's colour, no line between them), the page made of white panes 8px apart. Each area moves to these once,
in its own change; until then its page keeps `PageHeader` and the rest below. `/app/design/panes` shows them together,
at desktop and phone widths, in light and dark (in development only).

- **`PaneLayout`**, **`Pane`**, **`PaneBody`** (`components/pane.tsx`): a row of panes (the shell gives it the whole
  width), one white panel (`rounded-2xl`, ~14px corners, a `border` ring, nothing scrolling past its edge), and what scrolls in it.
  No card inside a card: a pane's lists and row cards sit on the pane. Two exceptions, both data to read at a glance: `StatStrip`, and Reporting's charts and tables, each its own bordered section on the report's pane.
  A pane body scrolls in place of the window, so it keeps its place on each URL for Back and Forward; one whose own
  links replace its list (Users' pages, sorts, searches) starts at the top on a new URL (`resetOnNavigate`).
- **`PaneHeader`** (`title`, `back`, `description`, `filters`, `actions`, `level`, `titleInForm`): a pane's one-row header, 60px, a line
  under it. The title in the heading font at 20px; with `back`, "All posts ›" before it (the title then in body
  type), and on phones "‹ All posts" alone, the title for screen readers. `description` follows the title from 56rem
  of the shell up ("· Your project's name…"). `filters` are pills after the title, on phones a row of their own under
  it. `actions` at the right end: round icon buttons (`outline`, `icon-sm`, with an `aria-label`) and at most one
  primary button. Its title is the page's `h1`; `level={2}` on a list's pane while the open item beside it has
  the page's heading (Autopilot's list, the Inbox's), so a page has one `h1`.
  An editor whose title field shows the title (a changelog entry) sets `titleInForm`: the heading is for screen
  readers at every width, the way back "‹ All entries" alone, and the phone's top bar never names the page (the title
  shows once, the one to edit).
- **`SectionPane`**, **`SectionGroup`**, **`SectionLink`**: an area's own menu (Feedback's views, boards and
  statuses; Settings' pages): a 248px pane titled by the area, its actions (search, +) beside the title; groups under
  a quiet sentence-case label (13px, muted; never capitals); each link an icon or a colour dot, its title and a count.
  The open one is a neutral fill (`accent`), so a page shows one green, its primary action. On phones the pane is
  hidden and the pane header's menu button opens it as a drawer from the left, with a Close; it closes as the URL
  changes or the shell gets wide enough to show the pane beside the page. One link is open, the one the URL is on (views in the query
  string too); the pane finds its links in its children, so a client component that renders SectionLinks hides them
  (pass them as elements, or give them `active`).
- **`FilterPills`** (`pillClass` for a pill that isn't a link): a page's views as rounded pills with counts, the open
  one filled; one row that scrolls sideways when it doesn't fit, like `SubNav`'s.
- **`ItemGroup`**: a list's group (posts by status): a tinted (`muted`) bar with its icon, title and count that folds
  what's under it.
- **`SettingsCard`** + **`SettingRow`** (`label`, `description`, `htmlFor`, `inline`): settings as one card of rows,
  the label and a line on what it does on the left, the control on the right. In a card under 34rem wide the control
  goes under them at the card's width; `inline` keeps a short control (a switch, a button) on the right.
- **A pane of one form or settings** (New project, Setup, Account, the first Welcome): one `Pane` with its
  `PaneHeader`, the body centred in it, max-w-2xl for a form's card (a wizard's step above it), max-w-3xl for
  settings cards, as Settings' pages.
- **`StatStrip`**: a page's numbers in one card, side by side between lines; under 40rem two tiles to a row. A number
  with `href` opens its list (the whole number, named "Need a reply: 4"); `attention` (people waiting) in the highlight colour with its dot.
- **Pill buttons**: every `Button` in the admin is a pill (`--button-radius`, set while the sidebar's shell is on
  the page: its dialogs and menus too), and inside `data-pill-buttons`. Elsewhere (the portal, marketing) buttons
  keep their corners.
- **The shell**: the sidebar sits on the canvas with no line beside it. A page of the new panes (`PaneLayout`) sits
  on that canvas too, 8px in, the window's height from tablet width up; a page not yet moved keeps its own background.
- **Phone tab bar** (`AppTabBar`): on phones Home, Inbox, Feedback and Autopilot sit at the bottom of the screen, each
  with the sidebar's count, and More opens the sidebar as a menu for the rest. The open part's tab is a raised white
  pill (Feedback on the Roadmap; More on a part without a tab). It shows on a part's lists only: a page of one thing
  (a post, a conversation, an article, a review), a new one, its history and a settings page of its own (Settings'
  (its Portal pages too), a collection's) have the screen to themselves and their way back, as does a page that pins its actions
  to the bottom. A view inside a list's page (`?view=`) keeps the bar with the page. Docs has none: it has its own
  phone navigation, and its workspace is the window's height, scrolling inside. Tuti's own chat launcher sits above it.

## Responsive rules

- Design for 390px first; nothing may overflow or squeeze text to nothing.
- In a row, text gets the space and controls move below it on phones
  (`ItemRow wideActions`), never the other way round.
- Long user content (titles, emails, URLs) wraps (`break-words` / `break-all`;
  `wrap-anywhere` where it sits in a grid that sizes to it, such as a dialog's
  title, which `break-words` doesn't shrink).
- Filters wrap onto more lines; they don't scroll sideways. A pane header's views (`FilterPills`) are one row that scrolls, like `SubNav`'s tabs.

## Interaction

- One primary button per screen or dialog, on the right; Cancel to its left.
  A section's create button in its header is that primary ("New entry", "Add
  content", "New post") unless an open item beside it has its own: then it's
  outline. "View on portal" beside it is an outline button in words, not a bare icon (an editor keeps it in words under
  "More actions").
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

- **Marketing copy** (the home page): short and confident. Headlines and lines sell outcomes with no plan
  names, limits, thresholds or "with your approval"-style qualifiers; which plan has what lives on /pricing, and
  the details in the help center. Sell only what's shipped, never hedge it.
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
