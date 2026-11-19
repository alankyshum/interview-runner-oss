# Interview runner

A self-hosted, Coursera-style runner for interview practice. You write courses as plain files in a Git repository; the runner shows them in a browser with:

- **Maps**: lessons as foldable mind maps, with highlights and recall questions.
- **Coding drills**: each one opens an isolated VS Code (code-server) workspace in the browser, with tests you run from the page. TypeScript (Vitest) and Python (pytest) are supported.
- **AI-coding drills**: staged, multi-file exercises with an interviewer handoff and a rubric.
- **Whiteboards and cheatsheets**: timed design prompts and printable reference sheets.
- **A library**: categories, deadlines, progress and attempt history, kept in one SQLite file you own.

It runs on one machine with Podman or Docker. A fresh install starts with one small sample course.

## Quick start

You need Git, Make, and Podman or Docker with Compose (see [Container engine](#container-engine)).

```sh
git clone https://github.com/alankyshum/interview-runner-oss
cd interview-runner-oss
cp config.example.json config.json
make up
```

`make up` pulls the images, imports the sample course and starts the stack. When it finishes it prints the address: open **http://127.0.0.1:8081**.

The example configuration works as it is. It serves the bundled `sample-content/` and keeps your data in `./data/`. If port 8081 is taken, change `port` in `config.json` and run `make up` again.

To try the sandbox, open **Sample course → Largest sum of k consecutive numbers**. The editor loads in the page; **Run tests** runs the drill's tests inside the sandbox.

## Configuration

`config.json` is the only configuration and holds no secrets ([schema](config.schema.json)).

| Key | Meaning |
| --- | --- |
| `stack` | Instance name: the Compose project and the container-name prefix. Use a different name for each instance on one machine. |
| `port` | The runner listens on `127.0.0.1:<port>` only. |
| `content` | Where your courses come from. `{"path": "./sample-content"}` mounts a directory read-only. `{"git": "git@github.com:you/courses.git", "ref": "main"}` clones a repository with your own Git credentials. |
| `db` | Path of your SQLite database: progress, coding workspaces, their Git history and editor state. A content cache (`content.db`), the Git checkout, `scratch/` and `backups/` live in the same directory. |
| `owner` | Optional, default `me`. The namespace your courses are imported under, and the workspace the Library opens by default. Pick it before first use: changing it later leaves existing Library placements under the old name. |
| `private` | Optional. A directory of personal overrides kept outside this repository (see [Personal overrides](#personal-overrides)). |

Paths are absolute, or start with `./` and are relative to the directory holding `config.json`. They cannot contain spaces or quotes.

## Commands

| Command | What it does |
| --- | --- |
| `make up` | Pull the images if they are missing, import content, start the stack and wait until it is healthy. |
| `make down` | Stop the stack. Your data stays. |
| `make sync` | Update the content checkout (Git mode) and import it. Unchanged courses keep their revision numbers. |
| `make validate` | Validate the content checkout without importing it. |
| `make backup` | Write a consistent, timestamped copy of your database to `backups/` next to it. |
| `make upgrade` | `git pull`, fetch the matching images, back up, restart. Database migrations run at startup, after the backup. |
| `make pull` | Fetch the images for this version again. |

Variables: `CONFIG=<path>` (default `./config.json`), `RUNTIME=<dir>` for generated files (default `./.runtime`), `ENGINE=podman|docker`, `FETCH=0` to import the existing checkout without contacting Git, `SANDBOX=0` to start without coding sandboxes, and `BUILD=1` to build the images from this checkout instead of pulling them.

## Container engine

- **Images.** `make up` pulls `ghcr.io/alankyshum/interview-runner` and `ghcr.io/alankyshum/interview-runner-sandbox` at the version in `VERSION`. Both are published for `linux/arm64` and `linux/amd64`, so Apple Silicon and Intel/AMD machines get a native image.
- **Building locally.** `make up BUILD=1` builds `localhost/interview-runner*` from the checkout. Pass `BUILD=1` to every later `make` call for that stack. The first build downloads editor extensions and takes several minutes. `make publish` (maintainers, Podman) builds both architectures and pushes them.
- **Podman.** On macOS and Windows start the machine first (`podman machine start`). `podman compose` needs a Compose provider: install `podman-compose` or Docker Compose.
- **Docker.** Docker Desktop or Docker Engine with the Compose plugin works. The Makefile picks the first engine whose daemon answers; set `ENGINE=docker` to choose.
- **Engine socket.** Coding sandboxes are sibling containers started by the `sandboxd` service through the engine's API socket, so that service has full control of the engine. Run the stack only on a machine where that is acceptable.

## Your own courses

Course content lives in its own directory or Git repository, never in this one:

```text
interview-courses.json            {"kind":"interview-runner-courses","runner":"interview-runner/interview-runner","schema":2}
courses/<course-id>.json          one manifest per course or cheatsheet
mindmaps/<course-id>/<id>.md      maps
recall/<course-id>/<id>.json      recall questions and whiteboards
drills/<course-id>/<id>/…         coding and AI-coding files and tests
cheatsheets/<id>/sections/…       cheatsheet sections
images/…                          images used by maps
```

`sample-content/` is a complete, minimal example: copy it to start your own.

1. Create the directory or repository with the layout above.
2. Point `content` in `config.json` at it: `{"path": "/home/you/courses"}`, or `{"git": "<url>", "ref": "main"}` for a repository. In Git mode `make sync` clones and fetches with your own Git credentials; nothing is stored in `config.json`.
3. Run `make validate`, then `make sync` (or `make up` the first time). After every content change, run `make sync` again.

A content directory with no `courses/` yet is fine: the Library starts empty. Courses that disappear from the checkout stay in the Library; content is versioned, and open attempts keep the revision they started on.

Directories under `namespaces/<name>/` in the checkout, each with the same layout, are imported as separate workspaces named `<name>`.

### Course format

`schema/course.v2.json` is the structural schema; `make validate` also checks ids, paths, file contents and tests. `shared/courseSchema.ts` is the parser the server, the tools and the browser share.

- **Map** (`contentType: "map"`, `kind: "scratch"`): `sourcePath: "mindmaps/<course-id>/<drill-id>.md"`, a Markdown outline. Use maps for lessons, concepts and book chapters. A course based on one published book or talk may set top-level `"book": true` to appear under Books.
- **Coding** (`contentType: "coding"`, `kind: "logic"`): a source file and a behavioural `testPath`. TypeScript uses `<drill>.ts` and `<drill>.test.ts`; Python uses `<drill_with_underscores>.py` and `test_<drill_with_underscores>.py`. Tests must import and exercise the learner's code.
- **AI coding** (`contentType: "ai-coding"`): a per-attempt `workspacePath`, an entry `sourcePath` under it, a Vitest or pytest runner, interviewer handoff and rubric Markdown, at least two `## Milestone` stages, and optional hidden acceptance tests per stage. `templates/ai-coding/` holds the handoff and rubric templates.
- **Map + recall course** (top-level `type: "map-recall"`): starts with a map and may add more maps, `recall` lessons and `whiteboard` lessons. Recall JSON is `{ "courseId", "drillId", "title", "questions": [{ "id", "prompt", "answer" }] }`.
- **Whiteboard** (`contentType: "whiteboard"`, `kind: "scratch"`): `sourcePath: "recall/<course-id>/<drill-id>.json"` holding `milestones` with `id`, `prompt`, optional `expectation` and `hint`, and `answer`. Markdown and fenced `mermaid` diagrams are accepted.
- **Cheatsheet** (top-level `type: "cheatsheet"`): chapters of sections, each an HTML fragment at `cheatsheets/<id>/sections/<lesson-id>.html` with a `headingLevel`. The reader sanitizes the HTML and never runs its scripts.
- **Reading drills** are deprecated and rejected by validation. Use maps.

Keep course, chapter, lesson and question ids stable: progress is stored against them.

In coding instructions and hints, put every example under an `## Examples` heading as a fenced block in the drill's language, with the call and its result on one line:

```typescript
Number('42') // -> 42
```

### Authoring with an agent

`skills/course--author` and `skills/course--publish` are agent skills for writing and publishing courses; [AGENTS.md](AGENTS.md) explains how a setup agent installs them and keeps them at the version in `VERSION`.

## Personal overrides

Set `private` in `config.json` to a directory outside this repository. Every file in it is optional:

| File | Effect |
| --- | --- |
| `keybindings.json` | Replaces the sandbox editor's default keybindings (`sandbox/keybindings.json`). |
| `settings.json` | Replaces the sandbox editor's default settings (`sandbox/settings.json`). |
| `legacy-reading.json` | `{"<course-id>": ["<drill-id>"]}`: deprecated reading drills this host still accepts. Empty by default. |

Keybindings and settings you change inside a sandbox editor are written back to the files in this directory, so they apply to the next sandbox as well. Without the files, each sandbox starts from the defaults.

## Access and workspaces

The runner has no login. It listens on loopback only, and **anyone who can reach the port is trusted** with every course and all progress. To use it from other devices, put something you control in front of it, such as `tailscale serve` or an authenticating reverse proxy. Do not publish the port to a network you do not control.

Workspaces (`?workspace=<name>`) are views for organising courses and Library state. They are not a security boundary.

### Content API

Besides `make sync`, content can be published over HTTP with a bearer API key. Keys are issued on the host and shown once:

```sh
podman exec <stack>-runner node server-dist/auth-keys.mjs issue --name author --namespace me --scope content:write
podman exec <stack>-runner node server-dist/auth-keys.mjs list
podman exec <stack>-runner node server-dist/auth-keys.mjs revoke <key-id>
```

With `RUNNER_URL` and `RUNNER_KEY` set:

```sh
curl -H "Authorization: Bearer $RUNNER_KEY" "$RUNNER_URL/api/content/me"
curl -H "Authorization: Bearer $RUNNER_KEY" "$RUNNER_URL/api/content/courses?namespace=me"
curl -X POST -H "Authorization: Bearer $RUNNER_KEY" -H 'Content-Type: application/json' \
  --data '{"sha256":["<sha256>"]}' "$RUNNER_URL/api/content/blobs/missing"
curl -X POST -H "Authorization: Bearer $RUNNER_KEY" -H 'Content-Type: application/octet-stream' \
  -H "X-Blob-Sha256: $SHA256" --data-binary @file "$RUNNER_URL/api/content/blobs"
curl -X PUT -H "Authorization: Bearer $RUNNER_KEY" -H 'Content-Type: application/json' \
  -H 'If-Match: 1' --data-binary @bundle.json "$RUNNER_URL/api/content/courses/<course-id>"
```

Upload missing blobs first, then `PUT` the bundle with the current revision in `If-Match` (omit it to create a course). Keys are scoped to namespaces; `content:write` includes reads. `content-workspaces.mjs` in the same container lists, creates and deletes workspaces.

## Data and backups

Everything personal is in the one SQLite file at `db`. `make backup` copies it consistently while the stack runs. `content.db` next to it is a cache rebuilt by `make sync`, and `scratch/` is refilled from the database when missing. To move to another machine, copy the database file and your `config.json`, then run `make up`.

## Development

Node 24 and npm are needed to work on the runner itself. Development and the test suite read courses straight from a linked content directory. Link the bundled sample content once, in a state directory inside the checkout:

```sh
npm install
npm ci --prefix sandbox
export XDG_STATE_HOME="$PWD/.state"
mkdir -p "$XDG_STATE_HOME/interview-runner"
node -e '
const fs = require("node:fs");
const marker = JSON.parse(fs.readFileSync("interview-runner.json", "utf8"));
fs.writeFileSync(process.env.XDG_STATE_HOME + "/interview-runner/links.json", JSON.stringify({
  version: 1,
  runners: { [marker.repo]: { path: process.cwd(), supportedCourseSchema: marker.courseSchema } },
  courses: { "me/sample-content": { path: process.cwd() + "/sample-content", runner: marker.repo, schema: marker.courseSchema } },
}));'
```

With `XDG_STATE_HOME` exported as above:

```sh
INTERVIEW_RUNNER_CONTENT_SOURCE=files npm run dev   # http://localhost:5173
```

In development, coding drills use a local `code-server` instead of containers: install it (for example `brew install code-server`) and run `npm run sandbox:extensions` once. Progress is kept in `progress.db` in the checkout.

Before sending a change, run:

```sh
npm run typecheck && npm run lint && npm run build && npm run test:runner
```

UI code uses the components in `src/ui` and the `--ir-*` design tokens described in [docs/design-system.md](docs/design-system.md).

## License

[MIT](LICENSE)
