/**
 * Where a published help article is served (ArticleListing in the schema, lowercase in the API):
 * see the descriptions. A draft is served nowhere, whatever its listing.
 */
export const LISTINGS = ["everywhere", "unlisted", "hidden", "ai_only"] as const;
export type Listing = (typeof LISTINGS)[number];

export const LISTING_LABELS: Record<Listing, string> = {
  everywhere: "Everywhere",
  unlisted: "Unlisted",
  hidden: "Hidden",
  ai_only: "AI only",
};

export const LISTING_DESCRIPTIONS: Record<Listing, string> = {
  everywhere: "In your help center, search, the widget and AI answers.",
  unlisted: "Anyone with the link can read it, but it's in no list or search. AI answers can cite it.",
  hidden: "Stays published, but isn't shown anywhere, not even at its link.",
  ai_only: "AI answers use it and name it without a link. It has no page and isn't in any list or search.",
};
