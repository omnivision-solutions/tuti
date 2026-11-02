---
title: "Screens follow the design rules in docs/design.md"
scope: "file"
path: ["apps/web/src/**/*.tsx", "apps/web/src/**/*.css"]
severity_min: "medium"
---
## Instructions
`docs/design.md` holds Tuti's design rules: brand, tokens, layout, the admin app's shell and the patterns every screen uses. Read the section that covers the changed screen and report where the change breaks it, quoting the rule. For example: an admin page built outside the sidebar shell, colours or radii hard-coded instead of the tokens, or a pattern that `docs/design.md` replaces with a shared component.
