"use client";

import { CheckIcon, ClockIcon, CopyIcon } from "lucide-react";
import { Fragment, type ReactNode, useId } from "react";

import { copyText } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A setup's steps down a line: what's done, what to do now, what comes after. */
export function SetupSteps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col">{children}</ol>;
}

/**
 * One of `SetupSteps`: its marker on the line (a tick once it's done), its title with its `status`
 * beside it, what it's about, `aside` at its right (a shortcut; under it on phones), then what it
 * needs. A region named by its title.
 */
export function SetupStep({
  title,
  state,
  status,
  description,
  aside,
  children,
}: {
  title: string;
  state: "done" | "current" | "upcoming";
  status?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <li aria-current={state === "current" ? "step" : undefined} className="group/step relative flex gap-4 pb-8 last:pb-0">
      {/* The line down to the next step. */}
      <span aria-hidden className="absolute top-7 bottom-1 left-3 w-px -translate-x-1/2 bg-border group-last/step:hidden" />
      <span
        aria-hidden
        className={cn(
          "relative flex size-6 shrink-0 items-center justify-center rounded-full",
          state === "done" ? "bg-primary text-primary-foreground" : state === "current" ? "border-2 border-primary bg-card" : "border-2 border-border bg-card",
        )}
      >
        {state === "done" ? <CheckIcon className="size-3.5" strokeWidth={3} /> : state === "current" && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <section aria-labelledby={id} className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={id} className={cn("text-base leading-6 font-semibold", state === "upcoming" && "text-muted-foreground")}>
                {title}
              </h3>
              {status}
            </div>
            {description && <div className="text-sm text-muted-foreground">{description}</div>}
          </div>
          {aside && <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>}
        </div>
        {children}
      </section>
    </li>
  );
}

/** The value a step is about once it's given (a domain, an address), as it was typed. */
export function SetupValue({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border bg-muted/50 px-3 py-2 text-sm font-medium break-all">{children}</div>;
}

/** Where something stands, as far as Tuti has checked: no status where nothing checks it. */
export type DnsStatus = "verified" | "pending" | "failed";

export type DnsRecord = { type: string; name: string; value: string; status?: DnsStatus };

const STATUS: Record<DnsStatus, { label: string; className: string }> = {
  verified: { label: "Verified", className: "bg-soft text-soft-foreground" },
  pending: { label: "Pending", className: "bg-highlight text-highlight-foreground" },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive-foreground dark:bg-destructive/20" },
};

/** A record's status, a small pill: green once found, beak-orange while waited for, red if it failed. */
export function DnsStatusPill({ status }: { status: DnsStatus }) {
  return <span className={cn("inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium", STATUS[status].className)}>{STATUS[status].label}</span>;
}

/** What a step waits for (records to show in DNS, a certificate), in the highlight colour. */
export function WaitingNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-highlight-foreground/20 bg-highlight px-3 py-2 text-sm text-highlight-foreground">
      <ClockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

const CELL =
  "px-3 align-top sm:py-2.5 max-sm:flex max-sm:items-baseline max-sm:gap-2 max-sm:before:w-14 max-sm:before:shrink-0 max-sm:before:text-xs max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]";

/**
 * DNS records to add, as a DNS provider's form asks for them: type, name, content, TTL, and each one's
 * status where Tuti checks it. Each name and content can be selected, or copied with its button. On
 * phones each record is a block, its parts labelled (every cell kept, so screen readers pair each
 * with its heading).
 */
export function DnsRecords({ records, label }: { records: DnsRecord[]; label: string }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <table aria-label={label} className="w-full text-sm sm:table-fixed">
        <thead className="bg-muted/60 text-left text-xs text-muted-foreground max-sm:sr-only">
          <tr>
            <th className="w-20 px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Content</th>
            <th className="w-16 px-3 py-2 font-medium">TTL</th>
            <th className="w-24 px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {records.map((record) => (
            <tr key={`${record.type} ${record.name}`} className="max-sm:flex max-sm:flex-col max-sm:gap-1.5 max-sm:py-3">
              <td data-label="Type" className={cn(CELL, "font-mono text-xs sm:pt-3")}>
                {record.type}
              </td>
              <td data-label="Name" className={CELL}>
                <CopyValue value={record.name} label={`${record.type} name`} />
              </td>
              <td data-label="Content" className={CELL}>
                <CopyValue value={record.value} label={`${record.type} content`} />
              </td>
              <td data-label="TTL" className={cn(CELL, "font-mono text-xs text-muted-foreground sm:pt-3")}>
                Auto
              </td>
              <td data-label="Status" className={cn(CELL, "sm:pt-2.5", !record.status && "max-sm:sr-only")}>
                {record.status && <DnsStatusPill status={record.status} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Labelled values to copy, a row each (an address to forward, and where to). */
export function CopyRows({ rows, label }: { rows: { label: string; value: string; name: string }[]; label: string }) {
  return (
    <dl aria-label={label} className="divide-y rounded-lg border text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline gap-3 px-3 py-2">
          <dt className="w-14 shrink-0 text-xs text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 flex-1">
            <CopyValue value={row.value} label={row.name} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A value shown whole, selectable (where copying is blocked: plain HTTP), with its Copy button. */
function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-1">
      {/* Broken after its dots where it doesn't fit, else anywhere. */}
      <code className="min-w-0 flex-1 py-0.5 font-mono text-xs leading-5 wrap-anywhere">
        {value.split(".").map((part, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <>
                .<wbr />
              </>
            )}
            {part}
          </Fragment>
        ))}
      </code>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Copy ${label}`} title="Copy" onClick={() => copyText(value)} className="text-muted-foreground">
        <CopyIcon />
      </Button>
    </div>
  );
}
