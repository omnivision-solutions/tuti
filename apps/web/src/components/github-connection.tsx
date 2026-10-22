"use client";

import { InfoIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { disconnectGithub, setGithubCloseOn, setGithubNewRepositories, setGithubPrComments, setGithubRepository } from "@/server/github";

export function DisconnectGithubButton({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await disconnectGithub(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("GitHub disconnected");
          }
        })
      }
    >
      Disconnect
    </Button>
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
 * Settings → Integrations → Repositories: which of the installation's repositories feed this
 * project. Each saves as it's switched.
 */
export function GithubRepositories({
  projectSlug,
  account,
  repositories,
  includeNew,
  newElsewhere,
}: {
  projectSlug: string;
  account: string;
  repositories: GithubRepositoryRow[];
  includeNew: boolean;
  /** The project new repositories go to instead, or null. */
  newElsewhere: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [included, setIncluded] = useState(() => new Set(repositories.filter((repo) => repo.included).map((repo) => repo.id)));
  const [newOn, setNewOn] = useState(includeNew);
  const toggle = (repo: GithubRepositoryRow, on: boolean) => {
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
        toast.success(on ? `${repo.fullName} included` : `${repo.fullName} left out`);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        <strong>
          {included.size} of {repositories.length}
        </strong>{" "}
        <span className="text-muted-foreground">{repositories.length === 1 ? "repository" : "repositories"} included</span>
      </p>
      {repositories.length === 0 ? (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            None of @{account}&apos;s repositories that you can access are open to Tuti. Choose them on GitHub, then refresh.
          </AlertDescription>
        </Alert>
      ) : (
        included.size === 0 && (
          <Alert>
            <InfoIcon />
            <AlertDescription>
              No repository is included, so their pull requests and releases are ignored. Include the ones that belong to this project.
            </AlertDescription>
          </Alert>
        )
      )}
      {repositories.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border" aria-label="Repositories">
          {repositories.map((repo) => {
            const on = included.has(repo.id);
            return (
              <li key={repo.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0 truncate font-medium">{repo.fullName}</span>
                <label className="flex shrink-0 items-center gap-2 text-muted-foreground">
                  {repo.elsewhere ? `In ${repo.elsewhere}` : on ? "Included" : null}
                  <Switch
                    checked={on}
                    disabled={pending || repo.elsewhere !== null}
                    aria-label={`Include ${repo.fullName}`}
                    onChange={(event) => toggle(repo, event.currentTarget.checked)}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <label className="flex items-start justify-between gap-3">
        <span>
          Include new repositories
          <span className="block text-muted-foreground">
            {newElsewhere
              ? `New repositories from @${account} go to ${newElsewhere}.`
              : `Repositories Tuti gets access to on @${account} later come to this project.`}
          </span>
        </span>
        <Switch
          checked={newOn}
          disabled={pending || (newElsewhere !== null && !newOn)}
          aria-label="Include new repositories"
          onChange={(event) => {
            const wanted = event.currentTarget.checked;
            setNewOn(wanted);
            startTransition(async () => {
              const result = await setGithubNewRepositories(projectSlug, wanted);
              if (result.error) {
                setNewOn(!wanted);
                toast.error(result.error);
              } else {
                toast.success("Saved");
              }
            });
          }}
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <span className="text-muted-foreground">Changes save as you make them.</span>
        <div className="flex gap-2">
          <a href={`/api/github/install?${new URLSearchParams({ project: projectSlug })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Choose on GitHub
          </a>
          <a href={`/api/github/refresh?${new URLSearchParams({ project: projectSlug })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Refresh
          </a>
        </div>
      </div>
    </div>
  );
}
