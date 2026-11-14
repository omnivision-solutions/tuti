import type { ReactNode } from "react";

import {
  CellChangelog,
  CellDomain,
  CellDuplicate,
  CellEmail,
  CellFeedback,
  CellHelp,
  CellImport,
  CellInbox,
  CellInsert,
  CellLinked,
  CellReactions,
  CellReporting,
  CellReview,
  CellRoadmap,
  CellSubscribe,
  CellVerify,
  CellWidget,
  HeroAsk,
  HeroAutopilot,
  HeroChangelog,
  HeroFeedback,
  HeroHelp,
  HeroInbox,
  HeroWidget,
  StepArticle,
  StepChangelog,
  StepRequest,
} from "../../scenes";

/**
 * Each feature page's words and pictures (features.ts names the features). Short and picture-led, like the home page:
 * a headline of 8 words or fewer, one sentence under it, and sections of a title and a line of 10 words or fewer.
 */
export type Section = { title: string; line: string; picture: ReactNode; wide?: boolean; dark?: boolean };
export type FeatureContent = { headline: string; sub: string; url: string; hero: ReactNode; sections: Section[]; related: string[] };

export const CONTENT: Record<string, FeatureContent> = {
  "help-center": {
    headline: "Answers customers find on their own.",
    sub: "A fast help center on your domain, with search and AI answers in one box.",
    url: "help.lumen.app",
    hero: <HeroHelp />,
    sections: [
      { title: "Checked against your code.", line: "Verify flags any line the code no longer backs.", picture: <CellVerify />, dark: true },
      { title: "See what customers can't find.", line: "Searches that found nothing, most asked first.", picture: <CellReporting /> },
      { title: "On your domain.", line: "With your logo, colours and fonts.", picture: <CellDomain /> },
      { title: "Bring your articles with you.", line: "Import from Intercom, Ferndesk and more. Old links redirect.", picture: <CellImport /> },
    ],
    related: ["ai-answers", "autopilot", "widget"],
  },
  "ai-answers": {
    headline: "Answers in seconds, from your help center.",
    sub: "Customers ask in their own words, and Tuti answers from your articles.",
    url: "help.lumen.app",
    hero: <HeroAsk />,
    sections: [
      { title: "Every answer cited.", line: "Each one links the articles it came from.", picture: <CellHelp />, wide: true },
      { title: "Your team takes the rest.", line: "Ask a person, and it lands in your inbox.", picture: <CellInbox /> },
      { title: "Inside your app.", line: "The same answers in the widget.", picture: <CellWidget /> },
    ],
    related: ["help-center", "inbox", "widget"],
  },
  autopilot: {
    headline: "Ship code. Everything customers see keeps up.",
    sub: "When a pull request merges, Tuti updates your help center, feature requests and changelog.",
    url: "tuti.so/app/lumen/autopilot",
    hero: <HeroAutopilot />,
    sections: [
      { title: "Help center rewritten.", line: "The article now says what shipped.", picture: <StepArticle /> },
      { title: "Feature request completed.", line: "Every voter gets the news.", picture: <StepRequest /> },
      { title: "Changelog drafted.", line: "Ready to publish, in your words.", picture: <StepChangelog /> },
      { title: "You stay in charge.", line: "Approve each change, or let it go out.", picture: <CellReview /> },
    ],
    related: ["help-center", "feedback", "changelog"],
  },
  inbox: {
    headline: "Every conversation, one inbox.",
    sub: "Widget messages and emails in one place, with AI answering first.",
    url: "tuti.so/app/lumen/inbox",
    hero: <HeroInbox />,
    sections: [
      { title: "Email lands here too.", line: "Customers reply by email, in the same conversation.", picture: <CellEmail /> },
      { title: "Answer with an article.", line: "Drop a help article into any reply.", picture: <CellInsert /> },
      { title: "Link it to a feature request.", line: "See every customer who asked for it.", picture: <CellLinked />, wide: true },
    ],
    related: ["ai-answers", "widget", "feedback"],
  },
  widget: {
    headline: "Help, right inside your app.",
    sub: "One script tag adds help, messages, feature requests and what's new.",
    url: "app.lumen.app",
    hero: <HeroWidget />,
    sections: [
      { title: "Answers where they're stuck.", line: "Search and AI answers, without leaving your app.", picture: <CellHelp />, wide: true },
      { title: "Messages to your team.", line: "They land in your inbox.", picture: <CellInbox /> },
      { title: "Feature requests and votes.", line: "Customers share ideas where they use them.", picture: <CellFeedback /> },
      { title: "What's new.", line: "Your latest changelog, one click away.", picture: <CellChangelog />, wide: true },
    ],
    related: ["help-center", "inbox", "changelog"],
  },
  feedback: {
    headline: "Know what customers want most.",
    sub: "A feedback board where customers post feature requests and vote on them.",
    url: "help.lumen.app/feedback",
    hero: <HeroFeedback />,
    sections: [
      { title: "Duplicates caught.", line: "Tuti spots the same idea twice. Merge in a click.", picture: <CellDuplicate /> },
      { title: "From every conversation.", line: "Link inbox conversations to the feature request.", picture: <CellLinked /> },
      { title: "Voters hear it shipped.", line: "Completing a feature request emails everyone who voted.", picture: <StepRequest />, wide: true },
    ],
    related: ["roadmap", "changelog", "autopilot"],
  },
  roadmap: {
    headline: "Show customers what's coming.",
    sub: "A public roadmap of what's planned, in progress and done.",
    url: "help.lumen.app/roadmap",
    hero: <CellRoadmap hero />,
    sections: [
      { title: "Built from feature requests.", line: "The most voted rise to the top.", picture: <CellFeedback /> },
      { title: "Shipped means told.", line: "Voters get an email when it's done.", picture: <StepRequest /> },
      { title: "Know who's waiting.", line: "Every vote and conversation, on each feature request.", picture: <CellLinked />, wide: true },
    ],
    related: ["feedback", "changelog", "autopilot"],
  },
  changelog: {
    headline: "Tell everyone it shipped.",
    sub: "A changelog on your help center, in your app and in their inbox.",
    url: "help.lumen.app/changelog",
    hero: <HeroChangelog />,
    sections: [
      { title: "Drafted from your merges.", line: "Autopilot writes the entry. You publish it.", picture: <StepChangelog />, wide: true },
      { title: "In their inbox.", line: "Subscribers get each entry by email.", picture: <CellSubscribe /> },
      { title: "See what lands.", line: "Customers react to every entry.", picture: <CellReactions /> },
    ],
    related: ["autopilot", "widget", "roadmap"],
  },
};
