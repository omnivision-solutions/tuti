"use client";

import { ExternalLinkIcon, InfoIcon, PlusIcon, RefreshCwIcon, UnplugIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { disconnectGithub, refreshGithubRepositories, setGithubCloseOn, setGithubPrComments, setGithubRepository } from "@/server/github";

export function DisconnectGithubButton({ projectSlug, account }: { projectSlug: string; account: string }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <UnplugIcon />
        Disconnect
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
          <AlertDialogDescription>
            Pull requests and releases from @{account} stop reaching this project, and its repositories are free for other projects.
            Posts keep the links they have. The Tuti app stays installed on GitHub until you uninstall it there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await disconnectGithub(projectSlug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  router.replace(`/app/${projectSlug}/settings/integrations?github=disconnected`);
                }
              })
            }
          >
            Disconnect
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const CLOSE_ON = {
  RELEASE: "a release ships their pull request",
  MERGE: "their pull request is merged",
} as const;

export function CloseOnSelect({ projectSlug, closeOn }: { projectSlug: string; closeOn: keyof typeof CLOSE_ON }) {
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex flex-wrap items-center gap-2">
      Linked posts become Completed when
      <Select
        items={CLOSE_ON}
        value={closeOn}
        disabled={pending}
        onValueChange={(value) =>
          startTransition(async () => {
            const result = await setGithubCloseOn(projectSlug, String(value));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success("Saved");
            }
          })
        }
      >
        <SelectTrigger className="w-full sm:w-72" aria-label="When linked posts become Completed">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(CLOSE_ON) as (keyof typeof CLOSE_ON)[]).map((value) => (
            <SelectItem key={value} value={value}>
              {CLOSE_ON[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function PrCommentsCheckbox({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(on);
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-1 size-4 accent-primary"
        checked={checked}
        disabled={pending}
        onChange={(event) => {
          const wanted = event.currentTarget.checked;
          setChecked(wanted);
          startTransition(async () => {
            const result = await setGithubPrComments(projectSlug, wanted);
            if (result.error) {
              setChecked(!wanted); // back to what's saved
              toast.error(result.error);
            } else {
              toast.success("Saved");
            }
          });
        }}
      />
      <span>
        Comment on pull requests with the feedback they complete
        <span className="block text-sm text-muted-foreground">
          One comment per pull request, listing its linked posts and their votes, kept up to date.
        </span>
      </span>
    </label>
  );
}

export type GithubRepositoryRow = {
  id: number;
  fullName: string;
  included: boolean;
  /** The project that includes it instead (its name if you're on its team), or null. */
  elsewhere: string | null;
};

/**
 * Settings → Integrations → Repositories: the repositories that feed this project, each with
 * Remove, and "Add repository" to search the account's others. Each change saves at once.
 */
export function GithubRepositories({
  projectSlug,
  account,
  repositories,
  manageUrl,
}: {
  projectSlug: string;
  account: string;
  repositories: GithubRepositoryRow[];
  /** The installation's settings on GitHub, where its repositories are chosen (null when the server has no GitHub App). */
  manageUrl: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [included, setIncluded] = useState(() => new Set(repositories.filter((repo) => repo.included).map((repo) => repo.id)));
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const change = (repo: GithubRepositoryRow, on: boolean) => {
    const set = (value: boolean) =>
      setIncluded((current) => {
        const next = new Set(current);
        if (value) {
          next.add(repo.id);
        } else {
          next.delete(repo.id);
        }
        return next;
      });
    set(on);
    startTransition(async () => {
      const result = await setGithubRepository(projectSlug, repo.id, on);
      if (result.error) {
        set(!on);
        toast.error(result.error);
      } else {
        toast.success(on ? `${repo.fullName} added` : `${repo.fullName} removed`);
      }
    });
  };
  const ours = repositories.filter((repo) => included.has(repo.id));
  const query = search.trim().toLowerCase();
  const others = repositories.filter((repo) => !included.has(repo.id) && repo.fullName.toLowerCase().includes(query));

  return (
    <div className="flex flex-col gap-4 text-sm">
      {ours.length === 0 ? (
        <Alert>
          <InfoIcon />
          <AlertDescription>No repository yet, so pull requests and releases are ignored. Add the ones that belong to this project.</AlertDescription>
        </Alert>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="This project's repositories">
          {ours.map((repo) => (
            <li key={repo.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate font-medium">{repo.fullName}</span>
              <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Remove ${repo.fullName}`} onClick={() => change(repo, false)}>
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Popover open={adding} onOpenChange={setAdding}>
        <PopoverTrigger render={<Button variant="outline" size="sm" className="self-start" disabled={pending} />}>
          <PlusIcon />
          Add repository
        </PopoverTrigger>
        <PopoverContent className="flex w-80 flex-col gap-2">
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={`Search @${account}'s repositories`}
            aria-label="Search repositories"
          />
          <ul className="flex max-h-64 flex-col overflow-y-auto" aria-label="Repositories to add">
            {others.length === 0 ? (
              <li className="px-2 py-1.5 text-muted-foreground">
                {repositories.length === included.size ? "Every listed repository is in this project." : "No repository matches."}
              </li>
            ) : (
              others.map((repo) => (
                <li key={repo.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                    disabled={repo.elsewhere !== null}
                    onClick={() => {
                      setAdding(false);
                      setSearch("");
                      change(repo, true);
                    }}
                  >
                    <span className="min-w-0 truncate">{repo.fullName}</span>
                    {repo.elsewhere && <span className="shrink-0 text-xs text-muted-foreground">In {repo.elsewhere}</span>}
                  </button>
                </li>
              ))
            )}
          </ul>
        </PopoverContent>
      </Popover>
      {manageUrl && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <span className="text-muted-foreground">
            Missing a repository? Give the Tuti app access to it on GitHub, then refresh the list here.
          </span>
          <div className="flex flex-wrap gap-2">
            <a href={manageUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Manage access on GitHub
              <ExternalLinkIcon />
            </a>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await refreshGithubRepositories(projectSlug);
                  if (result.error) {
                    toast.error(result.error);
                  } else {
                    toast.success(`List refreshed: ${result.count} ${result.count === 1 ? "repository" : "repositories"}`);
                  }
                })
              }
            >
              <RefreshCwIcon />
              Refresh list
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** After "Connect GitHub": the accounts the person has the Tuti app on, or install it on another. */
export function GithubAccountChoice({
  projectSlug,
  accounts,
}: {
  projectSlug: string;
  accounts: { id: number; account: { login: string; type: string } }[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <p>Pick the GitHub account with this project&apos;s repositories.</p>
      <ul className="flex flex-col divide-y rounded-lg border" aria-label="GitHub accounts">
        {accounts.map(({ id, account }) => (
          <li key={id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span>
              <strong>@{account.login}</strong>{" "}
              <span className="text-muted-foreground">{account.type === "User" ? "Personal account" : "Organization"}</span>
            </span>
            <a href={`/api/github/use?${new URLSearchParams({ project: projectSlug, installation: String(id) })}`} className={buttonVariants({ size: "sm" })}>
              Connect @{account.login}
            </a>
          </li>
        ))}
      </ul>
      <a href={`/api/github/install?${new URLSearchParams({ project: projectSlug, new: "1" })}`} className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}>
        Install on another account
      </a>
    </div>
  );
}
