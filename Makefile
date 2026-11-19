# interview-runner self-host package.
#
#   make up        pull images, sync content, start the stack
#   make down      stop the stack (data stays)
#   make sync      update the content checkout and import it into content.db
#   make backup    consistent, timestamped copy of the user database
#   make upgrade   pull the package and its images, back up, restart
#   make validate  validate the content checkout
#
# The host needs only a container engine (Podman or Docker), git and make.
# config.json is the only configuration; it is parsed inside the runner image.
# Variables: CONFIG=<path>  RUNTIME=<dir>  ENGINE=podman|docker
#            SANDBOX=0 (runner only, no sandboxd / coding sandboxes)
#            FETCH=0 (sync/up import the existing checkout without contacting git)
#            BUILD=1 (build localhost/ images from this checkout instead of pulling)

SHELL := /bin/sh
.DEFAULT_GOAL := help

CONFIG ?= $(CURDIR)/config.json
# Generated, gitignored files: derived config, sandboxd token, sandbox allowlist.
RUNTIME ?= $(CURDIR)/.runtime
SANDBOX ?= 1
FETCH ?= 1
BUILD ?= 0

# One release number covers the runner image, the sandbox image and the schemas.
VERSION := $(strip $(shell cat VERSION))
# Published images; BUILD=1 builds localhost/ images from this checkout instead.
REGISTRY := $(if $(filter 1,$(BUILD)),localhost,ghcr.io/alankyshum)
IMAGE := $(REGISTRY)/interview-runner:$(VERSION)
SANDBOX_IMAGE := $(REGISTRY)/interview-runner-sandbox:$(VERSION)
PLATFORMS ?= linux/arm64,linux/amd64

# First engine whose daemon/machine answers.
ENGINE ?= $(shell for e in podman docker; do $$e info >/dev/null 2>&1 && { echo $$e; break; }; done)
ifeq ($(ENGINE),)
$(error No running container engine found: start Podman or Docker, or set ENGINE=)
endif

