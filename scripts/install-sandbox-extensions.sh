#!/bin/sh
set -eu
command -v code-server >/dev/null 2>&1 || { echo 'code-server is required; install it with: brew install code-server' >&2; exit 1; }
directory=${CODE_SERVER_EXTENSIONS_DIR:-"${HOME}/.cache/interview-runner/code-server/extensions"}
mkdir -p "$directory"
for extension in \
  ms-python.python@2026.4.0 \
  ms-python.debugpy@2026.6.0 \
  ms-python.vscode-python-envs@1.40.0 \
  detachhead.basedpyright@1.40.2 \
  charliermarsh.ruff@2026.90.0 \
  esbenp.prettier-vscode@12.4.0
do code-server --extensions-dir "$directory" --install-extension "$extension"
done
