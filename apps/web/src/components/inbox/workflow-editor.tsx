"use client";

import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { usePreview } from "@/components/customize-shell";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ACTIONS, actionsFor, MAX_WORKFLOW_NAME, TRIGGER_HINTS, TRIGGER_KEYS, TRIGGERS, type WorkflowAction, type WorkflowTrigger, workflowSentence } from "@/lib/workflows";
import { deleteWorkflow, saveWorkflow } from "@/server/workflows";

/** What the editor changes. `group`: the reader group's key it's for, null for everyone. */
type Draft = { name: string; trigger: WorkflowTrigger; group: string | null; actions: WorkflowAction["kind"][]; enabled: boolean };
const FIELDS = ["name", "trigger", "group", "actions", "enabled"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const ROW_SELECT = "w-full @min-[34rem]/settings:w-64";

/**
 * Settings → Workflows → a workflow (docs/plan.md, Inbox automation, W10): one form, Name, When, If, Then, On, the
 * workflow read back as a sentence, and Delete in a card of its own. Saved by "Save changes" in the pane's header (the
 * form registers with the pane, so leaving with changes asks first). `id` null: a new one, for `workflow.trigger`;
 * saved, it goes to the list. `groups`: the project's reader groups, by key.
 */
export function WorkflowEditor({ projectSlug, id, workflow, groups }: { projectSlug: string; id: string | null; workflow: Draft; groups: Record<string, string> }) {
  const router = useRouter();
  const formId = useId();
  const { register } = usePreview();
  const [saved, setSaved] = useState(workflow);
  const [draft, setDraft] = useState(workflow);
  // The page brings what's stored now (a teammate's change, say, switched off from the list): it's what's saved, and
  // what the fields show where they weren't changed here.
  const [stored, setStored] = useState(workflow);
  if (!same(stored, workflow)) {
    setStored(workflow);
    setSaved(workflow);
    setDraft((current) => Object.fromEntries(FIELDS.map((field) => [field, same(current[field], saved[field]) ? workflow[field] : current[field]])) as Draft);
  }
  const [saving, startSaving] = useTransition();
  // A new one goes to the list once added: nothing changes while it saves, as a change then wouldn't be saved. Its
  // controls stay focusable (read-only, or disabled but focusable), so the focus stays where it was.
  const locked = saving && id === null;
  const set = (change: Partial<Draft>) => {
    if (!locked) setDraft((current) => ({ ...current, ...change }));
  };
  // Tried to save: from then on what's missing says so.
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => register(formId, { dirty, pending: saving, saving }), [register, formId, dirty, saving]);
  useEffect(() => () => register(formId, null), [register, formId]);

  const offered = actionsFor(draft.trigger);
  const actions = draft.actions.filter((kind) => offered.includes(kind));
  // Deleted (through the release before, which didn't refuse it) or while this page was open: the server refuses it too.
  const groupGone = draft.group !== null && !(draft.group in groups);
  const nameError = tried && !draft.name.trim() ? "Give it a name" : null;
  const actionsError = tried && actions.length === 0 ? "Add an action: a workflow needs one" : null;
  const groupError = groupGone ? "This group was deleted: pick another, or Everyone" : null;
  const groupItems = [
    { value: null, label: "Everyone" },
    ...Object.entries(groups).map(([key, name]) => ({ value: key, label: `People in ${name}` })),
    ...(groupGone ? [{ value: draft.group, label: `People in “${draft.group}” (deleted)` }] : []),
  ];
  const triggerItems = TRIGGER_KEYS.map((trigger) => ({ value: trigger, label: TRIGGERS[trigger] }));
  const list = `/app/${projectSlug}/settings/workflows`;
  // Where the focus goes once a removed action's row (and its button) is gone: the next action's Remove, else Add an action.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (refocus.current) {
      document.getElementById(refocus.current)?.focus();
      refocus.current = null;
    }
  });

  const save = () => {
    setTried(true);
    setError(null);
    if (!draft.name.trim() || actions.length === 0 || groupGone) {
      return;
    }
    const clicked = draft;
    const sent = { ...draft, name: draft.name.trim(), actions };
    startSaving(async () => {
      // Only what changed here (all of it for a new one): what's left out stays as stored, a teammate's change too.
      const changed = (field: (typeof FIELDS)[number]) => id === null || !same(sent[field], saved[field]);
      const result = await saveWorkflow(projectSlug, id, {
        ...(changed("name") && { name: sent.name }),
        ...(changed("trigger") && { trigger: sent.trigger }),
        ...(changed("group") && { conditions: sent.group === null ? [] : [{ kind: "in_group" as const, group: sent.group }] }),
        ...(changed("actions") && { actions: sent.actions.map((kind) => ({ kind })) }),
        ...(changed("enabled") && { enabled: sent.enabled }),
      });
      if (result.error) {
        setError(result.error);
        // What may have changed meanwhile (a group deleted) comes in, so the editor says so itself.
        router.refresh();
        return;
      }
      setSaved(sent);
      // What's saved, unless it was changed while it saved: that's still a change to save.
      setDraft((current) => (current === clicked ? sent : current));
      setTried(false);
      if (id === null) {
        toast.success(`Added ${sent.name}`);
        router.push(list);
      } else {
        toast.success(`Saved ${sent.name}`);
      }
    });
  };

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="flex flex-col gap-7"
    >
      <SettingsCard>
        <SettingRow label="Name" htmlFor="workflow-name">
          <div className="flex flex-col gap-1.5 @min-[34rem]/settings:w-64">
            <Input
              id="workflow-name"
              value={draft.name}
              readOnly={locked}
              maxLength={MAX_WORKFLOW_NAME}
              onChange={(event) => set({ name: event.currentTarget.value })}
              // Enter saves, as "Save changes" would (the selects' own fields keep the browser from doing it).
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (dirty && !saving) event.currentTarget.form?.requestSubmit();
                }
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "workflow-name-error" : undefined}
            />
            {nameError && <FieldError id="workflow-name-error">{nameError}</FieldError>}
          </div>
        </SettingRow>
        <SettingRow label={<span id="workflow-when-label">When</span>} description={<span id="workflow-when-description">{TRIGGER_HINTS[draft.trigger]}</span>}>
          <Select items={triggerItems} value={draft.trigger} readOnly={locked} onValueChange={(next) => set({ trigger: next as WorkflowTrigger })}>
            <SelectTrigger className={ROW_SELECT} aria-labelledby="workflow-when-label" aria-describedby="workflow-when-description">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {triggerItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={<span id="workflow-if-label">If</span>} description={<span id="workflow-if-description">Their groups are checked each time it runs.</span>}>
          <div className="flex flex-col gap-1.5">
            <Select items={groupItems} value={draft.group} readOnly={locked} onValueChange={(next) => set({ group: next as string | null })}>
              <SelectTrigger
                className={ROW_SELECT}
                aria-labelledby="workflow-if-label"
                aria-describedby={groupError ? "workflow-if-description workflow-if-error" : "workflow-if-description"}
                aria-invalid={groupError ? true : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groupItems.map((item) => (
                  <SelectItem key={item.value ?? ""} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {groupError && <FieldError id="workflow-if-error">{groupError}</FieldError>}
          </div>
        </SettingRow>
        <SettingRow label="On" description="One that's off never runs." htmlFor="workflow-on" inline>
          <Switch id="workflow-on" aria-describedby="workflow-on-description" aria-readonly={locked || undefined} checked={draft.enabled} onChange={(event) => set({ enabled: event.currentTarget.checked })} />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Then"
        count={actions.length}
        action={
          <DropdownMenu>
            <DropdownMenuTrigger id="workflow-add-action" render={<Button type="button" variant="outline" size="sm" disabled={locked} focusableWhenDisabled />}>
              Add an action
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-40">
              {offered.map((kind) => (
                <DropdownMenuItem key={kind} disabled={actions.includes(kind)} onClick={() => set({ actions: [...actions, kind] })}>
                  {ACTIONS[kind].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        {actions.length === 0 ? (
          <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">No actions yet.</p>
        ) : (
          <ol aria-label="Actions" className="flex flex-col divide-y">
            {actions.map((kind, at) => (
              <li key={kind}>
                <SettingRow label={ACTIONS[kind].label} description={ACTIONS[kind].hint} inline>
                  <Button
                    id={`workflow-remove-${kind}`}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={locked}
                    focusableWhenDisabled
                    aria-label={`Remove ${ACTIONS[kind].label}`}
                    onClick={() => {
                      const next = actions[at + 1] ?? actions[at - 1];
                      refocus.current = next ? `workflow-remove-${next}` : "workflow-add-action";
                      set({ actions: actions.filter((other) => other !== kind) });
                    }}
                  >
                    <XIcon />
                  </Button>
                </SettingRow>
              </li>
            ))}
          </ol>
        )}
      </SettingsCard>
      {actionsError && <FieldError className="-mt-5">{actionsError}</FieldError>}

      <p aria-label="Reads as" className="rounded-xl bg-soft px-4 py-3 text-sm text-soft-foreground @min-[48rem]/app:px-5">
        {workflowSentence({ trigger: draft.trigger, conditions: draft.group === null ? [] : [{ kind: "in_group", group: draft.group }], actions: actions.map((kind) => ({ kind })) }, groups)}
      </p>
      {error && <FieldError className="-mt-5">{error}</FieldError>}

      {id !== null && <DeleteWorkflow projectSlug={projectSlug} id={id} name={saved.name} onDeleted={() => router.push(list)} />}
    </form>
  );
}

/** Delete, in a card of its own at the end: it asks first. */
function DeleteWorkflow({ projectSlug, id, name, onDeleted }: { projectSlug: string; id: string; name: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, startDeleting] = useTransition();
  return (
    <SettingsCard>
      <SettingRow label="Delete workflow" description="It stops running for new messages." inline>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setConfirming(true)}>
            Delete
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="wrap-anywhere">Delete {name}?</AlertDialogTitle>
              <AlertDialogDescription>It stops running for new messages. The notes it left in conversations stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                focusableWhenDisabled
                onClick={() =>
                  startDeleting(async () => {
                    const result = await deleteWorkflow(projectSlug, id);
                    if (result.error) {
                      toast.error(result.error);
                    } else {
                      setConfirming(false);
                      toast.success(`Deleted ${name}`);
                      onDeleted();
                    }
                  })
                }
              >
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingRow>
    </SettingsCard>
  );
}