ifeq ($(ENGINE),podman)
ifeq ($(shell uname -s),Darwin)
ifeq ($(DOCKER_HOST)$(CONTAINER_HOST),)
# Podman derives its machine socket from TMPDIR, which the caller may have
# overridden; the Compose provider needs the real per-user one.
PODMAN_API := $(shell getconf DARWIN_USER_TEMP_DIR)podman/podman-machine-default-api.sock
ifneq ($(wildcard $(PODMAN_API)),)
export DOCKER_HOST := unix://$(PODMAN_API)
endif
endif
endif
# The API socket as seen where containers run (inside the VM on macOS), for
# sandboxd to mount. Not the host-side socket above.
ENGINE_SOCKET ?= $(patsubst unix://%,%,$(shell podman info --format '{{.Host.RemoteSocket.Path}}'))
else
ENGINE_SOCKET ?= /var/run/docker.sock
endif
# User the runner runs as; it must be able to write the directory holding the db.
RUN_USER ?= node

export IMAGE SANDBOX_IMAGE ENGINE_SOCKET RUN_USER RUNTIME

ENV_FILE := $(RUNTIME)/config.env
SECRET_FILE := $(RUNTIME)/secret.env
# config.env holds only validated, quote-free KEY=VALUE lines (see scripts/selfhost.ts).
LOAD := set -eu; . $(ENV_FILE)
TOOL := $(ENGINE) run --rm --network none
# Personal overrides (config.json's `private`), read by the content validators.
PRIVATE := -e RUNNER_PRIVATE_DIR=/app/private -v "$$PRIVATE_DIR":/app/private:ro
COMPOSE := $(ENGINE) compose -f $(CURDIR)/compose.yaml --env-file $(ENV_FILE)
PROFILE := $(if $(filter 0,$(SANDBOX)),,--profile sandbox)

.PHONY: help build pull images publish config fetch sync backup up down upgrade validate

help:
	@sed -n '3,8p' Makefile | sed 's/^# //'

build:
ifneq ($(BUILD),1)
	@echo "make build needs BUILD=1; without it the stack uses the published images (make pull)." >&2; exit 1
endif
	$(ENGINE) build -f Containerfile --target runner -t $(IMAGE) .
ifneq ($(SANDBOX),0)
	$(ENGINE) build -f Containerfile --target sandbox -t $(SANDBOX_IMAGE) .
endif

pull:
ifeq ($(BUILD),1)
	@echo "BUILD=1 uses local images; nothing to pull." >&2; exit 1
endif
	$(ENGINE) pull $(IMAGE)
ifneq ($(SANDBOX),0)
	$(ENGINE) pull $(SANDBOX_IMAGE)
endif

# Images for this VERSION: built with BUILD=1, otherwise pulled when absent.
images:
ifeq ($(BUILD),1)
	$(MAKE) build
else
	@$(ENGINE) image inspect $(IMAGE) >/dev/null 2>&1 || $(ENGINE) pull $(IMAGE)
ifneq ($(SANDBOX),0)
	@$(ENGINE) image inspect $(SANDBOX_IMAGE) >/dev/null 2>&1 || $(ENGINE) pull $(SANDBOX_IMAGE)
endif
endif

# Maintainers (Podman): build both images for PLATFORMS and push them as
# manifest lists tagged VERSION and latest. A new GHCR package starts private
# until its visibility is changed on GitHub.
publish:
ifeq ($(BUILD),1)
	@echo "make publish pushes to the registry; run it without BUILD=1." >&2; exit 1
endif
	podman build --platform $(PLATFORMS) -f Containerfile --target runner --manifest $(IMAGE) .
	podman build --platform $(PLATFORMS) -f Containerfile --target sandbox --manifest $(SANDBOX_IMAGE) .
	for image in $(IMAGE) $(SANDBOX_IMAGE); do \
	  podman manifest push --all $$image docker://$$image && \
	  podman manifest push --all $$image docker://$${image%:*}:latest || exit 1; \
	done

# Parse and validate config.json with the CLI in the runner image.
config:
	@test -f $(CONFIG) || { echo "Missing $(CONFIG): copy config.example.json to config.json and edit it." >&2; exit 1; }
	@$(ENGINE) image inspect $(IMAGE) >/dev/null 2>&1 || $(MAKE) images SANDBOX=0
	@mkdir -p $(RUNTIME)
	@$(TOOL) -e CONFIG_DIR=$(abspath $(dir $(CONFIG))) -v $(CONFIG):/config.json:ro $(IMAGE) node server-dist/selfhost.mjs env /config.json > $(ENV_FILE).tmp || { rm -f $(ENV_FILE).tmp; exit 1; }
	@mv $(ENV_FILE).tmp $(ENV_FILE)

# Git mode: clone or update the checkout with the host's own git credentials.
fetch: config
	@$(LOAD); mkdir -p "$$DB_DIR"; \
	if [ "$$CONTENT_MODE" = git ]; then \
	  [ -d "$$CONTENT_DIR/.git" ] || git clone --no-checkout "$$CONTENT_GIT" "$$CONTENT_DIR"; \
	  git -C "$$CONTENT_DIR" fetch --quiet origin "$$CONTENT_REF"; \
	  git -C "$$CONTENT_DIR" checkout --quiet --detach FETCH_HEAD; \
	  echo "Content at $$(git -C "$$CONTENT_DIR" rev-parse --short HEAD) ($$CONTENT_REF)"; \
	fi

# Fetch (unless FETCH=0), then import the checkout into content.db. Unchanged
# courses keep their revision; changed ones get a new revision; courses
# missing from the checkout are kept. A checkout without courses/ imports
# nothing: the Library starts empty.
sync: config $(if $(filter 0,$(FETCH)),,fetch)
	@$(LOAD); mkdir -p "$$DB_DIR" "$$PRIVATE_DIR"; \
	[ -d "$$CONTENT_DIR" ] || { echo "No content directory at $$CONTENT_DIR$(if $(filter 0,$(FETCH)), (FETCH=0: run make fetch first),)" >&2; exit 1; }; \
	$(TOOL) --user $(RUN_USER) -e OWNER="$$OWNER" $(PRIVATE) -v "$$CONTENT_DIR":/content:ro -v "$$DB_DIR":/data $(IMAGE) sh -euc ' \
	  if [ -d /content/courses ]; then node server-dist/content-import.mjs /content --namespace "$$OWNER" --db /data/content.db; \
	  else echo "No courses/ directory in the content checkout: nothing to import at its root."; fi; \
	  for dir in /content/namespaces/*/; do \
	    [ -d "$$dir/courses" ] || continue; \
	    node server-dist/content-import.mjs "$${dir%/}" --namespace "$$(basename "$$dir")" --db /data/content.db; \
	  done'

# The single user database (progress, workspaces, UI state); content.db is a
# rebuildable cache and is excluded.
backup: config
	@$(LOAD); mkdir -p "$$BACKUP_DIR"; \
	[ -f "$$DB_DIR/$$DB_FILE" ] || { echo "No user database at $$DB_DIR/$$DB_FILE yet; nothing to back up."; exit 0; }; \
	$(TOOL) --user $(RUN_USER) -v "$$DB_DIR":/data $(IMAGE) node server-dist/selfhost.mjs backup "/data/$$DB_FILE" "/data/backups/$$DB_FILE.$$(date -u +%Y%m%dT%H%M%SZ)"

up: images sync
	@$(LOAD); mkdir -p "$$PRIVATE_DIR" "$$STATE_DIR/ui-state" "$$STATE_DIR/managed/workspaces" "$$STATE_DIR/managed/materialized" "$$STATE_DIR/sandbox-settings"; \
	umask 077; \
	$(TOOL) $(IMAGE) node server-dist/selfhost.mjs token > $(SECRET_FILE); \
	chmod 600 $(SECRET_FILE); \
	$(TOOL) $(IMAGE) node server-dist/selfhost.mjs allowlist "$$STATE_DIR/managed" > $(RUNTIME)/sandbox-allowlist.json; \
	$(COMPOSE) --env-file $(SECRET_FILE) $(PROFILE) up -d --wait --remove-orphans; \
	echo "$$STACK is up on http://127.0.0.1:$$PORT"

down: config
	@SANDBOXD_TOKEN=unused $(COMPOSE) --profile sandbox down

# Migrations run in the app at startup, so the backup comes first.
upgrade:
	git pull --ff-only
	$(MAKE) images
	$(MAKE) backup
	$(MAKE) up

# Runs the ir CLI from the image on the checkout root and on every
# namespaces/<name>/ directory; reports all of them before failing.
validate: config
	@$(LOAD); mkdir -p "$$PRIVATE_DIR"; $(TOOL) $(PRIVATE) -v "$$CONTENT_DIR":/content:ro $(IMAGE) sh -uc ' \
	  status=0; \
	  for dir in /content /content/namespaces/*/; do \
	    [ -d "$$dir/courses" ] || continue; \
	    echo "== $${dir%/}"; \
	    node server-dist/ir.mjs course validate "$${dir%/}" || status=1; \
	  done; \
	  exit $$status'
