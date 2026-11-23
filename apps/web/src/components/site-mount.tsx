"use client";

import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AgentPrompt } from "@/components/agent-prompt";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingBlock, SettingRow } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { keepingFields } from "@/lib/forms";
import { sitePrompt } from "@/lib/site-prompt";
import type { FormState } from "@/server/form-state";
import { removeSiteMount, saveSite, verifySiteSetup } from "@/server/portal-settings";

/** The rules in general, with each platform's: for doing it by hand. */
const SITE_PATH_DOCS = "https://github.com/omnivision-solutions/tuti/blob/main/docs/site-path.md";

type Site = { url: string; status: "pending" | "verified"; forward: { from: string; to: string }[] };

/**
 * Settings → Domain → Sub-folder (see the site.* operations): the portal under a path of the
 * team's own site (yourcompany.com/help). They set the site and the path, make their site forward
 * two paths to Tuti (a prompt for their coding agent, or the rules by hand), and check it.
 */
export function SiteMountSettings({ projectSlug, site, portalAddress, tutiAddress }: { projectSlug: string; site: Site | null; portalAddress: string; tutiAddress: string }) {
  if (!site) {
    return <AddSiteForm projectSlug={projectSlug} portalAddress={portalAddress} />;
  }
  const verified = site.status === "verified";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-all">{site.url.replace(/^https?:\/\//, "")}</span>
        <Badge variant={verified ? "default" : "secondary"}>{verified ? "Verified" : "Waiting for your site"}</Badge>
      </div>
      {verified ? (
        <>
          <p className="text-sm text-muted-foreground">Your portal answers at {site.url}.</p>
          <ForwardRules rules={site.forward} tutiAddress={tutiAddress} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Show your portal at {site.url}, without visitors leaving your site.</p>
          <SiteSetup url={site.url} rules={site.forward} tutiAddress={tutiAddress} />
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {!verified && <CheckSiteButton projectSlug={projectSlug} url={site.url} />}
        <RemoveSiteButton projectSlug={projectSlug} url={site.url} portalAddress={portalAddress} />
      </div>
    </div>
  );
}

/** A prompt for the team's coding agent (the main way), and the rules to add by hand as the other tab. */
function SiteSetup({ url, rules, tutiAddress }: { url: string; rules: Site["forward"]; tutiAddress: string }) {
  const [tab, setTab] = useState<"prompt" | "rules">("prompt");
  const prompt = sitePrompt({ url, tuti: tutiAddress });
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as "prompt" | "rules")} className="gap-3">
      <TabsList>
        <TabsTrigger value="prompt">Prompt for your agent</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
      </TabsList>
      <TabsContent value="prompt">
        <AgentPrompt
          prompt={prompt}
          steps={[
            <>
              Proxy <code>{rules[0]?.from}</code> and <code>{rules[1]?.from}</code> to Tuti
            </>,
            "Test both before handing back",
          ]}
        />
      </TabsContent>
      <TabsContent value="rules">
        <ForwardRules rules={rules} tutiAddress={tutiAddress} guides />
      </TabsContent>
    </Tabs>
  );
}

/** Each path the site forwards, and where to: as a proxy, path and all. */
function ForwardRules({ rules, tutiAddress, guides }: { rules: Site["forward"]; tutiAddress: string; guides?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-lg border">
        {rules.map((rule) => (
          <li key={rule.from} aria-label={`Forward ${rule.from}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pr-1.5 pl-3 font-mono text-xs">
            <code>{rule.from}</code>
            <ArrowRightIcon aria-label="to" className="size-3.5 text-muted-foreground" />
            <code className="min-w-0 flex-1 break-all">{rule.to}</code>
            <CopyButton value={rule.to} label={`where ${rule.from} goes`} />
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        {rules[0] && <>Forward {rules[0].from.replace(/\/\*$/, "")} itself too. </>}A proxy, not a redirect, with Host{" "}
        <code className="font-mono text-xs text-foreground">{new URL(tutiAddress).host}</code>.
        {guides && (
          <>
            {" "}
            <a href={SITE_PATH_DOCS} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
              Guides
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/** The site's address and the path, as two fields: saveSite puts them together. */
function AddSiteForm({ projectSlug, portalAddress }: { projectSlug: string; portalAddress: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveSite(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col divide-y">
      <SettingRow label="Your site" description="The site your portal goes under." htmlFor="site-origin">
        <Input
          id="site-origin"
          name="site"
          required
          maxLength={300}
          placeholder="https://yourcompany.com"
          autoComplete="off"
          aria-invalid={state.error ? true : undefined}
          aria-describedby="site-origin-description"
          className="@min-[34rem]/settings:w-72"
        />
      </SettingRow>
      <SettingRow label="Path" description="Where on it, like /help or /support." info={`Until it's checked, your portal stays at ${portalAddress}.`} htmlFor="site-path">
        <Input
          id="site-path"
          name="path"
          required
          maxLength={200}
          placeholder="/help"
          autoComplete="off"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "site-path-description site-error" : "site-path-description"}
          className="@min-[34rem]/settings:w-72"
        />
      </SettingRow>
      <SettingBlock className="gap-3">
        {state.error && <FieldError id="site-error">{state.error}</FieldError>}
        <Button type="submit" disabled={pending} focusableWhenDisabled className="self-end">
          {pending ? "Setting up…" : "Set up sub-folder"}
        </Button>
      </SettingBlock>
    </form>
  );
}

function CheckSiteButton({ projectSlug, url }: { projectSlug: string; url: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      disabled={pending}
      focusableWhenDisabled
      onClick={() =>
        startTransition(async () => {
          const result = await verifySiteSetup(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Your portal is at ${url}`);
          }
        })
      }
    >
      {pending ? "Checking…" : "Check setup"}
    </Button>
  );
}

function RemoveSiteButton({ projectSlug, url, portalAddress }: { projectSlug: string; url: string; portalAddress: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive" disabled={pending} />}>Remove sub-folder</AlertDialogTrigger>
      <AlertDialogContent closeDisabled={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Stop using {url}?</AlertDialogTitle>
          <AlertDialogDescription>Your portal stops answering there. It stays at {portalAddress}.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeSiteMount(projectSlug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${url} removed`);
                }
              })
            }
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
