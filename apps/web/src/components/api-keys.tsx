"use client";

import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
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

export function ApiKeys({ projectSlug, keys, apiUrl }: { projectSlug: string; keys: ApiKeyView[]; apiUrl: string }) {
  const [scope, setScope] = useState<Scope>("READ");
  const [created, setCreated] = useState<{ name: string; key: string }>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get("name"));
          startTransition(async () => {
            const result = await createApiKey(projectSlug, name, scope);
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
        <Input name="name" required maxLength={60} placeholder="e.g. Zapier, our CRM" aria-label="Key name" className="w-56" />
        <Select items={SCOPES} value={scope} onValueChange={(value) => setScope(value as Scope)}>
          <SelectTrigger className="w-40" aria-label="What the key can do">
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
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create key"}
        </Button>
      </form>

      {created && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Copy the key for {created.name} now. It won&apos;t be shown again.</AlertTitle>
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

      {keys.length === 0 ? (
        <EmptyState title="No API keys yet" description="Create one to read or change this project's feedback from your own code." />
      ) : (
        <ItemList>
          {keys.map((key) => (
            <ItemRow
              key={key.id}
              title={key.name}
              badges={<Badge variant={key.scope === "WRITE" ? "soft" : "secondary"}>{SCOPES[key.scope]}</Badge>}
              meta={[
                `${key.prefix}…`,
                `created ${timeAgo(key.createdAt)}`,
                key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt)}` : "never used",
              ].join(" · ")}
              actions={<RevokeKeyButton projectSlug={projectSlug} apiKey={key} />}
            />
          ))}
        </ItemList>
      )}
    </div>
  );
}

function RevokeKeyButton({ projectSlug, apiKey }: { projectSlug: string; apiKey: ApiKeyView }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {apiKey.name}?</AlertDialogTitle>
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
