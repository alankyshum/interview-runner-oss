FROM docker.io/library/node:24-bookworm-slim AS node-runtime

FROM node-runtime AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# Vite loads the server's link registry even for builds. Supply an empty,
# build-only registry bound to this checkout; no course repositories are needed.
RUN mkdir -p /tmp/ir-client-build/interview-runner \
    && node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('interview-runner.json'));fs.writeFileSync('/tmp/ir-client-build/interview-runner/links.json',JSON.stringify({version:1,runners:{[m.repo]:{path:'/app',supportedCourseSchema:m.courseSchema}},courses:{}}))" \
    && XDG_STATE_HOME=/tmp/ir-client-build INTERVIEW_RUNNER_CONTENT_SOURCE=db VITEST=1 npm run build:client \
    && npm run build:server \
    && rm -rf /tmp/ir-client-build

# Base images are pinned by multi-arch index digest (uv 0.9.5, code-server 4.143.1),
# so each target platform resolves its own image.
FROM ghcr.io/astral-sh/uv@sha256:f459f6f73a8c4ef5d69f4e6fbbdb8af751d6fa40ec34b39a1ab469acd6e289b7 AS uv

FROM node-runtime AS python-tools
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/opt/bin PATH=/opt/bin:$PATH
RUN mkdir -p /opt/bin && uv python install --no-bin 3.12.12 \
    && ln -s "$(uv python find 3.12.12)" /opt/bin/python3 \
    && uv tool install --python 3.12.12 pytest==9.0.1

FROM node-runtime AS runner
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --from=python-tools /opt/python /opt/python
COPY --from=python-tools /opt/uv-tools /opt/uv-tools
COPY --from=python-tools /opt/bin /usr/local/bin
RUN mkdir /data && chown node:node /data && ln -s /data/progress.db /app/progress.db
# Default link registry for DB-mode content (no linked course repositories);
# file-mode deployments bind-mount their own over it.
RUN mkdir -p /app/state/interview-runner/managed \
    && node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync('/app/interview-runner.json'));fs.writeFileSync('/app/state/interview-runner/links.json',JSON.stringify({version:1,runners:{[m.repo]:{path:'/app',supportedCourseSchema:m.courseSchema}},courses:{}}))" \
    && chown -R node:node /app/state
ENV NODE_ENV=production
# Course repositories and the generated link state are bind-mounted at runtime.
ENV XDG_STATE_HOME=/app/state
USER node
EXPOSE 3000
# The image already contains the client bundle; startup only runs the server.
CMD ["node", "server-dist/start.mjs"]

# Target platform: npm installs per-architecture binaries (esbuild, rollup, tsgo).
FROM node-runtime AS sandbox-deps
WORKDIR /opt/ir
COPY sandbox/package.json sandbox/package-lock.json ./
RUN npm ci --ignore-scripts

FROM docker.io/codercom/code-server@sha256:377b66bec5645510ed52549bb00e648c273edc604d230a3f90fd2b2433afcb97 AS extensions
ARG TARGETARCH
USER root
RUN mkdir -p /opt/ir/extensions && chown -R coder:coder /opt/ir
USER coder
RUN code-server --extensions-dir /opt/ir/extensions --install-extension ms-python.python@2026.4.0 \
    && code-server --extensions-dir /opt/ir/extensions --install-extension detachhead.basedpyright@1.40.2 \
    && code-server --extensions-dir /opt/ir/extensions --install-extension charliermarsh.ruff@2026.90.0 \
    && code-server --extensions-dir /opt/ir/extensions --install-extension ms-vscode.atom-keybindings@3.3.0 \
    && code-server --extensions-dir /opt/ir/extensions --install-extension esbenp.prettier-vscode@12.4.0 \
    && code-server --extensions-dir /opt/ir/extensions --uninstall-extension ms-python.debugpy \
    && code-server --extensions-dir /opt/ir/extensions --uninstall-extension ms-python.vscode-python-envs \
    && rm -rf /opt/ir/extensions/ms-python.debugpy-* /opt/ir/extensions/ms-python.vscode-python-envs-* /opt/ir/extensions/.obsolete
