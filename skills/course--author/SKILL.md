---
name: course--author
description: Author and validate interview-runner course content in a self-hosted Git content repository.
stackVersion: 0.1.0
---

# Course authoring

Identify the user's content repository from the package's `config.json` or an explicitly selected checkout. Write course content only there; do not overwrite learner work. Runner changes belong in the runner package and require separate authorization.

- Start with `reference/manifest-contract.md` for the manifest and validation contract.
- For instructional content use `reference/learner-profile.md`; for time-limited plans use `reference/schedule-fit.md`.
- For publishing use the `course--publish` skill. Validation does not publish.

Preserve course, chapter, lesson, and question IDs. New reading, lesson and book-chapter content is a map; do not create new legacy reading drills. Never solve a learner exercise in its prompt or weaken tests to make unfinished work pass. Before delivery run `make validate` on the host for the configured content, or `npm run ir -- course validate <content-checkout>` from the package checkout. Report failures and unverified checks.
