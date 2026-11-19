# Interview runner agent guide

## Self-host setup (for a setup agent)

Prerequisites: Docker or Podman with Compose support, Git, and Make. The package's `VERSION` file is the canonical release/stack version; the shipped skill `stackVersion` values must match it.

1. Write the package's read-only `config.json` with the instance name `stack`, exposed `port`, either `content: { "git": "<repository URL>", "ref": "<ref>" }` or `content: { "path": "<local content checkout>" }`, and the configured `db` path; `config.example.json` works unchanged with the bundled `sample-content/`. Optional keys: `owner` (default workspace and content namespace) and `private` (a directory of personal editor settings and the legacy-reading list, kept outside the package). Use the supported Makefile contract for the paths and values; do not invent credentials or defaults.
2. Run `make up`. Content is sourced from the configured Git repository or path; the content database is a rebuildable cache. Use `make sync` after content changes.
3. Install copies of `skills/course--author` and `skills/course--publish` into the user's agent skill directory, for example `~/.claude/skills/` or the agent's equivalent. Record the installed `stackVersion` from each `SKILL.md`.
4. On every session/setup, compare each installed skill's frontmatter `stackVersion` with the package's `VERSION` file (`config.json`'s `stack` is the instance name, not a version). If absent or different, reinstall that skill from the matching package release before using it. Never silently keep a mismatched copy.

Run `make validate` for the configured repository; from a checkout with the Node toolchain, `npm run ir -- course validate <repo-or-courses-dir>` validates directly and `npm run ir -- course migrate <dir> --dry-run` previews migration. `schema/course.v2.json` is the published structural schema; the CLI also enforces parser and filesystem rules.

Course content belongs in a linked repository marked by `interview-courses.json`; runner features belong here. Resolve links through `${XDG_STATE_HOME:-$HOME/.local/state}/interview-runner/links.json` or the global `course--author` skill. This runner is identified by `interview-runner.json`. Never restore a sibling-path or environment-variable fallback.

## Extension points

- `shared/courseSchema.ts`: browser/server manifest contract. Bump `courseSchema` in `interview-runner.json` only with a content migration.
- `server/courseRepos.ts`: link/marker validation and course ownership.
- `server/outlines.ts`, `server/apiPlugin.ts`, `server/db.ts`: content reads, API/runtime routing, and personal state.
- `server/sandboxd.ts`, `server/sandboxd-entry.ts`, `server/sandboxProxy.ts`, `server/sandboxClient.ts`: isolated workspace control, same-origin HTTP/WebSocket proxying, and local/Podman drivers.
- `sandbox/`: sandbox entrypoint, settings, workspace Git/file tools (`workspace-git.mjs`, `workspace-files.mjs`), and test tools; `templates/ai-coding/`: authoring scaffold templates.
- `src/course/*`: course and Library UI.
- `scripts/*`: authoring/validation adapters, separate CLI entries, and server bundling. `server/cheatsheets.ts` serves cheatsheets from their owning course repositories.
- `compose.yaml` plus `npm run compose:repos`: base deployment and generated repository mounts.

Podman coding Git history belongs under the live `sandbox/.workspace-git/` settings bind; local-driver history remains in XDG state. Preserve the ignored history directory across deployments and do not recursively chown course workspaces.

## Gates

New lesson, concept and book chapter content uses `contentType: "map"` and `mindmaps/<course-id>/<drill-id>.md`. Only a learning/book-course based on a single published book or talk declares top-level `"book": true`; only marked courses appear in Books. Maps and outlines do not designate books. Reading drills are deprecated and accepted only for the frozen pairs a host lists in `legacy-reading.json` in its private directory (`private` in `config.json`; none by default); do not automatically regenerate or extend that list. Shared validation rejects all other reading drills.

Use a temporary `XDG_STATE_HOME` in tests and local automation. Run `npm run typecheck && npm run lint && npm run build && npm run test:runner`; run `RUNNER_SANDBOX_IT=1` against both local and Podman drivers and `npm run sandbox:parity` for sandbox changes. Where `scripts/ensure-seed-headers.py` is present, run `python3 scripts/ensure-seed-headers.py <courses-repo>` twice and verify byte identity when changing seed contracts.

Python drills require Python 3.12 and pytest locally. The runner image installs Python 3.12.12 and pytest 9.0.1 with pinned uv 0.9.5 for optional deterministic watchers. basedpyright and Ruff run only inside the sandbox image/editor extensions; they are not runner dependencies.

Never commit `.env*`, `progress.db*`, `.vitest-report.json`, `compose.repos.yaml`, `course-repos.links.json`, or `course-repos.sandbox.json`. Never delete live or production data: the production stack's data directory and user database, and the old stack's `interview-runner_progress` and legacy `ir-ws-*` volumes while they are the rollback path. Never run `compose down` against the live stack; `make down` and removing test or staging resources are allowed when the user has explicitly approved them. Do not mutate course content for a runner feature except through an explicitly authorized drill save.

Where `.agents/feature-map/` is present: for vague or feature-level work, read .agents/feature-map/README.md and the matching feature file; update it with user-facing changes. Before releases, review affected features using feature-map-refresh and write the semantic stamp only after review.
