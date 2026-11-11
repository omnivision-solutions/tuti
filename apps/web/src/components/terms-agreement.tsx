/**
 * "By signing up, you agree to …" where someone signs up or buys on tuti.so: sign-up, sign-in when it offers
 * Continue with Google or GitHub (which signs up someone new), and buying a licence. Callers show it only there. The pages are
 * the marketing site's (apps/marketing), on the same domain: plain links, not the app's client navigation.
 */
export function TermsAgreement({ by }: { by: string }) {
  const link = "underline underline-offset-4 hover:text-foreground";
  return (
    <p className="text-center text-sm text-muted-foreground">
      By {by}, you agree to the{" "}
      <a href="/terms" className={link}>
        Terms of Service
      </a>{" "}
      and{" "}
      <a href="/privacy" className={link}>
        Privacy Policy
      </a>
      .
    </p>
  );
}
