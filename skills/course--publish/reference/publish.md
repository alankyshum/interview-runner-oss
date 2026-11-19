# Publish content

1. Identify the selected content checkout and the package host from `config.json`. Ensure the configured Git remote and ref are the intended target. With `content.path`, the host must be able to access the updated local checkout; a Git push alone does not update a different host's local path.
2. Inspect `git status --short` and the intended diff. Do not stage unrelated changes or learner work. Validate using `make validate` on the host, or `npm run ir -- course validate <content-checkout>` from the package checkout. Fix reported errors, then validate again. No server needs to run for the CLI.
3. If the user authorized publication, stage only the intended files and commit with an informative message; push the configured content branch/ref using normal Git protections. If rejected because the remote advanced, stop and resolve with the user rather than force-pushing or automatically overwriting their work.
4. On the host, run `make sync` to refresh the rebuildable content cache from the configured source. Report the commit, target ref, validation and sync outcomes. If host access or sync is unavailable, state that the new content has not been verified live.
