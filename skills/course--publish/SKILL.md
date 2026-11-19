---
name: course--publish
description: Validate and publish self-hosted interview-runner course content through its Git repository.
stackVersion: 0.1.0
---

# Course publishing

Read `reference/publish.md`. Publish only when the user has authorized the commit and push. The Git content repository is the source of truth; `make sync` refreshes the host after the push. Validation is read-only and does not publish. Never overwrite unrelated content or resolve a Git conflict by force.
