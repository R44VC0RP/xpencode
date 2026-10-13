#!/bin/sh
# Runs one visitor's OpenCode TUI inside a bubblewrap sandbox, as `octui`.
# Usage: tui.sh <workspace-id> <server-url>
#
# The sandbox sees a read-only /usr and /etc, a throwaway /tmp + HOME, and an
# EMPTY read-only directory at the visitor's workspace path. The real files
# live on the server side; the TUI only needs the path so it reports the right
# location, and must never import plugins or config the agent wrote there.
set -eu
id="$1"; server="$2"
case "$id" in *[!a-z0-9]*|"") echo "bad id" >&2; exit 2 ;; esac
case "$server" in http://127.0.0.1:4097/v/*) ;; *) echo "bad server" >&2; exit 2 ;; esac
ws="/srv/ws/$id"

exec /usr/bin/bwrap \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc/ssl /etc/ssl --ro-bind /etc/ca-certificates /etc/ca-certificates \
  --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group \
  --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind /etc/hosts /etc/hosts \
  --ro-bind /etc/localtime /etc/localtime \
  --proc /proc --dev /dev \
  --tmpfs /tmp --dir /tmp/home \
  --tmpfs /srv --dir "$ws" --remount-ro /srv \
  --chdir "$ws" \
  --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try \
  --die-with-parent \
  --clearenv \
  --setenv HOME /tmp/home \
  --setenv USER visitor \
  --setenv PATH /usr/local/bin:/usr/bin \
  --setenv TERM xterm-256color \
  --setenv COLORTERM truecolor \
  --setenv LANG C.UTF-8 \
  --setenv OPENCODE_DISABLE_AUTOUPDATE 1 \
  --setenv OPENCODE_CLI_CONFIG_CONTENT '{"highlights":false,"tabs":{"scope":"cwd"},"prompt":{"editor":false},"attention":{"sound":false,"notifications":false},"keybinds":{"terminal.suspend":"none","prompt.editor":"none","session.export":"none","terminal.toggle":"none","provider.connect":"none","server.pair":"none"}}' \
  -- /usr/local/bin/opencode --server "$server" "$ws"
