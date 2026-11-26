"use client";

import { GripVerticalIcon, MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { type DragEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingsCard } from "@/components/settings-card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { TRIGGER_KEYS, type WorkflowAction, type WorkflowCondition, type WorkflowTrigger, workflowSummary } from "@/lib/workflows";
import { deleteWorkflow, moveWorkflow, saveWorkflow } from "@/server/workflows";

export type WorkflowRow = { id: string; name: string; trigger: WorkflowTrigger; position: number; enabled: boolean; conditions: WorkflowCondition[]; actions: WorkflowAction[] };

/** Each trigger's group, as the path reads it. */
const GROUPS: Record<WorkflowTrigger, { title: string; empty: string }> = {
  conversation_started: { title: "When a conversation starts", empty: "No workflows. New conversations go on to the next step." },
  user_replied: { title: "When a user replies", empty: "No workflows. Replies go on to the next step." },
};

/**
 * Settings → Workflows (docs/plan.md, Inbox automation, W9): the path a user's message takes, top to bottom, the
 * built-in steps fixed and each trigger's workflows between them, each group's Add workflow and each row's name opening the
 * editor (W10). `aiFirst`:
 * the widget's "Answer with AI first" as set (its own settings are W14's), null where the server has no AI answers.
 */
export function Workflows({ projectSlug, workflows, groupNames, aiFirst }: { projectSlug: string; workflows: WorkflowRow[]; groupNames: Record<string, string>; aiFirst: boolean | null }) {
  const settings = (page: string) => `/app/${projectSlug}/settings/${page}`;
  return (
    <ol className="flex flex-col gap-6">
      {/* First for now: it answers in the widget before there is a conversation. Once the AI answers in conversations (W12), it moves after the triggers. */}
      <BuiltIn name="AI answers first" description={aiFirst === null ? "This server has no AI answers" : aiFirst ? "On in the widget, where it answers before a conversation starts, once you've published articles" : "Off in the widget"}>
        <Link href={settings("widget")} aria-label="AI answers first in the widget's settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Widget
        </Link>
      </BuiltIn>
      <BuiltIn name="Spam filter" description="Stops spam before your workflows run">
        <Link href={settings("spam")} aria-label="Spam filter settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Settings
        </Link>
      </BuiltIn>
      {TRIGGER_KEYS.map((trigger) => (
        <li key={trigger}>
          <Group projectSlug={projectSlug} trigger={trigger} workflows={workflows.filter((workflow) => workflow.trigger === trigger)} groupNames={groupNames} />
        </li>
      ))}
      <BuiltIn name="Hand to the team" description="Moves the conversation to your inbox and notifies you" />
    </ol>
  );
}

/** A step of the path that's always there: it can't be moved or deleted. */
function BuiltIn({ name, description, children }: { name: string; description: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/50 px-4 py-3.5 sm:px-5">
      <div className="flex min-w-0 flex-1 basis-48 flex-col">
        <span className="font-medium">{name}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </div>
      <Badge variant="secondary">Built in</Badge>
      {children}
    </li>
  );
}

/**
 * A trigger's workflows, top to bottom: dragged within the group (from a mouse; on phones the handle isn't there) or
 * moved from a row's menu (Move up, Move down), the order shown at once and kept until the page has it.
 */
function Group({ projectSlug, trigger, workflows, groupNames }: { projectSlug: string; trigger: WorkflowTrigger; workflows: WorkflowRow[]; groupNames: Record<string, string> }) {
  const { title, empty } = GROUPS[trigger];
  const ids = workflows.map((workflow) => workflow.id);
  // The order moved to, until the page comes back with it (or a teammate's change).
  const [moved, setMoved] = useState<string[] | null>(null);
  const [seen, setSeen] = useState(ids.join());
  if (seen !== ids.join()) {
    setSeen(ids.join());
    setMoved(null);
  }
  const order = moved ?? ids;
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const [saving, startSaving] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  // What to focus once the page has the change: a moved row's menu (the menu closed and the row moved), or after a
  // delete its neighbour's (or the empty group's line), as the deleted row's is gone. Only where the focus was lost
  // (it's on the page itself): someone who went on to another control while it saved keeps their place.
  const refocus = useRef<string | null>(null);
  const menuId = (id: string) => `workflow-menu-${id}`;
  const emptyId = `workflows-${trigger}-empty`;
  useEffect(() => {
    if (!saving && refocus.current) {
      const active = document.activeElement;
      if (!active || active === document.body) {
        document.getElementById(refocus.current)?.focus();
      }
      refocus.current = null;
    }
  }, [saving, seen]);

  const move = (id: string, to: number, byMenu = false) => {
    const next = order.filter((other) => other !== id);
    next.splice(to, 0, id);
    setMoved(next);
    refocus.current = byMenu ? menuId(id) : null;
    // Its place in the whole list, which may hold a workflow the page doesn't show (one a later release made, while
    // a deploy overlaps the two): the place of the row it's moved onto.
    const position = byId.get(order[to])!.position;
    startSaving(async () => {
      const result = await moveWorkflow(projectSlug, id, position);
      if (result.error) {
        toast.error(result.error);
        setMoved(null);
      } else {
        toast.success(`Moved ${byId.get(id)?.name ?? "the workflow"}`);
        // The page has it now: its order, whatever the rows show. After an await a set state is no longer part of the
        // transition, so it's wrapped again, to land with the refreshed page rather than before it (no flash of the old order).
        startSaving(() => setMoved(null));
      }
    });
  };
  const rowOf = (event: DragEvent) => (event.target as Element).closest<HTMLElement>("[data-workflow-id]")?.dataset.workflowId;

  return (
    <SettingsCard
      title={title}
      count={workflows.length}
      action={
        <Link href={`/app/${projectSlug}/settings/workflows/new?trigger=${trigger}`} aria-label={`Add workflow ${title.charAt(0).toLowerCase()}${title.slice(1)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Add workflow
        </Link>
      }
    >
      {order.length === 0 ? (
        <p id={emptyId} tabIndex={-1} className="px-4 py-3.5 text-sm text-muted-foreground outline-none @min-[34rem]/settings:px-5">
          {empty}
        </p>
      ) : (
        <ol
          aria-label={title}
          aria-busy={saving}
          className="flex flex-col divide-y"
          onDragStart={(event) => {
            const id = rowOf(event);
            if (saving || !id) {
              event.preventDefault();
              return;
            }
            setDragging(id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", id);
          }}
          onDragOver={(event) => {
            if (dragging && rowOf(event)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDragEnd={() => setDragging(null)}
          onDrop={(event) => {
            event.preventDefault();
            const over = rowOf(event);
            setDragging(null);
            if (dragging && over && over !== dragging) move(dragging, order.indexOf(over));
          }}
        >
          {order.flatMap((id, at) => {
            const workflow = byId.get(id);
            return workflow
              ? [
                  <Row
                    key={id}
                    projectSlug={projectSlug}
                    workflow={workflow}
                    summary={workflowSummary(workflow, groupNames)}
                    menuId={menuId(id)}
                    dragging={dragging === id}
                    saving={saving}
                    up={at > 0 ? () => move(id, at - 1, true) : undefined}
                    down={at < order.length - 1 ? () => move(id, at + 1, true) : undefined}
                    onDelete={(sent) => {
                      const neighbour = order[at + 1] ?? order[at - 1];
                      refocus.current = !sent ? null : neighbour ? menuId(neighbour) : emptyId;
                    }}
                  />,
                ]
              : [];
          })}
        </ol>
      )}
    </SettingsCard>
  );
}

/** A workflow: its name and summary, its switch (saving as it's changed), and Move up, Move down and Delete under its ⋯. */
function Row({
  projectSlug,
  workflow,
  summary,
  menuId,
  dragging,
  saving,
  up,
  down,
  onDelete,
}: {
  projectSlug: string;
  workflow: WorkflowRow;
  summary: string;
  menuId: string;
  dragging: boolean;
  saving: boolean;
  up?: () => void;
  down?: () => void;
  /** Called as its delete is sent (`true`; where the focus goes once it's gone) and if it's refused (`false`). */
  onDelete: (sent: boolean) => void;
}) {
  // The switch as turned, until the page has it: never disabled or drawn again meanwhile, so it keeps the focus.
  // Kept while any turn saves (the transition covers each save and the page it brings): turned twice quickly, the
  // first save's page mustn't show its state between. Then the page's, whatever it says (a teammate's turn too).
  const [turned, setTurned] = useState<boolean | null>(null);
  const [switching, startSwitching] = useTransition();
  if (turned !== null && !switching) {
    setTurned(null);
  }
  const [confirming, setConfirming] = useState(false);
  const [deleting, startDeleting] = useTransition();
  const switchId = `workflow-on-${workflow.id}`;
  return (
    <li
      draggable={!saving}
      data-workflow-id={workflow.id}
      data-dragging={dragging || undefined}
      className="flex items-center gap-3 px-4 py-3 data-[dragging]:opacity-50 @min-[34rem]/settings:cursor-grab @min-[34rem]/settings:px-5"
    >
      {/* Only a hint that the row drags: the menu's Move up and Move down do it from a keyboard, and on phones. */}
      <GripVerticalIcon aria-hidden className="hidden size-4 shrink-0 text-muted-foreground @min-[34rem]/settings:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The row's title, opening its editor; not the switch's label: a click on it mustn't turn a live workflow off. */}
        <Link id={`${switchId}-name`} href={`/app/${projectSlug}/settings/workflows/${workflow.id}`} className="self-start font-medium break-words hover:underline">
          {workflow.name}
        </Link>
        <span id={`${switchId}-description`} className="text-sm break-words text-muted-foreground">
          {summary}
        </span>
      </div>
      <Switch
        id={switchId}
        aria-labelledby={`${switchId}-name`}
        aria-describedby={`${switchId}-description`}
        checked={turned ?? workflow.enabled}
        onChange={(event) => {
          const on = event.currentTarget.checked;
          setTurned(on);
          startSwitching(async () => {
            const result = await saveWorkflow(projectSlug, workflow.id, { enabled: on });
            if (result.error) {
              toast.error(result.error);
              setTurned(null);
            } else {
              toast.success(`${workflow.name} turned ${on ? "on" : "off"}`);
            }
          });
        }}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <DropdownMenu>
          <DropdownMenuTrigger id={menuId} disabled={saving} render={<Button variant="ghost" size="icon-sm" focusableWhenDisabled aria-label={`Actions for ${workflow.name}`} />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-36">
            <DropdownMenuItem onClick={up} disabled={!up}>
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem onClick={down} disabled={!down}>
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="wrap-anywhere">Delete {workflow.name}?</AlertDialogTitle>
            <AlertDialogDescription>It stops running for new messages. The notes it left in conversations stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              focusableWhenDisabled
              onClick={() =>
                startDeleting(async () => {
                  onDelete(true);
                  const result = await deleteWorkflow(projectSlug, workflow.id);
                  if (result.error) {
                    toast.error(result.error);
                    onDelete(false);
                  } else {
                    setConfirming(false);
                    toast.success(`Deleted ${workflow.name}`);
                  }
                })
              }
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