RUN case "$TARGETARCH" in \
      arm64) platform=linux-arm64; sha256=f09f90d0ad861f320682b4ea4ca3ea507866e2837aface4beec63823a5d61b09 ;; \
      amd64) platform=linux-x64; sha256=d91b7c182e16c272e46c52d07b3ea8b1ef146ac5cc2a56ee0dcc00bd55586780 ;; \
      *) echo "Unsupported TypeScript native-preview architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --compressed "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/TypeScriptTeam/vsextensions/native-preview/1.0.1/vspackage?targetPlatform=$platform" -o /tmp/ts7.vsix \
    && echo "$sha256  /tmp/ts7.vsix" | sha256sum -c - \
    && code-server --extensions-dir /opt/ir/extensions --install-extension /tmp/ts7.vsix \
    && rm /tmp/ts7.vsix

FROM docker.io/codercom/code-server@sha256:377b66bec5645510ed52549bb00e648c273edc604d230a3f90fd2b2433afcb97 AS sandbox
LABEL io.interview-runner.sandbox="1"
USER root
# The probe makes code-server write a root config with a generated password; drop it.
RUN code-server --help | grep -q -- '--reconnection-grace-time' \
    && rm -rf /root/.config /root/.local
COPY --from=node-runtime /usr/local /usr/local
COPY --from=python-tools /opt/python /opt/python
COPY --from=python-tools /opt/uv-tools /opt/uv-tools
COPY --from=python-tools /opt/bin /opt/bin
COPY --from=sandbox-deps /opt/ir/node_modules /opt/ir/node_modules
COPY --from=extensions /opt/ir/extensions /opt/ir/extensions
COPY sandbox/extensions/ir-diff-to-side /opt/ir/extensions/interview-runner.interview-runner-diff-to-side-1.0.0
RUN node -e "const fs=require('fs'),file='/opt/ir/extensions/extensions.json',value=JSON.parse(fs.readFileSync(file));value.push({identifier:{id:'interview-runner.interview-runner-diff-to-side'},version:'1.0.0',location:{'\u0024mid':1,path:'/opt/ir/extensions/interview-runner.interview-runner-diff-to-side-1.0.0',scheme:'file'},relativeLocation:'interview-runner.interview-runner-diff-to-side-1.0.0',metadata:{installedTimestamp:0,pinned:true,source:'resource',targetPlatform:'universal',updated:false,private:true,isPreReleaseVersion:false,hasPreReleaseVersion:false}});fs.writeFileSync(file,JSON.stringify(value))"
COPY sandbox/run-tests.mjs sandbox/test-timeout.mjs sandbox/capture-run.mjs sandbox/workspace-files.mjs sandbox/workspace-git.mjs sandbox/settings.mjs sandbox/consoleReporter.ts sandbox/pytest_report.py sandbox/pytest_capture.py sandbox/vitest.drills.config.mts sandbox/setupTests.ts /opt/ir/tools/
COPY sandbox/settings.json /opt/ir/settings.json
COPY sandbox/keybindings.json /opt/ir/keybindings.json
COPY sandbox/tsconfig.json /opt/ir/tools/tsconfig.json
COPY sandbox/tsconfig.json /workspace/tsconfig.json
COPY sandbox/entrypoint.sh /opt/ir/entrypoint.sh
RUN chmod 0555 /opt/ir/entrypoint.sh \
    && mkdir -p /workspace /home/coder/.ir /opt/ir/template /opt/ir/acceptance \
    && ln -s /opt/ir/node_modules /workspace/node_modules \
    && chown -R coder:coder /workspace /home/coder
ENV PATH=/opt/bin:/opt/uv-tools/pytest/bin:/usr/local/bin:$PATH
USER coder
ENTRYPOINT ["/opt/ir/entrypoint.sh"]
