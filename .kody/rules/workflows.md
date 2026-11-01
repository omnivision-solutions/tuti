---
title: "CI never needs secrets or runs PR code with write access"
scope: "file"
path: [".github/workflows/**"]
severity_min: "high"
---
## Instructions
CI runs pull requests from forks.
- A workflow must never need secrets to pass.
- A workflow triggered by `pull_request_target` has write access and secrets: it must never check out or run the pull request's code.
