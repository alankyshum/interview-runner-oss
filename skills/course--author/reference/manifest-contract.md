# Manifest and authoring contract

The content Git repository is the source of truth. It contains `interview-courses.json` with `kind: "interview-runner-courses"` and the repository-wide integer `schema`, and `courses/<id>.json` for each course or cheatsheet. Do not edit the schema marker by hand to avoid a migration; use the package's `npm run ir -- course migrate <content-checkout> --dry-run` first, then migrate after reviewing. The CLI refuses schemas newer than this stack; UI drills retired in schema 2 require a human replacement, not a mechanical rewrite.

The package's `schema/course.v2.json` describes structural fields; `make validate` and the shared parser additionally check IDs, lesson compatibility, path conventions, legacy-reading policy, file contents and tests. The manifest filename must match its lowercase alphanumeric/hyphen `id`; chapter IDs must be unique within a course and lesson IDs unique throughout it. Keep IDs stable because learner state refers to them. Never use absolute paths, `..`, symlinks to escape the repo, or backslashes in manifest paths.

## Maps and books

New lessons and book chapters use `{ "contentType": "map", "kind": "scratch" }` with `sourcePath: "mindmaps/<course-id>/<lesson-id>.md"`, an `id`, `title`, finite nonnegative `estMinutes`, and nonempty `instructions`. For a course sourced from one published book or talk, add `"book": true` at the course root; a map alone is not a book. A `"type": "map-recall"` course starts with a map and may contain more maps, recall, or whiteboard lessons. A plain course may also include maps, coding, AI-coding, and whiteboards. New reading drills are deprecated: only the runner's frozen legacy pairs are accepted.

Use the copied `scripts/map-drill.mjs` to print a map entry, for example:

```sh
node <installed-skill>/scripts/map-drill.mjs --course example --id chapter-one --title 'Chapter one' --minutes 15 --instructions 'Explore the map.'
```

Author the Markdown map as a strict tree with explanatory prose. Keep source and learner-state IDs stable. Review the rendered result when a runner is available.

## Coding and cheatsheets

Coding uses `contentType: "coding"`, `kind: "logic"`, a TypeScript `.ts` source and `.test.ts`/`.test.tsx` behavioral test or the fixed Python `drills/<course>/<drill>/<drill_with_underscores>.py` and `test_<drill_with_underscores>.py` pair. Tests must import and exercise learner code and cannot be skipped placeholders. AI-coding specifies its workspace, runner, handoff and rubric; refer to `schema/course.v2.json` and the parser before authoring. Do not write answer code into a starter file or hint.

A cheatsheet has `type: "cheatsheet"`, `id`, `title`, and nonempty `chapters` with nonempty `drills`. Each section uses `contentType: "cheatsheet"`, `headingLevel` 1–6, and `sourcePath: "cheatsheets/<id>/sections/<lesson-id>.html"`; an optional mindmap path lives under `cheatsheets/<id>/diagrams/mindmaps/`. See the schema for other fields.

## Validate and migrate

Run `make validate` against the host's configured content. From a package checkout with Node and dependencies installed, `npm run ir -- course validate <content-repo-or-courses-dir>` runs without starting the server. It validates manifests, referenced paths and behavioral tests. Migration preflights every manifest before changing anything, keeps already-valid v1 manifests intact, and updates the repository marker only after preflight. It rejects retired shapes that cannot be safely converted. Back up or commit the content repository before migration and review the resulting diff.
