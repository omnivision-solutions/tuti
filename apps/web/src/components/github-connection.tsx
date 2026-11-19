"use client";

import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button, buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { disconnectGithub, refreshGithubRepositories, setAutoApplyLinks, setCodeChangeAnalysis, setGithubRepository } from "@/server/github";

/**
 * Settings → Integrations → GitHub's ⋯ menu, in the pane's header: when it was connected (`connected`, a date), Refresh
 * list and Switch account (`switchUrl`, both only where the server has a GitHub App), and Disconnect, which asks first.
 */
export function GithubConnectionMenu({ projectSlug, account, connected, switchUrl }: { projectSlug: string; account: string; connected: string; switchUrl: string | null }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label="GitHub connection actions" />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Connected {connected}</DropdownMenuLabel>
          </DropdownMenuGroup>
          {switchUrl && (
            <>
              <DropdownMenuItem
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
                Refresh list
              </DropdownMenuItem>
              <DropdownMenuItem render={<a href={switchUrl} />}>Switch account</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={setOpen}>
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
    </>
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
 * Settings → Integrations → GitHub's Repositories card: the repositories that feed this project, each with Remove
 * under its ⋯, and "Add repository" at the title's right to search the account's others. Each change saves at once.
 */
export function GithubRepositories({
  projectSlug,
  account,
  repositories,
  manageUrl,
  reconnectUrl,
}: {
  projectSlug: string;
  account: string;
  repositories: GithubRepositoryRow[];
  /** The installation's settings on GitHub, where its repositories are chosen (null when the server has no GitHub App). */
  manageUrl: string | null;
  /** GitHub's authorization again, to list the repositories the person reconnecting can access. */
  reconnectUrl: string;
}) {
  const [pending, startTransition] = useTransition();
  const [included, setIncluded] = useState(() => new Set(repositories.filter((repo) => repo.included).map((repo) => repo.id)));
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  // In full ("acme/app"), as GitHub and Autopilot's pages name it.
  const name = (repo: GithubRepositoryRow) => repo.fullName;
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
        toast.success(on ? `${name(repo)} added` : `${name(repo)} removed`);
      }
    });
  };
  const ours = repositories.filter((repo) => included.has(repo.id));
  const query = search.trim().toLowerCase();
  const others = repositories.filter((repo) => !included.has(repo.id) && name(repo).toLowerCase().includes(query));

  return (
    <SettingsCard
      title="Repositories"
      count={ours.length}
      action={
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger render={<Button variant="outline" size="sm" className="shrink-0" disabled={pending} />}>
            <PlusIcon />
            Add repository
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 text-sm">
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
                      <span className="min-w-0 break-all">{name(repo)}</span>
                      {repo.elsewhere && <span className="shrink-0 text-xs text-muted-foreground">In {repo.elsewhere}</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </PopoverContent>
        </Popover>
      }
    >
      {ours.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">No repository yet, so pull requests and releases are ignored.</p>
      ) : (
        <ul className="flex flex-col divide-y" aria-label="This project's repositories">
          {ours.map((repo) => (
            <li key={repo.id}>
              <SettingRow label={<span className="font-mono text-sm font-normal break-all">{name(repo)}</span>} inline>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Actions for ${name(repo)}`} />}>
                    <MoreHorizontalIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-auto min-w-32">
                    <DropdownMenuItem variant="destructive" onClick={() => change(repo, false)}>
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SettingRow>
            </li>
          ))}
        </ul>
      )}
      {manageUrl && (
        <p className="px-4 py-3 text-sm text-muted-foreground @min-[34rem]/settings:px-5">
          Missing one?{" "}
          <a href={manageUrl} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-4">
            Manage access on GitHub
          </a>
          , then{" "}
          <a href={reconnectUrl} className="font-medium text-foreground underline underline-offset-4">
            reconnect
          </a>
          .
        </p>
      )}
    </SettingsCard>
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
      {accounts.length > 0 && (
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
      )}
      <a href={`/api/github/install?${new URLSearchParams({ project: projectSlug, new: "1" })}`} className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}>
        Install on another account
      </a>
    </div>
  );
}

/** Settings → AI → Autopilot: a switch, a row of its card, saved at once; only owners change it (`owner`). */
export function CodeChangeSwitch({
  projectSlug,
  setting,
  on,
  owner,
}: {
  projectSlug: string;
  /** Analysing merged pull requests at all, or applying sure links by itself. */
  setting: "analysis" | "autoLinks";
  on: boolean;
  owner: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(on);
  const id = setting === "analysis" ? "analyse-code-changes" : "auto-apply-links";
  return (
    <SettingRow label={setting === "analysis" ? "Analyse merged pull requests" : "Link posts by itself"} htmlFor={id} inline>
      <Switch
        id={id}
        checked={checked}
        disabled={!owner}
        // Not disabled while it saves, which would drop keyboard focus: a second flip waits for the first.
        aria-disabled={pending || undefined}
        onChange={(event) => {
          if (pending) {
            return;
          }
          const next = event.currentTarget.checked;
          setChecked(next);
          startTransition(async () => {
            const result = await (setting === "analysis" ? setCodeChangeAnalysis : setAutoApplyLinks)(projectSlug, next);
            if (result.error) {
              setChecked(!next);
              toast.error(result.error);
            } else if (setting === "analysis") {
              toast.success(next ? "Autopilot on" : "Autopilot off");
            } else {
              toast.success(next ? "Autopilot links posts by itself" : "Autopilot doesn't link posts");
            }
          });
        }}
      />
    </SettingRow>
  );
}
