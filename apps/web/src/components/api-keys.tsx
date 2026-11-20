"use client";

import { CheckIcon, CopyIcon, MoreHorizontalIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { ItemList, ItemRow } from "@/components/item-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import { createApiKey, revokeApiKey } from "@/server/api-keys";

const SCOPES = { READ: "Read only", WRITE: "Read and write" } as const;
type Scope = keyof typeof SCOPES;

export type ApiKeyView = {
  id: string;
  name: string;
  scope: Scope;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/**
 * Developers' "Create key": the name and what the key can do, in a dialog. It stays open on the new key, which is shown
 * once; closed and opened again, it's empty.
 */
export function CreateKeyDialog({ projectSlug, apiUrl }: { projectSlug: string; apiUrl: string }) {
  const [open, setOpen] = useState(false);
  const transition = useTransition();
  // While the request itself runs, not the refresh after it: once the secret shows, Close closes.
  const sending = useRef(false);
  return (
    // A tap beside it doesn't close it, and nothing does while the key is being made: the key it shows isn't shown again.
    <Dialog disablePointerDismissal open={open} onOpenChange={(next) => (next || !sending.current) && setOpen(next)}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <PlusIcon />
        Create key
      </DialogTrigger>
      <DialogContent initialFocus={() => document.getElementById("api-key-name")} className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an API key</DialogTitle>
          <DialogDescription>For your own code (REST API) or an AI assistant (MCP). The key is shown once.</DialogDescription>
        </DialogHeader>
        <CreateKeyForm projectSlug={projectSlug} sending={sending} apiUrl={apiUrl} transition={transition} />
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyForm({ projectSlug, apiUrl, transition: [pending, startTransition], sending }: { sending: React.RefObject<boolean>; projectSlug: string; apiUrl: string; transition: ReturnType<typeof useTransition> }) {
  const [scope, setScope] = useState<Scope>("READ");
  const [created, setCreated] = useState<{ name: string; key: string }>();
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get("name"));
          startTransition(async () => {
            sending.current = true;
            const result = await createApiKey(projectSlug, name, scope).finally(() => (sending.current = false));
            if (result.error || !result.key) {
              toast.error(result.error ?? "Couldn't create the key");
              return;
            }
            setCreated({ name: name.trim(), key: result.key });
            setCopied(false);
            form.reset();
          });
        }}
      >
        <Input id="api-key-name" name="name" required maxLength={60} placeholder="e.g. Zapier, our CRM" aria-label="Key name" />
        <Select items={SCOPES} value={scope} onValueChange={(value) => setScope(value as Scope)}>
          <SelectTrigger className="w-full" aria-label="What the key can do">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SCOPES) as Scope[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPES[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={pending} focusableWhenDisabled>
          {pending ? "Creating…" : "Create key"}
        </Button>
      </form>

      {created && (
        // One column no wider than the alert: a long name wraps inside the dialog.
        <Alert className="grid-cols-[auto_minmax(0,1fr)]">
          <TriangleAlertIcon />
          <AlertTitle className="wrap-anywhere">Copy the key for {created.name} now. It won&apos;t be shown again.</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <div className="flex w-full items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">
                {created.key}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.key);
                  setCopied(true);
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy key"}
              </Button>
            </div>
            <span>Keep it on your server. Try it:</span>
            <code className="w-full rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">
              curl -H &quot;Authorization: Bearer {created.key}&quot; {apiUrl}/posts
            </code>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Developers' API keys: each with what it can do, how it starts and when it was last used; Revoke under the row's ⋯. */
export function ApiKeys({ projectSlug, keys }: { projectSlug: string; keys: ApiKeyView[] }) {
  if (keys.length === 0) {
    return <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">No API keys yet</p>;
  }
  return (
    <ItemList aria-label="API keys">
      {keys.map((key) => (
        <ItemRow
          key={key.id}
          className="px-4 py-3.5 first:pt-3.5 last:pb-3.5 @min-[34rem]/settings:px-5"
          title={key.name}
          badges={<Badge variant={key.scope === "WRITE" ? "soft" : "secondary"}>{SCOPES[key.scope]}</Badge>}
          meta={
            <>
              <span className="font-mono">{key.prefix}…</span> · {key.lastUsedAt ? `used ${timeAgo(key.lastUsedAt)}` : "never used"}
            </>
          }
          actions={<KeyActions projectSlug={projectSlug} apiKey={key} />}
        />
      ))}
    </ItemList>
  );
}

function KeyActions({ projectSlug, apiKey }: { projectSlug: string; apiKey: ApiKeyView }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${apiKey.name}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-32">
          <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
            Revoke
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Revoke {apiKey.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything using this key stops working right away. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await revokeApiKey(projectSlug, apiKey.id);
                if (result.error) {
                  toast.error(result.error);
                  return;
                }
                setOpen(false);
                toast.success(`${apiKey.name} revoked`);
              })
            }
          >
            Revoke key
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
