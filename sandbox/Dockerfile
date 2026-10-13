# Per-visitor sandbox image. Every tool call a visitor's agent makes (shell,
# read, write, edit, glob, grep) runs inside a container from this image,
# under gVisor, with no network. Built on the VM as xoc-sandbox:1.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep coreutils findutils diffutils grep sed gawk \
      tar gzip xz-utils unzip procps less file jq tree ncurses-term \
      python3 nodejs \
    && rm -rf /var/lib/apt/lists/*

# Unprivileged user; the workspace and HOME are tmpfs mounts at run time.
RUN useradd --uid 1000 --create-home --shell /bin/bash user \
    && git config --system init.defaultBranch main \
    && git config --system user.name "OpenCode" \
    && git config --system user.email "demo@opencode.ai" \
    && git config --system safe.directory '*'

USER 1000:1000
WORKDIR /home/user
CMD ["sleep", "infinity"]
