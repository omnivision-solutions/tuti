/** What a team can say it will use, after "Create project" (project.update's `uses`): Home's "Get set up" follows it. */
export const PROJECT_USES = {
  feedback: { label: "Feedback", description: "Ideas and votes from your users, and a roadmap" },
  docs: { label: "Docs", description: "A help center your users can search" },
  changelog: { label: "Changelog", description: "What's new, in the portal and the widget" },
  support: { label: "Support", description: "An inbox for your users' messages, once you turn it on" },
} as const;

export type ProjectUse = keyof typeof PROJECT_USES;

export const PROJECT_USE_KEYS = Object.keys(PROJECT_USES) as [ProjectUse, ...ProjectUse[]];
