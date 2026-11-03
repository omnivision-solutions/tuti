/**
 * For one of the panel's listeners to the page (useWidgetSignIn's): whether a result is the page saying it
 * signs nobody in, to this listener. A sign-out counts only if this listener heard it coming (`signingOut`)
 * with nothing since: one already on its way when it started listening answers an earlier ask, not its own.
 */
export function heardSignOut() {
  let coming = false;
  return (result: object) => {
    const nobody = coming && "signedOut" in result;
    coming = "signingOut" in result;
    return nobody;
  };
}
