import type { PostStatus } from "@tuti/db";
import { ArrowDownUpIcon, BugIcon, CopyIcon, InboxIcon, LightbulbIcon, ListFilterIcon, MapIcon, PlusIcon, SearchIcon, Settings2Icon, SparklesIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FilterPills } from "@/components/filter-pills";
import { ItemGroup, ItemList, ItemRow, VoteCount } from "@/components/item-list";
import { Pane, PaneBody, PaneHeader, PaneLayout, SectionGroup, SectionLink, SectionPane } from "@/components/pane";
import { STATUS_LABELS, StatusIcon } from "@/components/post-status-badge";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { StatStrip } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export const metadata: Metadata = { title: "Panes — Tuti" };

const POSTS: [PostStatus, [string, string, number][]][] = [
  ["IN_PROGRESS", [["Google Calendar sync", "Feature requests · 4 comments", 41], ["Recurring events", "Feature requests · 3 comments", 34]]],
  ["PLANNED", [["Dark mode", "Feature requests", 27], ["Month view cuts off long titles", "Bug reports · 1 comment", 4]]],
  ["UNDER_REVIEW", [["Export events to CSV", "Feature requests", 12]]],
];

/**
 * Dev-only gallery of the admin's panes (docs/design.md → Panes): an area's section pane beside a list, and settings,
 * on the shell's canvas with pill buttons, at desktop and phone widths, in light and dark.
 */
export default function PanesPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <div className="flex flex-col">
      <Mode mode="light" />
      <Mode mode="dark" />
    </div>
  );
}

function Mode({ mode }: { mode: "light" | "dark" }) {
  return (
    <div className={`${mode} flex flex-wrap items-start gap-6 bg-background p-6 text-foreground`}>
      <Frame width="72rem">
        <Feedback />
      </Frame>
      <Frame width="390px">
        <Feedback />
      </Frame>
      <Frame width="72rem">
        <Settings />
      </Frame>
      <Frame width="390px">
        <Settings />
      </Frame>
    </div>
  );
}

/** The shell's canvas (the sidebar's colour), as wide as a window of `width`, with the app's pill buttons. */
function Frame({ width, children }: { width: string; children: React.ReactNode }) {
  return (
    <div data-pill-buttons className="@container/app flex h-[46rem] overflow-hidden rounded-xl bg-sidebar p-2 ring-1 ring-border" style={{ width }}>
      {children}
    </div>
  );
}

function FeedbackMenu({ on }: { on: string }) {
  return (
    <SectionPane
      title="Feedback"
      actions={
        <Button variant="ghost" size="icon-sm" aria-label="Search">
          <SearchIcon />
        </Button>
      }
    >
      <SectionGroup>
        <SectionLink href="#all" icon={<InboxIcon />} count={38} active={on === "all"}>
          All posts
        </SectionLink>
        <SectionLink href="#triage" icon={<SparklesIcon />} count={2} active={false}>
          Needs triage
        </SectionLink>
        <SectionLink href="#roadmap" icon={<MapIcon />} active={false}>
          Roadmap
        </SectionLink>
      </SectionGroup>
      <SectionGroup label="Boards" action={<PlusIcon aria-label="New board" className="size-4" />}>
        <SectionLink href="#features" icon={<LightbulbIcon />} count={29} active={false}>
          Feature requests
        </SectionLink>
        <SectionLink href="#bugs" icon={<BugIcon />} count={9} active={false}>
          Bug reports
        </SectionLink>
      </SectionGroup>
      <SectionGroup label="Statuses">
        {POSTS.map(([status, posts]) => (
          <SectionLink key={status} href={`#${status}`} icon={<StatusIcon status={status} />} count={posts.length} active={false}>
            {STATUS_LABELS[status]}
          </SectionLink>
        ))}
      </SectionGroup>
      <SectionGroup label="Smart views">
        <SectionLink href="#duplicates" icon={<CopyIcon />} count={3} active={false}>
          Possible duplicates
        </SectionLink>
      </SectionGroup>
    </SectionPane>
  );
}

function Feedback() {
  return (
    <PaneLayout>
      <FeedbackMenu on="all" />
      <Pane aria-label="Posts">
        <PaneHeader
          title="All posts"
          filters={
            <FilterPills
              label="Views"
              current="#all"
              items={[
                { title: "All", href: "#all", count: 38 },
                { title: "Not done yet", href: "#open", count: 11 },
                { title: "Mine", href: "#mine", count: 4 },
              ]}
            />
          }
          actions={
            <>
              <Button variant="outline" size="icon-sm" aria-label="Filter">
                <ListFilterIcon />
              </Button>
              <Button variant="outline" size="icon-sm" aria-label="Sort">
                <ArrowDownUpIcon />
              </Button>
              <Button size="sm">
                <PlusIcon />
                New post
              </Button>
            </>
          }
        />
        <PaneBody className="flex flex-col gap-1 p-3">
          {POSTS.map(([status, posts]) => (
            <ItemGroup key={status} icon={<StatusIcon status={status} />} title={STATUS_LABELS[status]} count={posts.length}>
              <ItemList className="px-3">
                {posts.map(([title, meta, votes]) => (
                  <ItemRow key={title} title={title} meta={meta} actions={<VoteCount count={votes} />} className="py-2.5 first:pt-2.5 last:pb-2.5" />
                ))}
              </ItemList>
            </ItemGroup>
          ))}
          <ItemGroup icon={<StatusIcon status="COMPLETED" />} title="Completed" count={27} defaultOpen={false}>
            <p className="px-3 py-2 text-sm text-muted-foreground">27 posts</p>
          </ItemGroup>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}

function Settings() {
  return (
    <PaneLayout>
      <SectionPane title="Settings">
        <SectionGroup label="Project">
          <SectionLink href="#general" icon={<Settings2Icon />} active>
            General
          </SectionLink>
          <SectionLink href="#team" icon={<UsersIcon />} active={false}>
            Team & roles
          </SectionLink>
        </SectionGroup>
      </SectionPane>
      <Pane aria-label="General">
        <PaneHeader title="General" description="Your project's name, address and defaults" actions={<Button size="sm">Save changes</Button>} />
        <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
          <div className="mx-auto flex max-w-3xl flex-col gap-7">
            <StatStrip
              items={[
                { label: "Live articles", value: 13 },
                { label: "Views, 30 days", value: "7,431" },
                { label: "Found it helpful", value: "76%" },
                { label: "Searches, no answer", value: 96 },
              ]}
            />
            <SettingsCard>
              <SettingRow label="Project name" description="Shown on your portal, in its emails and in the app." htmlFor="demo-name">
                <Input id="demo-name" defaultValue="Acme Calendar" aria-describedby="demo-name-description" className="sm:w-60" />
              </SettingRow>
              <SettingRow label="Portal address" description="acme-calendar.tuti.so" inline>
                <Button variant="outline" size="sm">
                  Change
                </Button>
              </SettingRow>
              <SettingRow label="Let members invite people" description="Otherwise only admins can." inline>
                <Switch aria-label="Let members invite people" />
              </SettingRow>
            </SettingsCard>
            <SettingsCard title="Danger zone">
              <SettingRow label="Delete project" description="Deletes posts, articles, conversations and users for good." inline>
                <Button variant="destructive" size="sm">
                  Delete
                </Button>
              </SettingRow>
            </SettingsCard>
          </div>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
