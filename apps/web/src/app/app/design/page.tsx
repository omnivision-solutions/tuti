import { ExternalLinkIcon, MergeIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { BackLink } from "@/components/back-link";
import { BoardSearch } from "@/components/board-search";
import { DnsRecords, SetupStep, SetupSteps, SetupValue, WaitingNotice } from "@/components/dns-setup";
import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow, VoteCount } from "@/components/item-list";
import { PortalPageHeader } from "@/components/portal-page-header";
import { PostStatusBadge, STATUS_LABELS } from "@/components/post-status-badge";
import { TutiLogo, TutiMark } from "@tuti/ui/tuti-logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const metadata: Metadata = { title: "Design — Tuti" };

const COLORS = [
  ["background", "bg-background"],
  ["card", "bg-card"],
  ["muted", "bg-muted"],
  ["border", "bg-border"],
  ["primary", "bg-primary"],
  ["soft", "bg-soft"],
  ["highlight", "bg-highlight"],
  ["destructive", "bg-destructive"],
] as const;

const BOARDS = { feature: "Feature requests", bugs: "Bug reports" };

/**
 * Dev-only gallery of the design system (docs/design.md), in light and dark
 * side by side. Check new patterns here at phone and desktop widths.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="grid lg:grid-cols-2">
      <Gallery mode="light" />
      <Gallery mode="dark" />
    </div>
  );
}

function Gallery({ mode }: { mode: "light" | "dark" }) {
  return (
    <div className={`${mode} bg-background text-foreground`}>
      <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-10">
        <div className="flex items-center justify-between">
          <TutiLogo />
          <span className="text-xs text-muted-foreground uppercase">{mode}</span>
        </div>

        <Section title="Colour">
          <div className="grid grid-cols-4 gap-3">
            {COLORS.map(([name, className]) => (
              <div key={name} className="flex flex-col gap-1">
                <div className={`h-12 rounded-lg border ${className}`} />
                <span className="text-xs text-muted-foreground">{name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type">
          <p className="font-heading text-4xl font-bold tracking-tight">Display · Bricolage</p>
          <p className="font-heading text-2xl font-bold tracking-tight">Page title · 2xl bold</p>
          <p className="font-heading text-base font-semibold">Section title · base semibold</p>
          <p>Body · Figtree 15px. Tell us what you want — we&apos;ll repeat it back.</p>
          <p className="text-sm text-muted-foreground">Secondary · sm muted</p>
          <p className="text-xs text-muted-foreground">Meta · xs muted · #12 · Alexandra · 3 comments</p>
          <p className="group-label">Group label · group-label</p>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small</Button>
            <Button size="sm" variant="outline">
              <MergeIcon />
              With icon
            </Button>
            <Button size="sm" disabled>
              Disabled
            </Button>
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((status) => (
              <PostStatusBadge key={status} status={status} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="highlight">Possible duplicate</Badge>
            <Badge>Owner</Badge>
            <Badge variant="secondary">Member</Badge>
            <Badge variant="destructive">Error</Badge>
          </div>
        </Section>

        <Section title="Form">
          <Card>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`${mode}-title`}>Title</FieldLabel>
                  <Input id={`${mode}-title`} placeholder="Short, descriptive title" />
                  <FieldDescription>Helper text sits under the field.</FieldDescription>
                </Field>
                <Field>
                  <p className="text-sm font-medium">Portal board search</p>
                  <div className="[--radius:0.625rem]">
                    <BoardSearch action="/app/design" q="" />
                  </div>
                  <FieldDescription>40px on phones, 44px from 640px; 14px corners and the page&apos;s fill.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Board</FieldLabel>
                  <Select items={BOARDS} defaultValue="feature">
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(BOARDS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="flex justify-end gap-2">
                  <Button variant="outline">Cancel</Button>
                  <Button>Save</Button>
                </div>
              </FieldGroup>
            </CardContent>
          </Card>
        </Section>

        <Section title="Page header">
          <div className="flex flex-col gap-4 rounded-xl border border-dashed p-4">
            <PortalPageHeader
              back={<BackLink href="/app/design">Feedback</BackLink>}
              title="Dark mode for the dashboard"
              description="#12 · Alexandra · 2 hours ago · 42 votes"
              actions={
                <a href="#" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <ExternalLinkIcon />
                  View on portal
                </a>
              }
            />
          </div>
        </Section>

        <Section title="Lists">
          <Card size="sm">
            <CardContent>
              <ItemList>
                {/* Picked (its box ticked), then picked and open beside the list: tints with darker meta. */}
                <ItemRow
                  wideActions
                  picked
                  leading={<VoteCount count={42} />}
                  title="Night theme please"
                  badges={<Badge variant="highlight">Possible duplicate</Badge>}
                  meta="#31 · Sam · 2 comments"
                  actions={
                    <>
                      <DemoSelect value="feature" />
                      <DemoSelect value="bugs" />
                    </>
                  }
                />
                <ItemRow
                  wideActions
                  picked
                  selected
                  leading={<VoteCount count={7} />}
                  title="Upload fails for files larger than 2GB on slow connections"
                  meta="#30 · Alexandra Montgomery-Smith"
                  actions={
                    <>
                      <DemoSelect value="bugs" />
                      <DemoSelect value="feature" />
                    </>
                  }
                />
              </ItemList>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent>
              <ItemList>
                <ItemRow
                  leading={
                    <Avatar className="size-8">
                      <AvatarFallback>P</AvatarFallback>
                    </Avatar>
                  }
                  title="Praveen (you)"
                  meta="praveen@example.com"
                  actions={<Badge>Owner</Badge>}
                />
                <ItemRow
                  title="Feature requests"
                  meta="/feedback/feature-requests · 12 posts"
                  actions={
                    <Button variant="ghost" size="sm">
                      Edit
                    </Button>
                  }
                />
              </ItemList>
            </CardContent>
          </Card>
        </Section>

        <Section title="Cards and empty states">
          <Card>
            <CardHeader>
              <CardTitle>Single sign-on (JWT)</CardTitle>
              <CardDescription>A settings section: title, one-line description, then content.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">Content goes here.</CardContent>
          </Card>
          <EmptyState
            title="No feedback yet"
            description="Share your portal with users, or connect your app with single sign-on in Settings."
            action={<Button size="sm">Copy portal link</Button>}
          />
        </Section>

        <Section title="Setup steps">
          <SetupSteps>
            <SetupStep title="Domain" state="done" status={<Badge variant="outline">Waiting for DNS</Badge>}>
              <SetupValue>help.example.com</SetupValue>
            </SetupStep>
            <SetupStep title="DNS records" state="current" description="Add these records at your domain's DNS provider, then check.">
              <WaitingNotice>Waiting for your DNS records. Changes can take a few minutes to show.</WaitingNotice>
              <DnsRecords
                label="DNS records for help.example.com"
                records={[
                  { type: "CNAME", name: "help.example.com", value: "customers.tuti.so", status: "pending" },
                  { type: "TXT", name: "_tuti.help.example.com", value: "tuti-verify=3f9a1c2b7d4e8f60a5b1c9d2e7f4a8b3", status: "verified" },
                ]}
              />
              <div>
                <Button>Check DNS</Button>
              </div>
            </SetupStep>
            <SetupStep title="Live" state="upcoming" description="Your portal answers at help.example.com once its records are in." />
          </SetupSteps>
        </Section>

        <Section title="Portal footer">
          <p className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            Powered by
            <TutiMark className="size-4" />
            <span className="font-heading font-bold text-foreground">tuti</span>
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  );
}

function DemoSelect({ value }: { value: keyof typeof BOARDS }) {
  return (
    <Select items={BOARDS} defaultValue={value}>
      <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Board">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(BOARDS).map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
