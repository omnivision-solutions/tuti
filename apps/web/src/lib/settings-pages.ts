import { emailConfigured } from "@tuti/email";
import { aiEnabled } from "@tuti/shared";

export type SettingsGroup = { title: string; pages: { title: string; href: string }[] };

/** Settings' menu, in groups; `admin`: owners and admins see every page, other team members Team & roles. */
export function settingsGroups(slug: string, admin: boolean): SettingsGroup[] {
  const at = (path: string) => `/app/${slug}/settings/${path}`;
  const groups: SettingsGroup[] = [
    {
      title: "Project",
      pages: [
        { title: "General", href: at("general") },
        { title: "Team & roles", href: at("team") },
        { title: "Access", href: at("access") },
        { title: "Single sign-on", href: at("sso") },
        { title: "Domain", href: at("domain") },
      ],
    },
    {
      title: "Support",
      pages: [
        { title: "Inbox and email", href: at("support") },
        // It emails the team, so only where this server sends email.
        ...(emailConfigured() ? [{ title: "Ask a person", href: at("ask-a-person") }] : []),
      ],
    },
    {
      title: "AI",
      // How it answers can be set before the server has AI (as it could in Customize); which models, only with it.
      pages: [{ title: "AI answers", href: at("ai-answers") }, ...(aiEnabled() ? [{ title: "Models", href: at("ai-models") }] : [])],
    },
    {
      title: "Connections",
      pages: [
        { title: "Integrations", href: at("integrations") },
        { title: "Developers", href: at("developers") },
      ],
    },
    { title: "Billing", pages: [{ title: "Billing", href: at("billing") }] },
  ];
  return (admin ? groups : groups.map((group) => ({ ...group, pages: group.pages.filter((page) => page.href === at("team")) })))
    .filter((group) => group.pages.length > 0);
}
