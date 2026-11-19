#!/bin/sh
set -eu

workspace=${IR_WORKSPACE:?IR_WORKSPACE is required}
user_data=${IR_USER_DATA_DIR:-/home/coder/.ir}
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$workspace"
mkdir -p "$user_data/User"
[ -f "$user_data/User/settings.json" ] || cp /opt/ir/settings.json "$user_data/User/settings.json"
[ -f "$user_data/User/keybindings.json" ] || cp /opt/ir/keybindings.json "$user_data/User/keybindings.json"

if [ "${IR_REVIEW:-0}" = 1 ]; then
  if [ "${IR_WORKSPACE_KIND:-coding}" != ai-coding ] || ! git -C "$workspace" rev-parse --verify HEAD >/dev/null 2>&1; then
    echo 'Review workspace Git repository is unavailable' >&2
    exit 1
  fi
else
mkdir -p "$workspace"
if [ "${IR_WORKSPACE_KIND:-coding}" = ai-coding ] && [ ! -e "$workspace/.ir-seeded" ]; then
  cp -a /opt/ir/template/. "$workspace/"
  # Content revisions are immutable; the learner's copied files are not.
  chmod -R u+w "$workspace"
  if [ -f "$workspace/package.json" ] && [ ! -e "$workspace/node_modules" ]; then
    ln -s /opt/ir/node_modules "$workspace/node_modules"
  fi
  : > "$workspace/.ir-seeded"
fi

if [ "${IR_WORKSPACE_KIND:-coding}" = coding ]; then
  # A freshly recreated bind-mounted gitfile may become visible just after the container starts.
  attempts=0
  until git -C "$workspace" rev-parse --git-dir >/dev/null 2>&1; do
    if [ -f /opt/ir/workspace-git/interview-runner-pending ] && [ "$(cat "$workspace/.git" 2>/dev/null || true)" = 'gitdir: /opt/ir/workspace-git' ]; then
      git --git-dir=/opt/ir/workspace-git --work-tree="$workspace" init -q
      rm /opt/ir/workspace-git/interview-runner-pending
      break
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then echo 'Coding workspace Git repository is unavailable' >&2; exit 1; fi
    sleep 0.1
  done
  rm -f /opt/ir/workspace-git/interview-runner-pending
elif ! git -C "$workspace" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$workspace" init -q
fi
node /opt/ir/tools/workspace-git.mjs exclude "$(git -C "$workspace" rev-parse --absolute-git-dir)"
printf '%s\n' "${IR_SANDBOX_ID:?IR_SANDBOX_ID is required}" > "$(git -C "$workspace" rev-parse --absolute-git-dir)/interview-runner-sandbox"
git -C "$workspace" config --local user.name 'Interview Runner'
git -C "$workspace" config --local user.email 'runner@localhost'
if ! git -C "$workspace" rev-parse --verify HEAD >/dev/null 2>&1; then
  node /opt/ir/tools/workspace-git.mjs stage "$workspace" "$(git -C "$workspace" rev-parse --absolute-git-dir)"
  git -C "$workspace" commit --allow-empty -qm 'Initial drill workspace'
fi
fi

exec code-server \
  --bind-addr 0.0.0.0:8080 --auth none --disable-telemetry \
  --disable-update-check --disable-workspace-trust --disable-getting-started-override --reconnection-grace-time 60 \
  --extensions-dir /opt/ir/extensions --user-data-dir "$user_data" \
  --abs-proxy-base-path "/sandbox/${IR_SANDBOX_ID:?IR_SANDBOX_ID is required}" \
  "$workspace"
