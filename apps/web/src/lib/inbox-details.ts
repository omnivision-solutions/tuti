/**
 * Set ("1") while the column beside a conversation is hidden in this browser (DetailsToggle); its page reads it, so it
 * loads that way. Not sensitive: only how the page is laid out.
 */
export const DETAILS_HIDDEN_COOKIE = "tuti_inbox_details_hidden";

/**
 * The time (ms) of the latest refresh one of the Inbox's actions asked for (refreshAfterAction), which its page renders
 * back to the list (ListKeys' `refreshed`): a render of the list from a refresh asked for before the action (still on
 * its way as it saved) has an older one, so it isn't taken for the action's answer. Not sensitive: only a time.
 */
export const INBOX_REFRESH_COOKIE = "tuti_inbox_refresh";
