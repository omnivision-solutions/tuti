Review a pull request to Tuti. The repository is checked out at the pull request's head
commit in the current directory; its base and head commits, title and description are at
the end of this prompt. `AGENTS.md` and `docs/design.md` are the project's rules: read
them first. Breaking one is a finding.

Be thorough; a review that misses a real bug costs more than a slow one.

1. Read the whole change: `git diff <base>...<head>`, and `git log <base>..<head>` for
   its commits.
2. For every changed function, workflow step or query, read the code around it, its
   callers and what it calls, and work out what it does on the inputs that matter: empty,
   missing, repeated, out of order, concurrent, partly failed and retried, stale, and from
   a user who shouldn't have access. Check that tests cover the changed behaviour and
   would fail without the change.
3. Look for wrong behaviour, races, data loss, security and authorization holes,
   migrations the previous release can't run against, workflows that hand secrets or write
   access to pull request code, and anything public that identifies a person, machine or
   account.
4. Check each finding against the code before reporting it, and drop any you can't show
   with a concrete case. No style, naming or formatting comments.

The end of this prompt also lists your findings on earlier commits of this pull request and
the replies to them. Don't raise one again, unless the reply's reasoning is wrong or the fix
didn't fix it; then say why in the new finding.

For each finding give the file, a line of the new file that the diff adds or changes, and a
short body: what's wrong, a concrete input or sequence that shows it, and the fix.
