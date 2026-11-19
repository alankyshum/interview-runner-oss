# Japanese speech browser regression fixture

This fixture is not a published course. Link it to an isolated staging server; never use the live course links or state. From the runner root:

```sh
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/jp-speech-fixture.XXXXXX")
mkdir -p "$ROOT/source/interview-runner" "$ROOT/home" "$ROOT/tmp"
node - "$ROOT" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2];
const marker = JSON.parse(fs.readFileSync('interview-runner.json', 'utf8'));
fs.writeFileSync(`${root}/source/interview-runner/links.json`, JSON.stringify({
  version: 1,
  runners: { [marker.repo]: { path: process.cwd(), supportedCourseSchema: marker.courseSchema } },
  courses: { fixture: { path: `${process.cwd()}/scripts/fixtures/japanese-speech`, runner: marker.repo, schema: marker.courseSchema } },
}));
NODE
env -i PATH="$PATH" HOME="$ROOT/home" TMPDIR="$ROOT/tmp" \
  XDG_STATE_HOME="$ROOT/source" STAGING_STATE_DIR="$ROOT/staging" \
  STAGING_PORT=5199 INTERVIEW_RUNNER_STATE_ORIGIN='' npm run staging
```

In another terminal, attach a dedicated pinned `agent-browser` session to the verified local CDP service as described by its skill, open `http://127.0.0.1:5199/`, then run:

```sh
env -i HOME="$HOME" PATH="$PATH" node scripts/japanese-speech-browser.mjs SESSION http://127.0.0.1:5199
```

The test uses the real map reader and mocks only speech synthesis. It checks every corner of both buttons, their count, branch toggles and the initial phone fit against the plain counterpart. Stop the staging server afterwards.
