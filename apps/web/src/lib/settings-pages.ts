import { aiEnabled, creditsEnabled, plansEnabled } from "@tuti/shared";

export type SettingsGroup = { title: string; pages: { title: string; href: string }[] };

/** Settings' menu, in groups; `admin`: owners and admins see every page, other team members Team & roles. */
export function settingsGroups(slug: string, admin: boolean): SettingsGroup[] {
  const at = (path: string) => `/app/${slug}/settings/${path}`;
  const groups: SettingsGroup[] = [
    {
      title: "Project",
      pages: [
        { title: "Team & roles", href: at("team") },
        { title: "Access", href: at("access") },
        { title: "Single sign-on", href: at("sso") },
      ],
    },
    { title: "Support", pages: [{ title: "Inbox and email", href: at("support") }] },
    { title: "AI", pages: aiEnabled() ? [{ title: "Models", href: at("ai-models") }] : [] },
    {
      title: "Connections",
      pages: [
        { title: "Integrations", href: at("integrations") },
        { title: "Developers", href: at("developers") },
      ],
    },
    {
      title: "Billing",
      pages: [
        ...(creditsEnabled() || plansEnabled() ? [{ title: "Billing", href: at("billing") }] : []),
        { title: "Usage", href: at("usage") },
      ],
    },
  ];
  return (admin ? groups : groups.map((group) => ({ ...group, pages: group.pages.filter((page) => page.href === at("team")) })))
    .filter((group) => group.pages.length > 0);
}
