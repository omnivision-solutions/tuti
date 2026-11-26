/**
 * Characters that don't show where text is read but reach whoever gets it as text: Unicode's default-ignorable code
 * points (tag characters U+E0000–U+E007F, zero-width spaces and joiners, variation selectors) and bidi controls. A
 * screenshot's description goes to an agent signed in to the team's app, so one with them is refused: what the team
 * reads must be all the agent reads. (A zero-width joiner in an emoji counts too.)
 */
const HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;

export const hasHiddenCharacters = (text: string) => HIDDEN.test(text);

export const HIDDEN_CHARACTERS = "has characters that don't show but the agent would read: type it again";
