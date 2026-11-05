"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { IMPORT_PARTS, type ImportPart, importSummary, importTitle, pickPart } from "@/lib/import-parts";
import { startImport } from "@/server/imports";
import type { ImportView } from "@/server/operations/imports";

/** Where Featurebase's API keys are made (its dashboard's Settings → API, after signing in). */
const KEYS_URL = "https://auth.featurebase.app/login?redirect=/settings/api";

/** Reads the page again every few seconds while `on`: an import's progress. */
export function RefreshWhile({ on }: { on: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!on) {
      return;
    }
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [on, router]);
  return null;
}

/**
 * The first run's "Where are you coming from?": starting fresh, or Featurebase, with an API key and the parts to bring
 * (imports.start). Started, it shows the import's progress while it runs, and Continue goes on with setup meanwhile.
 */
export function SetupImport({ projectSlug, latest, mediaStorage, next, skip }: { projectSlug: string; latest: ImportView | null; mediaStorage: boolean; next: string; skip: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState<"fresh" | "featurebase">(latest ? "featurebase" : "fresh");
  const [picked, setPicked] = useState<ImportPart[]>(["contacts"]);
  const [error, setError] = useState<string | null>(null);
  const parts = Object.entries(IMPORT_PARTS) as [ImportPart, (typeof IMPORT_PARTS)[ImportPart]][];
  const running = latest?.state === "running";
  // Images and files need media storage: said before starting, while a part that has them is offered.
  const noMedia = !mediaStorage && parts.some(([, part]) => part.media);

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        const key = String(new FormData(event.currentTarget).get("key") ?? "");
        startTransition(async () => {
          const result = await startImport(projectSlug, key, picked);
          setError(result.error ?? null);
          if (!result.error) {
            router.refresh();
          }
        });
      }}
    >
      <RefreshWhile on={running} />
      <CardContent role="radiogroup" aria-label="Where are you coming from?" className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["fresh", "Starting fresh", "Set Tuti up from scratch."],
            ["featurebase", "Featurebase", "Bring what you have there across with an API key."],
          ] as const
        ).map(([value, label, description]) => (
          <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-soft">
            <input type="radio" name="from" value={value} checked={from === value} onChange={() => setFrom(value)} className="mt-0.5 size-4 accent-primary" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{label}</span>
              <span className="text-sm text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </CardContent>
      {from === "featurebase" && latest && (
        <CardContent>
          <div role="status" className="rounded-xl border p-4">
            <p className="text-sm font-medium">{importTitle(latest)}</p>
            <p className="text-sm text-muted-foreground">{importSummary(latest)}</p>
            {running && <p className="mt-1 text-sm text-muted-foreground">It goes on while you finish setting up; Home shows how it&apos;s going.</p>}
          </div>
        </CardContent>
      )}
      {from === "featurebase" && !running && (
        <CardContent className="flex flex-col gap-4">
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="featurebase-key">API key</FieldLabel>
            <Input id="featurebase-key" name="key" type="password" autoComplete="off" required aria-invalid={error ? true : undefined} />
            <FieldDescription>
              Make one in Featurebase under{" "}
              <a href={KEYS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Settings → API
              </a>
              . It&apos;s kept only while the import runs.
            </FieldDescription>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <div role="group" aria-label="What to bring" className="flex flex-col gap-2">
            <p className="text-sm font-medium">What to bring</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {parts.map(([key, part]) => (
                <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-soft">
                  <input
                    type="checkbox"
                    checked={picked.includes(key)}
                    onChange={(event) => setPicked(pickPart(picked, key, event.target.checked, IMPORT_PARTS))}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{part.label}</span>
                    <span className="text-sm text-muted-foreground">{part.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">Featurebase&apos;s changelog isn&apos;t brought across yet.</p>
            {noMedia && <p className="text-sm text-muted-foreground">This server has no media storage, so images and files can&apos;t come across: they&apos;re left out and counted.</p>}
          </div>
        </CardContent>
      )}
      <CardFooter className="justify-end gap-2">
        {from === "featurebase" && !running ? (
          <>
            {latest?.state === "done" ? (
              <Link href={next} className={buttonVariants({ variant: "outline" })}>
                Continue
              </Link>
            ) : (
              skip
            )}
            <Button type="submit" disabled={pending || picked.length === 0} focusableWhenDisabled>
              {pending ? "Checking the key…" : "Check the key and start"}
            </Button>
          </>
        ) : (
          <Link href={next} className={buttonVariants()}>
            Continue
          </Link>
        )}
      </CardFooter>
    </form>
  );
}
