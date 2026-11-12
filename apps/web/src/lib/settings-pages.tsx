import { BoxesIcon, CodeXmlIcon, CpuIcon, CreditCardIcon, DownloadIcon, GitPullRequestArrowIcon, GlobeIcon, HandCoinsIcon, InboxIcon, KeyRoundIcon, PenLineIcon, PlugIcon, Settings2Icon, ShieldIcon, SparklesIcon, TablePropertiesIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { aiEnabled, codeChangesEnabled } from "@tuti/shared";

export type SettingsGroup = { title: string; pages: { title: string; href: string; icon?: ReactNode }[] };

/** Settings' menu, in groups; `admin`: owners and admins see every page, other team members Team & roles. */
export function settingsGroups(slug: string, admin: boolean): SettingsGroup[] {
  const at = (path: string) => `/app/${slug}/settings/${path}`;
  const groups: SettingsGroup[] = [
    {
      title: "Project",
      pages: [
        { title: "General", href: at("general"), icon: <Settings2Icon aria-hidden /> },
        { title: "Team & roles", href: at("team"), icon: <UsersIcon aria-hidden /> },
        { title: "Access", href: at("access"), icon: <ShieldIcon aria-hidden /> },
        { title: "Single sign-on", href: at("sso"), icon: <KeyRoundIcon aria-hidden /> },
        { title: "Domain", href: at("domain"), icon: <GlobeIcon aria-hidden /> },
        { title: "Import", href: at("import"), icon: <DownloadIcon aria-hidden /> },
      ],
    },
    {
      title: "Users",
      pages: [
        { title: "Groups", href: at("groups"), icon: <BoxesIcon aria-hidden /> },
        { title: "Who's asking", href: at("asking"), icon: <HandCoinsIcon aria-hidden /> },
        { title: "User properties", href: at("properties"), icon: <TablePropertiesIcon aria-hidden /> },
      ],
    },
    {
      title: "Support",
      pages: [
        { title: "Inbox and email", href: at("support"), icon: <InboxIcon aria-hidden /> },
      ],
    },
    {
      title: "AI",
      // How it answers can be set before the server has AI (as it could in Customize); which models, only with it.
      pages: [
        { title: "AI answers", href: at("ai-answers"), icon: <SparklesIcon aria-hidden /> },
        ...(aiEnabled()
          ? [
              { title: "Writing style", href: at("writing-style"), icon: <PenLineIcon aria-hidden /> },
              // Analysing merged pull requests needs AI too (codeChangesEnabled).
              ...(codeChangesEnabled() ? [{ title: "Autopilot", href: at("autopilot"), icon: <GitPullRequestArrowIcon aria-hidden /> }] : []),
              { title: "AI models", href: at("ai-models"), icon: <CpuIcon aria-hidden /> },
            ]
          : []),
      ],
    },
    {
      title: "Connections",
      pages: [
        { title: "Integrations", href: at("integrations"), icon: <PlugIcon aria-hidden /> },
        { title: "Developers", href: at("developers"), icon: <CodeXmlIcon aria-hidden /> },
      ],
    },
    { title: "Billing", pages: [{ title: "Billing", href: at("billing"), icon: <CreditCardIcon aria-hidden /> }] },
  ];
  return (admin ? groups : groups.map((group) => ({ ...group, pages: group.pages.filter((page) => page.href === at("team")) })))
    .filter((group) => group.pages.length > 0);
}
